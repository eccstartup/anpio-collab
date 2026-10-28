/**
 * 幂等与并发控制。
 *
 * 平台的承诺是：同一主体、同一 Idempotency-Key、同一请求体，
 * 无论重复投递多少次都只产生一次效果；换了请求体则明确冲突。
 * 版本号则提供"看到的是我改的那一版吗"的检查。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectStatus, register, startHarness, TASK_INPUT } from './helpers/harness.ts';

test('同一幂等键重放只创建一个任务', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const first = await owner.createTask(TASK_INPUT, 'same-op');
    const second = await owner.createTask(TASK_INPUT, 'same-op');
    assert.deepEqual(second, first);

    const tasks = (await owner.tasks()) as { id: string }[];
    assert.equal(tasks.length, 1);

    // 审计里能看出这是一次重放。
    const audit = (await harness.admin.audit()) as { action: string; outcome: string }[];
    assert.ok(audit.some(entry => entry.outcome === 'replay'));
  } finally {
    await harness.close();
  }
});

test('同一幂等键配不同请求体返回 409', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    await owner.createTask(TASK_INPUT, 'reused-key');
    await expectStatus(owner.createTask({ ...TASK_INPUT, title: '换了标题' }, 'reused-key'), 409);
  } finally {
    await harness.close();
  }
});

test('If-Match 校验版本，过期版本返回 412', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    await register(harness, 'coord1', ['agent']);

    const created = await owner.createTask(TASK_INPUT, 'create');
    assert.equal(created.version, 1);

    const view = (await owner.task(created.id)) as { task: { version: number } };
    const current = view.task.version;
    assert.equal(current, created.version);

    // 版本不匹配：拒绝，且不产生副作用。
    await expectStatus(owner.delegate(created.id, 'coord1', 'stale-delegate', current + 5), 412);

    // 版本匹配：通过，并且版本号增长。
    await owner.delegate(created.id, 'coord1', 'fresh-delegate', current);
    const after = (await owner.task(created.id)) as { task: { version: number }; coordinators: string[] };
    assert.ok(after.task.version > current);
    assert.deepEqual(after.coordinators, ['coord1']);

    // 没有版本的接口不接受 If-Match。
    await expectStatus(
      owner.request('tasks', { body: TASK_INPUT, operationId: 'if-match-on-create', expectedVersion: 1 }),
      400,
    );
  } finally {
    await harness.close();
  }
});

test('并发提交只有一方成功', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'inv1', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create');
    const sub = (await owner.assign(created.id, { agent: 'inv1', kind: 'inventory' }, 'assign')) as { id: string };
    await agent.accept(sub.id, 'accept');

    const result = { quantity: 10, source: 'fixture', observedAt: '2026-10-28T00:00:00Z' };
    const outcomes = await Promise.allSettled([
      agent.submit(sub.id, result, 'submit-a'),
      agent.submit(sub.id, { ...result, quantity: 20 }, 'submit-b'),
    ]);
    const fulfilled = outcomes.filter(item => item.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, '只应有一次提交生效');
    const rejected = outcomes.find(item => item.status === 'rejected') as PromiseRejectedResult;
    assert.equal((rejected.reason as { status: number }).status, 409);

    const view = (await owner.task(created.id)) as { subtasks: { status: string; result: { quantity: number } }[] };
    assert.equal(view.subtasks[0].status, 'submitted');
  } finally {
    await harness.close();
  }
});

test('事件序号单调递增，可作为阶段摘要的覆盖位置', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const created = await owner.createTask(TASK_INPUT, 'create');
    const first = (await owner.stageSummary(created.id, { text: '已创建', pending: '待分派' }, 'stage1')) as {
      version: number;
      throughSeq: number;
    };
    assert.equal(first.version, 1);

    await register(harness, 'coord1', ['agent']);
    await owner.assign(created.id, { agent: 'coord1', kind: 'self' }, 'assign');

    const context = (await owner.context(created.id)) as { stageSummary: { stale: boolean; throughSeq: number } };
    assert.equal(context.stageSummary.stale, true);
    assert.ok(context.stageSummary.throughSeq >= first.throughSeq);
  } finally {
    await harness.close();
  }
});
