/**
 * SSE 推送：首事件带 id、断线按 Last-Event-ID 补发、关闭会话结束流。
 *
 * 服务端每秒查一次数据库，所以测试要按"事件到达"等待，而不是等固定时间。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startHarness,
  register,
  nextOperationId,
  TASK_INPUT,
  type Harness,
} from './helpers/harness.ts';
import type { MailEnvelope, MailSession } from '../src/protocol/types.ts';
import type { CollabClient } from '../src/sdk/client.ts';

type SseEvent = { id: string | null; event: string; data: string };

type Stream = {
  events: SseEvent[];
  next(predicate?: (event: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  done: Promise<void>;
  abort(): void;
};

function parseChunk(chunk: string): SseEvent | null {
  const event: SseEvent = { id: null, event: 'message', data: '' };
  const data: string[] = [];
  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const index = line.indexOf(':');
    const field = index < 0 ? line : line.slice(0, index);
    const value = index < 0 ? '' : line.slice(index + 1).replace(/^ /, '');
    if (field === 'id') event.id = value;
    else if (field === 'event') event.event = value;
    else if (field === 'data') data.push(value);
  }
  if (event.id === null && event.event === 'message' && data.length === 0) return null;
  event.data = data.join('\n');
  return event;
}

function openStream(response: Response): Stream {
  assert.ok(response.body, 'SSE 响应没有 body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: SseEvent[] = [];
  const waiters: { predicate: (event: SseEvent) => boolean; resolve: (event: SseEvent) => void }[] = [];
  let doneResolve!: () => void;
  const done = new Promise<void>(resolve => {
    doneResolve = resolve;
  });

  const push = (event: SseEvent) => {
    events.push(event);
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i]!;
      if (waiter.predicate(event)) {
        waiters.splice(i, 1);
        waiter.resolve(event);
        return;
      }
    }
  };

  void (async () => {
    try {
      for (;;) {
        const { done: complete, value } = await reader.read();
        if (complete) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = parseChunk(chunk);
          if (event) push(event);
          index = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // 主动 abort 会中断读取。
    } finally {
      for (const waiter of waiters.splice(0)) waiter.resolve({ id: null, event: 'end', data: '' });
      doneResolve();
    }
  })();

  return {
    events,
    next(predicate = () => true, timeoutMs = 5000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<SseEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`等待 SSE 事件超时（已有 ${events.length} 条）`));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: event => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
    done,
    abort() {
      void reader.cancel().catch(() => {});
    },
  };
}

async function connect(
  harness: Harness,
  token: string,
  sessionId: string,
  lastEventId?: string,
): Promise<Stream> {
  const response = await fetch(
    `${harness.url}/v1/mail/sessions/${encodeURIComponent(sessionId)}/events`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
      },
    },
  );
  assert.equal(response.status, 200, `SSE 连接失败: HTTP ${response.status}`);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  return openStream(response);
}

const openSession = (client: CollabClient) =>
  client.request<MailSession>('mail/sessions', {
    body: {},
    operationId: nextOperationId('session'),
  });

/** 注册一个智能体并拿到它的令牌（harness.token 每次都随机，必须原样保存）。 */
async function registerAgent(
  harness: Harness,
  id: string,
): Promise<{ token: string; client: CollabClient }> {
  const token = harness.token(id);
  await harness.admin.registerPrincipal({ id, roles: ['agent'], token, displayName: id }, `register:${id}`);
  return { token, client: harness.client(token) };
}

const publish = (harness: Harness, recipient: string, summary: string) =>
  harness.admin.request<{ id: string }>('mail/publish', {
    body: {
      topic: `ws:acme:principal:${recipient}`,
      kind: 'task.assigned',
      priority: 'next',
      summary,
      refType: 'manual',
      refId: summary,
      audience: { principals: [recipient] },
    },
    operationId: nextOperationId('publish'),
  });

test('SSE：推送信封，事件带 id；关闭会话后流结束', async () => {
  const harness = await startHarness();
  const agent = await registerAgent(harness, 'streamer');
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const created = await owner.createTask(TASK_INPUT, 'create-stream');
    await owner.assign(created.id, { agent: 'streamer', kind: 'inventory' }, 'assign-stream');

    const session = await openSession(agent.client);
    const stream = await connect(harness, agent.token, session.id);
    const mail = await stream.next(event => event.event === 'mail');
    const envelope = JSON.parse(mail.data) as MailEnvelope;
    assert.equal(mail.id, String(envelope.seq));
    assert.equal(envelope.kind, 'task.assigned');
    assert.equal(envelope.ref.taskId, created.id);

    await agent.client.request(`mail/sessions/${encodeURIComponent(session.id)}/close`, {
      body: {},
      operationId: nextOperationId('close-stream'),
    });
    const closed = await stream.next(event => event.event === 'closed');
    assert.equal(closed.data, '{}');
    await stream.done;
  } finally {
    await harness.close();
  }
});

test('SSE：断线后用 Last-Event-ID 只补发缺失事件', async () => {
  const harness = await startHarness();
  const agent = await registerAgent(harness, 'replayer');
  try {
    const session = await openSession(agent.client);

    const first = await publish(harness, 'replayer', '第一条');
    const stream = await connect(harness, agent.token, session.id);
    const firstEvent = await stream.next(event => event.event === 'mail');
    assert.equal(JSON.parse(firstEvent.data).id, first.id);
    stream.abort();
    await stream.done;

    const second = await publish(harness, 'replayer', '第二条');
    const resumed = await connect(harness, agent.token, session.id, firstEvent.id ?? undefined);
    const secondEvent = await resumed.next(event => event.event === 'mail');
    const envelope = JSON.parse(secondEvent.data) as MailEnvelope;
    assert.equal(envelope.id, second.id);
    assert.equal(resumed.events.filter(event => event.event === 'mail').length, 1);
    resumed.abort();
    await resumed.done;
  } finally {
    await harness.close();
  }
});

test('SSE：进程关闭时 closeStreams 结束所有长连接', async () => {
  const harness = await startHarness();
  const agent = await registerAgent(harness, 'sleeper');
  try {
    const session = await openSession(agent.client);
    const stream = await connect(harness, agent.token, session.id);
    // 没有新消息时流保持打开。
    assert.equal(stream.events.filter(event => event.event === 'mail').length, 0);

    harness.app.mailbox.closeStreams();
    await Promise.race([
      stream.done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('closeStreams 没有结束流')), 3000)),
    ]);
  } finally {
    await harness.close();
  }
});

test('SSE：未注册的会话返回 404', async () => {
  const harness = await startHarness();
  const agent = await registerAgent(harness, 'nobody');
  try {
    const missing = await fetch(`${harness.url}/v1/mail/sessions/missing/events`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});
