/**
 * 信箱：会话、信封、正文回源与投递语义。
 *
 * 重点不在"能发信"，而在三条不变式：
 *  1. 信封不含正文，正文永远按当前权限重新判定；
 *  2. 同一主体的不同会话互不影响；
 *  3. 消息与业务写同事务，回滚时两者都不存在。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startHarness,
  register,
  expectStatus,
  nextOperationId,
  TASK_INPUT,
  type Harness,
} from './helpers/harness.ts';
import type {
  MailEnvelope,
  MailMessage,
  MailSession,
} from '../src/protocol/types.ts';
import type { CollabClient } from '../src/sdk/client.ts';

type PullResult = { items: MailEnvelope[]; cursor: number; session: MailSession };

const openSession = (client: CollabClient, body: Record<string, unknown> = {}) =>
  client.request<MailSession>('mail/sessions', { body, operationId: nextOperationId('session') });

const pull = (client: CollabClient, sessionId: string, extra = '') =>
  client.request<PullResult>(
    `mail/sessions/${encodeURIComponent(sessionId)}/messages${extra ? `?${extra}` : ''}`,
  );

const ack = (client: CollabClient, messageId: string, deliveryId: string) =>
  client.request<{ id: string; state: string; duplicate: boolean }>(
    `mail/messages/${encodeURIComponent(messageId)}/ack`,
    { body: { deliveryId }, operationId: nextOperationId('ack') },
  );

async function count(db: Harness['db'], sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await db.read.one<{ total: number }>(sql, params);
  return Number(row?.total ?? 0);
}

test('信箱：受派后收到信封，正文单独取，ack 幂等', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create-mail');
    const sub = (await owner.assign(created.id, { agent: 'agent1', kind: 'inventory' }, 'assign-mail')) as {
      id: string;
    };

    const session = await openSession(agent);
    assert.equal(session.unread, 1);
    assert.equal(session.cursorSeq, 0);

    const first = await pull(agent, session.id);
    assert.equal(first.items.length, 1);
    const envelope = first.items[0]!;
    assert.equal(envelope.kind, 'task.assigned');
    assert.equal(envelope.priority, 'next');
    assert.deepEqual(envelope.ref, { type: 'subtask', id: sub.id, taskId: created.id, threadId: null });
    // 信封不得携带正文。
    assert.equal('content' in (envelope as unknown as Record<string, unknown>), false);
    assert.ok(envelope.summary.length > 0 && envelope.summary.length <= 200);
    assert.ok(first.cursor >= envelope.seq);

    const body = await agent.request<MailMessage>(`mail/messages/${encodeURIComponent(envelope.id)}`);
    const content = body.content as { task: { id: string }; subtask: { id: string; status: string } };
    assert.equal(content.task.id, created.id);
    assert.equal(content.subtask.id, sub.id);
    assert.equal(content.subtask.status, 'invited');

    const firstAck = await ack(agent, envelope.id, envelope.deliveryId);
    assert.equal(firstAck.duplicate, false);
    const again = await ack(agent, envelope.id, envelope.deliveryId);
    assert.equal(again.duplicate, true);

    const after = await agent.request<MailSession>(`mail/sessions/${encodeURIComponent(session.id)}`);
    assert.equal(after.unread, 0);
    // ack 之后不再重复投递。
    const drained = await pull(agent, session.id);
    assert.deepEqual(drained.items, []);
  } finally {
    await harness.close();
  }
});

test('信箱：两个会话的游标互不影响', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create-two');
    // 两个会话都在发布前注册，消息会扇出到两边。
    const phone = await openSession(agent, { label: 'phone' });
    const laptop = await openSession(agent, { label: 'laptop' });

    await owner.assign(created.id, { agent: 'agent1', kind: 'inventory' }, 'assign-two');

    const phonePull = await pull(agent, phone.id);
    const laptopPull = await pull(agent, laptop.id);
    assert.equal(phonePull.items.length, 1);
    assert.equal(laptopPull.items.length, 1);
    assert.equal(phonePull.items[0]!.id, laptopPull.items[0]!.id);
    assert.notEqual(phonePull.items[0]!.deliveryId, laptopPull.items[0]!.deliveryId);

    // 一个会话确认了，另一个仍然是未读。
    await ack(agent, phonePull.items[0]!.id, phonePull.items[0]!.deliveryId);
    assert.deepEqual((await pull(agent, phone.id)).items, []);
    const laptopSession = await agent.request<MailSession>(`mail/sessions/${encodeURIComponent(laptop.id)}`);
    assert.equal(laptopSession.unread, 1);
    await ack(agent, laptopPull.items[0]!.id, laptopPull.items[0]!.deliveryId);
    const laptopAfter = await agent.request<MailSession>(`mail/sessions/${encodeURIComponent(laptop.id)}`);
    assert.equal(laptopAfter.unread, 0);
  } finally {
    await harness.close();
  }
});

test('信箱：正文按当前权限回源，越权与不存在同样 404', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent']);
    const outsider = await register(harness, 'outsider', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create-auth');

    // 直接把任务消息发给无关主体：有投递，但正文重新鉴权会失败。
    const published = await harness.admin.request<{ id: string }>('mail/publish', {
      body: {
        topic: 'ws:acme:principal:outsider',
        kind: 'task.assigned',
        priority: 'next',
        summary: '看看这个任务',
        refType: 'task',
        refId: created.id,
        taskId: created.id,
        audience: { principals: ['outsider'] },
      },
      operationId: nextOperationId('publish'),
    });

    const outsiderSession = await openSession(outsider);
    const pulled = await pull(outsider, outsiderSession.id);
    assert.equal(pulled.items[0]!.id, published.id);
    await expectStatus(
      outsider.request(`mail/messages/${encodeURIComponent(published.id)}`),
      404,
    );

    // 没有投递的第三方连消息 id 都查不到。
    await expectStatus(
      agent.request(`mail/messages/${encodeURIComponent(published.id)}`),
      404,
    );
  } finally {
    await harness.close();
  }
});

test('信箱：积压队列只被一个会话领取', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create-queue');
    await owner.assign(created.id, { agent: 'agent1', kind: 'inventory' }, 'assign-queue');

    // 发布时没有会话：落到 queue，注册的第一个会话认领。
    const first = await openSession(agent, { label: 'first' });
    const firstPull = await pull(agent, first.id);
    assert.equal(firstPull.items.length, 1);

    const second = await openSession(agent, { label: 'second' });
    assert.equal(second.unread, 0);
    assert.deepEqual((await pull(agent, second.id)).items, []);
  } finally {
    await harness.close();
  }
});

test('信箱：投递与业务写同事务，回滚时通知与消息都不存在', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    await register(harness, 'agent1', ['agent']);
    await register(harness, 'agent2', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create-tx');
    const sub = (await owner.assign(created.id, { agent: 'agent1', kind: 'inventory' }, 'assign-tx')) as {
      id: string;
    };
    // assign 本身已写入一条通知与消息，基线用于比较。
    const baselineNotifications = await count(
      harness.db,
      'SELECT COUNT(*) AS total FROM notifications WHERE task_id = :task',
      { task: created.id },
    );
    const baselineMessages = await count(
      harness.db,
      'SELECT COUNT(*) AS total FROM mailbox_messages WHERE ref_id = :ref',
      { ref: sub.id },
    );

    const { ctx, notifications } = harness.app;
    await assert.rejects(
      ctx.db.transaction(async tx => {
        await notifications.deliver(tx, {
          workspace: 'acme',
          recipientId: 'agent2',
          taskId: created.id,
          subtaskId: sub.id,
          type: 'invited',
        });
        throw new Error('业务失败');
      }),
    );
    assert.equal(
      await count(harness.db, 'SELECT COUNT(*) AS total FROM notifications WHERE task_id = :task', {
        task: created.id,
      }),
      baselineNotifications,
    );
    assert.equal(
      await count(harness.db, 'SELECT COUNT(*) AS total FROM mailbox_messages WHERE ref_id = :ref', {
        ref: sub.id,
      }),
      baselineMessages,
    );

    await ctx.db.transaction(tx =>
      notifications.deliver(tx, {
        workspace: 'acme',
        recipientId: 'agent2',
        taskId: created.id,
        subtaskId: sub.id,
        type: 'invited',
      }),
    );
    assert.equal(
      await count(harness.db, 'SELECT COUNT(*) AS total FROM notifications WHERE task_id = :task', {
        task: created.id,
      }),
      baselineNotifications + 1,
    );
    assert.equal(
      await count(harness.db, 'SELECT COUNT(*) AS total FROM mailbox_messages WHERE ref_id = :ref', {
        ref: sub.id,
      }),
      baselineMessages + 1,
    );
  } finally {
    await harness.close();
  }
});

test('信箱：未参与任务的智能体不会收到消息', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    await register(harness, 'agent1', ['agent']);
    const outsider = await register(harness, 'agent2', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create-nobody');
    await owner.assign(created.id, { agent: 'agent1', kind: 'inventory' }, 'assign-nobody');

    await harness.admin.request('mail/publish', {
      body: {
        topic: `ws:acme:task:${created.id}`,
        kind: 'task.review_needed',
        summary: '请复核',
        refType: 'task',
        refId: created.id,
        taskId: created.id,
        audience: { taskId: created.id },
      },
      operationId: nextOperationId('publish-task'),
    });

    const session = await openSession(outsider);
    assert.equal(session.unread, 0);
    assert.deepEqual((await pull(outsider, session.id)).items, []);
  } finally {
    await harness.close();
  }
});

test('信箱：能力受众只投给声明了能力的智能体', async () => {
  const harness = await startHarness();
  try {
    const inventory = await register(harness, 'inv-agent', ['agent'], { capabilities: ['inventory'] });
    await register(harness, 'other-agent', ['agent'], { capabilities: ['legal'] });

    const published = await harness.admin.request<{ recipients: number }>('mail/publish', {
      body: {
        topic: 'ws:acme:capability:inventory',
        kind: 'task.assigned',
        summary: '清点库存',
        refType: 'manual',
        refId: 'manual-1',
        audience: { capability: 'inventory' },
      },
      operationId: nextOperationId('publish-cap'),
    });
    assert.equal(published.recipients, 1);

    const session = await openSession(inventory);
    const pulled = await pull(inventory, session.id);
    assert.equal(pulled.items.length, 1);
    assert.equal(pulled.items[0]!.kind, 'task.assigned');

    const otherNotifications = await count(
      harness.db,
      `SELECT COUNT(*) AS total FROM mailbox_deliveries WHERE principal_id = 'other-agent'`,
    );
    assert.equal(otherNotifications, 0);
  } finally {
    await harness.close();
  }
});

test('信箱：nack 退避，超过上限标记 dead 并通知负责人', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create-nack');
    await owner.assign(created.id, { agent: 'agent1', kind: 'inventory' }, 'assign-nack');

    const session = await openSession(agent);
    const pulled = await pull(agent, session.id);
    const envelope = pulled.items[0]!;

    let last: { state: string; attempts: number } | null = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      last = await agent.request<{ state: string; attempts: number }>(
        `mail/messages/${encodeURIComponent(envelope.id)}/nack`,
        {
          body: { deliveryId: envelope.deliveryId, retryAfterSeconds: 30, reason: '处理失败' },
          operationId: nextOperationId(`nack-${attempt}`),
        },
      );
      assert.equal(last.attempts, attempt);
    }
    assert.equal(last!.state, 'dead');

    const dead = await count(
      harness.db,
      `SELECT COUNT(*) AS total FROM mailbox_messages
       WHERE kind = 'mailbox.dead' AND task_id = :task`,
      { task: created.id },
    );
    assert.equal(dead, 1);

    // 负责人没有会话时，这条提醒落在 queue 投递里。
    const queued = await count(
      harness.db,
      `SELECT COUNT(*) AS total FROM mailbox_deliveries
       WHERE owner_key = :owner AND state = 'pending'`,
      { owner: 'queue:owner1' },
    );
    assert.equal(queued, 1);
  } finally {
    await harness.close();
  }
});

test('信箱：关闭会话后不能再拉取，未确认投递退回主体队列', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create-close');
    await owner.assign(created.id, { agent: 'agent1', kind: 'inventory' }, 'assign-close');

    const session = await openSession(agent);
    await agent.request(`mail/sessions/${encodeURIComponent(session.id)}/close`, {
      body: {},
      operationId: nextOperationId('close'),
    });
    await expectStatus(pull(agent, session.id), 409);

    // 关会话不等于消息作废：投递回到主体队列，下个会话还能领到。
    const delivery = await harness.db.read.one<{ session_id: string | null; state: string; owner_key: string }>(
      `SELECT session_id, state, owner_key FROM mailbox_deliveries WHERE session_id IS NULL AND principal_id = 'agent1'`,
    );
    assert.equal(delivery?.state, 'pending');
    assert.equal(delivery?.owner_key, 'queue:agent1');

    const reopened = await openSession(agent);
    const page = await pull(agent, reopened.id);
    assert.equal(page.items.length, 1);
  } finally {
    await harness.close();
  }
});

test('信箱：订阅主题必须属于自己或可读任务', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent'], { capabilities: ['inventory'] });
    const created = await owner.createTask(TASK_INPUT, 'create-sub');
    // 受派之后的智能体才能订阅任务主题。
    await owner.assign(created.id, { agent: 'agent1', kind: 'inventory' }, 'assign-sub');

    await expectStatus(
      agent.request('mail/sessions', {
        body: { subscriptions: [{ topic: 'ws:acme:principal:admin' }] },
        operationId: nextOperationId('sub-bad'),
      }),
      403,
    );
    await expectStatus(
      agent.request('mail/sessions', {
        body: { subscriptions: [{ topic: 'ws:acme:task:missing-task' }] },
        operationId: nextOperationId('sub-missing'),
      }),
      404,
    );

    const session = await openSession(agent, {
      subscriptions: [
        { topic: `ws:acme:task:${created.id}` },
        { topic: 'ws:acme:capability:inventory' },
      ],
    });
    const subscriptions = await agent.request<{ topicPattern: string }[]>(
      `mail/sessions/${encodeURIComponent(session.id)}/subscriptions`,
    );
    assert.deepEqual(
      subscriptions.map(item => item.topicPattern).sort(),
      [`ws:acme:task:${created.id}`, 'ws:acme:capability:inventory'].sort(),
    );
  } finally {
    await harness.close();
  }
});
