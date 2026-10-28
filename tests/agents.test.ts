/**
 * 独立进程的端到端协作。
 *
 * 业务智能体和协调智能体都以子进程运行：它们只通过 HTTP 与平台交互，
 * 不共享数据库、不共享内存。测试验证的是"跨进程交接"这件事本身。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { register, startHarness } from './helpers/harness.ts';

type RunResult = { code: number | null; stdout: string; stderr: string };

const ROOT = process.cwd();

function run(script: string, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

test('协调智能体与两个业务智能体跨进程完成任务', async () => {
  const harness = await startHarness();
  try {
    const inventoryToken = harness.token('inv');
    const supplierToken = harness.token('sup');
    const coordinatorToken = harness.token('coord');
    for (const [id, token, capabilities] of [
      ['inv1', inventoryToken, ['inventory:read']],
      ['sup1', supplierToken, ['supplier:read']],
      ['coord1', coordinatorToken, ['coordination']],
    ] as const) {
      await harness.admin.registerPrincipal({ id, roles: ['agent'], token, capabilities: [...capabilities] }, `register-${id}`);
    }

    const created = await harness.admin.createTask(
      {
        title: '缺料分析 M-100',
        type: 'shortage-analysis',
        acceptance: '核对库存与供应商数据来源',
        input: { material: 'M-100', quantity: 100 },
      },
      'create',
    );
    await harness.admin.delegate(created.id, 'coord1', 'delegate');

    const coordinatorEnv = {
      COLLAB_URL: harness.url,
      COLLAB_TOKEN: coordinatorToken,
      COLLAB_TASK: created.id,
      COLLAB_INVENTORY_AGENT: 'inv1',
      COLLAB_SUPPLIER_AGENT: 'sup1',
    };

    const firstPass = await run('src/agents/coordinator.ts', coordinatorEnv);
    assert.equal(firstPass.code, 0, firstPass.stderr);
    assert.match(firstPass.stdout, /已派发 inventory/);

    const detail = await harness.admin.task(created.id);
    assert.equal(detail.subtasks.length, 2);
    assert.equal(detail.task.status, 'running');

    const workers = await Promise.all([
      run('src/agents/worker.ts', {
        COLLAB_URL: harness.url,
        COLLAB_TOKEN: inventoryToken,
        COLLAB_KIND: 'inventory',
        COLLAB_DATA: join(ROOT, 'examples/data/inventory.json'),
        COLLAB_WORKER_DB: join(harness.directory, 'inv1.sqlite'),
      }),
      run('src/agents/worker.ts', {
        COLLAB_URL: harness.url,
        COLLAB_TOKEN: supplierToken,
        COLLAB_KIND: 'supplier',
        COLLAB_DATA: join(ROOT, 'examples/data/supplier.json'),
        COLLAB_WORKER_DB: join(harness.directory, 'sup1.sqlite'),
      }),
    ]);
    for (const worker of workers) assert.equal(worker.code, 0, worker.stderr);

    const secondPass = await run('src/agents/coordinator.ts', coordinatorEnv);
    assert.equal(secondPass.code, 0, secondPass.stderr);
    assert.match(secondPass.stdout, /已提交汇总/);

    const review = await harness.admin.task(created.id);
    assert.equal(review.task.status, 'review');
    assert.match(String((review.task.result as { text: string }).text), /库存 30/);

    // 智能体不能验收，必须由负责人执行。
    const agentClient = harness.client(inventoryToken);
    await assert.rejects(agentClient.review(created.id, 'accept', '越权', 'agent-review'), (error: { status: number }) => {
      assert.equal(error.status, 403);
      return true;
    });

    await harness.admin.review(created.id, 'accept', '来源与时效已核对', 'review');
    const final = await harness.admin.task(created.id);
    assert.equal(final.task.status, 'completed');
    assert.ok(final.subtasks.every(item => item.status === 'verified'));
  } finally {
    await harness.close();
  }
});
