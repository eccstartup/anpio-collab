/**
 * 内嵌智能体运行时：跨进程跑完一轮。
 *
 * 这里不 mock 任何 HTTP：supervisor 子进程通过真实接口拿定义、起运行、
 * 写入结果；测试进程只负责准备任务与检查账本。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_TOKEN,
  TASK_INPUT,
  nextOperationId,
  register,
  startHarness,
  type Harness,
} from './helpers/harness.ts';
import type { CollabClient } from '../src/sdk/client.ts';
import { deriveEmbeddedToken } from '../src/runtime/token.ts';

const SECRET = 'embedded-test-secret-0123456789abcdef';
const SUPERVISOR = fileURLToPath(new URL('../src/runtime/supervisor.ts', import.meta.url));

type AgentView = {
  id: string;
  name: string;
  unread: number;
  running: number;
  enabled: boolean;
};

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

async function createAgent(admin: CollabClient, definition: Record<string, unknown>): Promise<AgentView> {
  return admin.request<AgentView>('embedded/agents', {
    body: definition,
    operationId: nextOperationId('agent-create'),
  });
}

function scriptDefinition(name: string, options: { enabled?: boolean } = {}): Record<string, unknown> {
  return {
    name,
    description: '运行时测试用：接活、写文件、报进度、提交结果',
    capabilities: ['inventory'],
    provider: {
      id: 'script',
      protocol: 'script',
      model: 'script',
      script: [
        { tool: 'task_accept', input: { subtaskId: '{{refId}}' } },
        { tool: 'write_file', input: { path: 'notes.txt', content: '已核对 {{taskId}}' } },
        { tool: 'task_progress', input: { subtaskId: '{{refId}}', text: '库存与供应商数据已核对' } },
        {
          tool: 'task_submit',
          input: {
            subtaskId: '{{refId}}',
            result: {
              summary: '库存核对完成',
              source: 'e2e-script',
              observedAt: '{{now}}',
              material: 'M-100',
              ok: true,
            },
          },
        },
      ],
    },
    tools: ['task_get', 'task_accept', 'task_progress', 'task_submit', 'read_file', 'write_file', 'list_files'],
    limits: { maxTurns: 10, timeoutMs: 30_000, maxTokens: 1_024 },
    ...(options.enabled === false ? { enabled: false } : {}),
  };
}

function runSupervisor(
  harness: Harness,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SUPERVISOR, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COLLAB_BASE_URL: harness.url,
        COLLAB_RUNTIME_TOKEN: ADMIN_TOKEN,
        COLLAB_EMBEDDED_SECRET: SECRET,
        COLLAB_RUNTIME_TICK_MS: '200',
        COLLAB_RUN_ROOT: join(harness.directory, 'runs'),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('exit', code => resolve({ code: code ?? 1, output }));
  });
}

async function agentView(admin: CollabClient, agentId: string): Promise<AgentView> {
  return admin.request<AgentView>(`embedded/agents/${encodeURIComponent(agentId)}`);
}

async function runsOf(admin: CollabClient, agentId: string): Promise<RunView[]> {
  return admin.request<RunView[]>(`embedded/agents/${encodeURIComponent(agentId)}/runs`);
}

test('运行时：脚本智能体跨进程接活并提交结果', { timeout: 60_000 }, async () => {
  const harness = await startHarness();
  try {
    await withSecret(async () => {
      const owner = await register(harness, 'owner-run', ['owner']);
      const agent = await createAgent(harness.admin, scriptDefinition('e2e-script'));
      await harness.admin.request(`embedded/agents/${agent.id}/ensure`, {
        body: {},
        operationId: nextOperationId('ensure'),
      });
      const principalId = `embedded-${agent.id}`;

      const task = await owner.createTask(TASK_INPUT, nextOperationId('create'));
      const subtask = (await owner.assign(
        task.id,
        { agent: principalId, kind: 'inventory' },
        nextOperationId('assign'),
      )) as { id: string };

      const before = await agentView(harness.admin, agent.id);
      assert.equal(before.unread, 1);

      const result = await runSupervisor(harness, ['--once', '--agent', agent.id]);
      assert.equal(result.code, 0, result.output);

      const runs = await runsOf(harness.admin, agent.id);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.status, 'succeeded', runs[0]!.error ?? '');

      const detail = await owner.task(task.id);
      const saved = detail.subtasks.find(item => item.id === subtask.id);
      assert.equal(saved?.status, 'submitted');
      assert.equal((saved?.result as { summary?: string }).summary, '库存核对完成');

      const after = await agentView(harness.admin, agent.id);
      assert.equal(after.unread, 0, '处理完的消息应已确认');
      assert.equal(after.running, 0);

      const logs = await harness.admin.request<{ seq: number; text: string }[]>(
        `embedded/runs/${encodeURIComponent(runs[0]!.id)}/log?limit=100`,
      );
      const joined = logs.map(entry => entry.text).join('\n');
      assert.match(joined, /task_submit/);
      assert.match(joined, /收尾/);

      // 工作目录默认在运行结束后清理。
      assert.equal(existsSync(join(harness.directory, 'runs', agent.id, runs[0]!.id)), false);

      // 再跑一轮：没有新消息就不应再起运行。
      const again = await runSupervisor(harness, ['--once', '--agent', agent.id]);
      assert.equal(again.code, 0, again.output);
      assert.equal((await runsOf(harness.admin, agent.id)).length, 1);
    });
  } finally {
    await harness.close();
  }
});

test('运行时：控制台手动创建的运行会被 supervisor 接管', { timeout: 60_000 }, async () => {
  const harness = await startHarness();
  try {
    await withSecret(async () => {
      const agent = await createAgent(harness.admin, scriptDefinition('manual-script'));
      const run = await harness.admin.request<RunView>(`embedded/agents/${agent.id}/run`, {
        body: {},
        operationId: nextOperationId('manual-run'),
      });
      assert.equal(run.status, 'running');

      const result = await runSupervisor(harness, ['--once', '--agent', agent.id]);
      assert.equal(result.code, 0, result.output);

      const runs = await runsOf(harness.admin, agent.id);
      assert.equal(runs.length, 1, '接管已有运行，不应再建一条');
      assert.equal(runs[0]!.id, run.id);
      assert.equal(runs[0]!.status, 'succeeded', `${runs[0]!.error ?? ''}\n${result.output}`);
      assert.equal((await agentView(harness.admin, agent.id)).running, 0);
    });
  } finally {
    await harness.close();
  }
});

test('运行时：两轮运行的日志都写进各自运行，seq 不会互相覆盖', { timeout: 60_000 }, async () => {
  const harness = await startHarness();
  try {
    await withSecret(async () => {
      const first = await createAgent(harness.admin, scriptDefinition('log-script-1'));
      const second = await createAgent(harness.admin, scriptDefinition('log-script-2'));

      for (const agent of [first, second]) {
        await harness.admin.request<RunView>(`embedded/agents/${agent.id}/run`, {
          body: {},
          operationId: nextOperationId('run'),
        });
        const result = await runSupervisor(harness, ['--once', '--agent', agent.id]);
        assert.equal(result.code, 0, result.output);
      }

      for (const agent of [first, second]) {
        const runs = await runsOf(harness.admin, agent.id);
        assert.equal(runs.length, 1, agent.name);
        const logs = await harness.admin.request<{ seq: number; text: string }[]>(
          `embedded/runs/${encodeURIComponent(runs[0]!.id)}/log?limit=100`,
        );
        assert.ok(logs.length > 0, `${agent.name} 的运行日志不应为空`);
        assert.match(logs.map(entry => entry.text).join('\n'), /运行开始/);
      }
    });
  } finally {
    await harness.close();
  }
});

test('运行时：停用的定义不会被叫起来', { timeout: 60_000 }, async () => {
  const harness = await startHarness();
  try {
    await withSecret(async () => {
      const owner = await register(harness, 'owner-off', ['owner']);
      const agent = await createAgent(harness.admin, scriptDefinition('sleeping-script', { enabled: false }));
      await harness.admin.request(`embedded/agents/${agent.id}/ensure`, {
        body: {},
        operationId: nextOperationId('ensure'),
      });
      const task = await owner.createTask(TASK_INPUT, nextOperationId('create'));
      await owner.assign(task.id, { agent: `embedded-${agent.id}`, kind: 'inventory' }, nextOperationId('assign'));

      const result = await runSupervisor(harness, ['--once', '--agent', agent.id]);
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(await runsOf(harness.admin, agent.id), []);
      assert.equal((await agentView(harness.admin, agent.id)).unread, 1);
    });
  } finally {
    await harness.close();
  }
});

test('运行时：心跳停滞的运行被回收，消息退回队列', { timeout: 60_000 }, async () => {
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
