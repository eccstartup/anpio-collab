/**
 * 内嵌智能体控制面：定义、派生身份、运行记录与回收。
 *
 * 执行引擎（supervisor / session / 沙箱）已经拆到 anpio-agents；
 * 这里只验证平台自己负责的部分，不启动任何运行时子进程。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_INPUT,
  nextOperationId,
  register,
  startHarness,
  type Harness,
} from './helpers/harness.ts';
import type { CollabClient } from '../src/sdk/client.ts';
import { deriveEmbeddedToken } from '../src/platform/embedded/token.ts';
import { normalizeDefinition } from '../src/platform/embedded/definition.ts';

const SECRET = 'embedded-test-secret-0123456789abcdef';

type AgentView = { id: string; name: string; unread: number; running: number; enabled: boolean };
type RunView = { id: string; status: string; error: string | null };

async function withSecret<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.COLLAB_EMBEDDED_SECRET;
  process.env.COLLAB_EMBEDDED_SECRET = SECRET;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.COLLAB_EMBEDDED_SECRET;
    else process.env.COLLAB_EMBEDDED_SECRET = previous;
  }
}

function scriptDefinition(name: string): Record<string, unknown> {
  return {
    name,
    description: '控制面测试用：只建定义，不执行',
    capabilities: ['inventory'],
    provider: {
      id: 'script',
      protocol: 'script',
      model: 'script',
      script: [{ tool: 'finish', input: { summary: '不会被执行' } }],
    },
    tools: ['task_accept', 'task_submit'],
    limits: { maxTurns: 2, timeoutMs: 10_000, maxTokens: 512 },
  };
}

async function createAgent(admin: CollabClient, definition: Record<string, unknown>): Promise<AgentView> {
  return admin.request<AgentView>('embedded/agents', {
    body: definition,
    operationId: nextOperationId('agent-create'),
  });
}

test('内嵌定义：默认工具与自动补齐的授权范围和外部智能体一致', () => {
  const base = {
    name: '能力对齐',
    provider: { id: 'script', protocol: 'script', model: 'script' },
  };

  const defaults = normalizeDefinition(base);
  for (const tool of ['subtask_inbox', 'subtask_reject', 'task_comments', 'offer_list', 'task_files', 'file_download']) {
    assert.ok(defaults.tools.includes(tool as never), `默认工具缺少 ${tool}`);
  }
  for (const tool of ['offer_claim', 'file_upload']) {
    assert.equal(defaults.tools.includes(tool as never), false, `${tool} 不应默认开启`);
  }

  const sparse = normalizeDefinition({
    ...base,
    tools: ['offer_claim', 'file_upload', 'task_comment', 'knowledge_search'],
    scopes: ['tasks:read'],
  });
  assert.deepEqual([...sparse.scopes].sort(), [
    'comments:write',
    'knowledge:read',
    'mailbox:read',
    'mailbox:write',
    'offers:claim',
    'tasks:read',
    'tasks:submit',
  ]);
});

test('内嵌控制面：派生令牌可访问主体，运行可被回收且消息退回复用', { timeout: 30_000 }, async () => {
  const harness = await startHarness();
  try {
    await withSecret(async () => {
      const owner = await register(harness, 'owner-recover', ['owner']);
      const agent = await createAgent(harness.admin, scriptDefinition('recover-script'));
      await harness.admin.request(`embedded/agents/${agent.id}/ensure`, {
        body: {},
        operationId: nextOperationId('ensure'),
      });
      const agentClient = harness.client(deriveEmbeddedToken(SECRET, agent.id));
      const session = await agentClient.createMailSession(
        { label: 'recover', kind: 'embedded', ttlSeconds: 600 },
        nextOperationId('session'),
      );

      const task = await owner.createTask(TASK_INPUT, nextOperationId('create'));
      await owner.assign(task.id, { agent: `embedded-${agent.id}`, kind: 'inventory' }, nextOperationId('assign'));

      const run = await harness.admin.request<RunView>(`embedded/agents/${agent.id}/run`, {
        body: {},
        operationId: nextOperationId('run'),
      });
      await agentClient.request(`embedded/runs/${run.id}/heartbeat`, {
        body: { sessionId: session.id },
        operationId: nextOperationId('heartbeat'),
      });

      const past = new Date(Date.now() - 3_600_000).toISOString();
      await harness.db.transaction(tx =>
        tx.run('UPDATE embedded_runs SET heartbeat_at = :past WHERE id = :id', { past, id: run.id }),
      );

      const recovered = await harness.admin.request<{ recovered: string[] }>('embedded/recover', {
        body: { staleSeconds: 60 },
        operationId: nextOperationId('recover'),
      });
      assert.deepEqual(recovered.recovered, [run.id]);

      const runAfter = await harness.admin.request<RunView>(`embedded/runs/${run.id}`);
      assert.equal(runAfter.status, 'outcome_unknown');

      const delivery = await harness.db.read.one<{ owner_key: string; state: string }>(
        `SELECT owner_key, state FROM mailbox_deliveries WHERE message_id IN
           (SELECT id FROM mailbox_messages WHERE task_id = :task)`,
        { task: task.id },
      );
      assert.equal(delivery?.owner_key, `queue:embedded-${agent.id}`);
      assert.equal(delivery?.state, 'pending');
    });
  } finally {
    await harness.close();
  }
});
