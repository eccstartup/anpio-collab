/**
 * 任务与子任务的完整生命周期。
 *
 * 覆盖：正常闭环、非法状态流转、输入校验、并发与重复指派。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectStatus, register, startHarness, TASK_INPUT } from './helpers/harness.ts';

const RESULT_INVENTORY = { quantity: 30, source: 'inventory-fixture', observedAt: '2026-10-28T00:00:00Z' };
const RESULT_SUPPLIER = { quantity: 90, source: 'supplier-fixture', observedAt: '2026-10-28T00:00:00Z' };

test('任务闭环：创建 → 分派 → 接受 → 提交 → 汇总 → 人工验收', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const coordinator = await register(harness, 'coord1', ['agent']);
    const inventory = await register(harness, 'inv1', ['agent']);
    const supplier = await register(harness, 'sup1', ['agent']);

    const created = await owner.createTask(TASK_INPUT, 'create');
    assert.equal(created.status, 'pending');

    const detail = (await owner.task(created.id)) as { task: { title: string }; subtasks: unknown[] };
    assert.equal(detail.task.title, TASK_INPUT.title);
    assert.equal(detail.subtasks.length, 0);

    await owner.delegate(created.id, 'coord1', 'delegate');
    const inventorySub = (await coordinator.assign(
      created.id,
      { agent: 'inv1', kind: 'inventory' },
      'assign-inventory',
    )) as { id: string };
    const supplierSub = (await coordinator.assign(
      created.id,
      { agent: 'sup1', kind: 'supplier' },
      'assign-supplier',
    )) as { id: string };

    const running = (await owner.task(created.id)) as { task: { status: string } };
    assert.equal(running.task.status, 'running');

    // 智能体各有自己的待办，互不可见。
    const inventoryInbox = (await inventory.inbox()) as { id: string; task: { input: Record<string, unknown> } }[];
    assert.equal(inventoryInbox.length, 1);
    assert.equal(inventoryInbox[0].task.input.material, 'M-100');
    assert.equal(((await supplier.inbox()) as { id: string }[])[0].id, supplierSub.id);

    // 未接受不能提交。
    await expectStatus(inventory.submit(inventorySub.id, RESULT_INVENTORY, 'too-early'), 409);

    await inventory.accept(inventorySub.id, 'accept-inventory');
    await inventory.progress(inventorySub.id, '正在查询库存快照', 'progress');
    await inventory.submit(inventorySub.id, RESULT_INVENTORY, 'submit-inventory');

    // 只有一个子任务提交时不能汇总。
    await expectStatus(coordinator.summary(created.id, '缺料 70', 'summary-early'), 409);

    await supplier.accept(supplierSub.id, 'accept-supplier');
    await supplier.submit(supplierSub.id, RESULT_SUPPLIER, 'submit-supplier');

    const summary = (await coordinator.summary(created.id, '库存 30，可供 90，缺口 70', 'summary')) as {
      status: string;
    };
    assert.equal(summary.status, 'review');

    const reviewed = (await owner.review(created.id, 'accept', '数据来源已核对', 'review')) as { status: string };
    assert.equal(reviewed.status, 'completed');

    const final = (await owner.task(created.id)) as {
      task: { status: string; result: { subtasks: { kind: string }[] } };
      subtasks: { status: string; result: { quantity?: number } }[];
    };
    assert.equal(final.task.status, 'completed');
    assert.deepEqual(
      final.subtasks.map(item => item.status),
      ['verified', 'verified'],
    );
    assert.equal(final.task.result.subtasks.length, 2);

    // 智能体看不到其他智能体的结果与任务事件。
    const agentView = (await inventory.task(created.id)) as { subtasks: unknown[]; events: unknown[] };
    assert.equal(agentView.subtasks.length, 1);
    assert.equal(agentView.events.length, 0);

    const events = (await owner.task(created.id)) as { events: { type: string }[] };
    const types = events.events.map(event => event.type);
    assert.deepEqual(types, [
      'task_created',
      'coordinator_delegated',
      'subtask_invited',
      'subtask_invited',
      'subtask_accepted',
      'subtask_progress',
      'subtask_submitted',
      'subtask_accepted',
      'subtask_submitted',
      'summary_submitted',
      'task_accepted',
    ]);
  } finally {
    await harness.close();
  }
});

test('退回与重新提交：验收退回后任务回到执行中', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'inv1', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create');
    const sub = (await owner.assign(created.id, { agent: 'inv1', kind: 'inventory' }, 'assign')) as { id: string };

    await agent.accept(sub.id, 'accept');
    await agent.submit(sub.id, RESULT_INVENTORY, 'submit');
    await owner.summary(created.id, '第一次汇总', 'summary');
    await owner.review(created.id, 'return', '数量需要复核', 'review-return');

    assert.equal(((await owner.task(created.id)) as { task: { status: string } }).task.status, 'running');
    assert.equal(((await owner.task(created.id)) as { subtasks: { status: string }[] }).subtasks[0].status, 'submitted');

    // 负责人退回子任务，智能体可再次接受并提交。
    await owner.returnSubtask(sub.id, '请复核后重新提交', 'return-sub');
    const inbox = (await agent.inbox()) as { id: string; status: string }[];
    assert.equal(inbox[0].status, 'returned');
    await agent.accept(sub.id, 'accept-again');
    await agent.submit(sub.id, { ...RESULT_INVENTORY, quantity: 35 }, 'submit-again');
    await owner.summary(created.id, '第二次汇总', 'summary-again');
    await owner.review(created.id, 'accept', '已核对', 'review-accept');

    const final = (await owner.task(created.id)) as { subtasks: { result: { quantity?: number } }[] };
    assert.equal(final.subtasks[0].result.quantity, 35);
  } finally {
    await harness.close();
  }
});

test('依赖未完成时不能接受子任务', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const first = await register(harness, 'inv1', ['agent']);
    const second = await register(harness, 'sup1', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create');
    const base = (await owner.assign(created.id, { agent: 'inv1', kind: 'inventory' }, 'a1')) as { id: string };
    const dependent = (await owner.assign(
      created.id,
      { agent: 'sup1', kind: 'supplier', dependsOn: [base.id] },
      'a2',
    )) as { id: string; dependsOn: string[] };
    assert.deepEqual(dependent.dependsOn, [base.id]);

    // 依赖未满足：不在待办里，接受会失败。
    assert.equal(((await second.inbox()) as unknown[]).length, 0);
    await expectStatus(second.accept(dependent.id, 'accept-blocked'), 409);

    await first.accept(base.id, 'accept-base');
    await first.submit(base.id, RESULT_INVENTORY, 'submit-base');
    assert.equal(((await second.inbox()) as unknown[]).length, 1);
    await second.accept(dependent.id, 'accept-dependent');
  } finally {
    await harness.close();
  }
});

test('输入校验与非法流转被拒绝', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'inv1', ['agent']);

    await expectStatus(
      owner.createTask({ title: '缺少验收条件', input: { material: 'M-100', quantity: 1 } }, 'bad-1'),
      400,
    );
    await expectStatus(
      owner.createTask({ ...TASK_INPUT, dueAt: '2020-01-01T00:00:00Z' }, 'bad-2'),
      400,
    );
    await expectStatus(owner.createTask({ ...TASK_INPUT, input: { nested: { a: 1 } } }, 'bad-3'), 400);

    const created = await owner.createTask(TASK_INPUT, 'create');
    await expectStatus(owner.assign(created.id, { agent: 'nobody', kind: 'x' }, 'bad-agent'), 400);
    await expectStatus(owner.assign(created.id, { agent: 'admin', kind: 'x' }, 'bad-role'), 400);

    const sub = (await owner.assign(created.id, { agent: 'inv1', kind: 'inventory' }, 'assign')) as { id: string };
    await expectStatus(owner.assign(created.id, { agent: 'inv1', kind: 'inventory' }, 'assign-dup'), 409);

    // 只有 agent 能执行子任务操作。
    await expectStatus(owner.accept(sub.id, 'owner-accept'), 403);
    // 智能体不能验收。
    await agent.accept(sub.id, 'accept');
    await agent.submit(sub.id, RESULT_INVENTORY, 'submit');
    await expectStatus(agent.review(created.id, 'accept', '越权', 'agent-review'), 403);
    // 未汇总前不能验收。
    await expectStatus(owner.review(created.id, 'accept', '太早', 'early-review'), 409);
  } finally {
    await harness.close();
  }
});

test('取消任务：未核验子任务一并取消并通知', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'inv1', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create');
    const sub = (await owner.assign(created.id, { agent: 'inv1', kind: 'inventory' }, 'assign')) as { id: string };
    await agent.accept(sub.id, 'accept');

    await owner.cancel(created.id, '需求取消', 'cancel');
    const view = (await owner.task(created.id)) as { task: { status: string }; subtasks: { status: string }[] };
    assert.equal(view.task.status, 'cancelled');
    assert.equal(view.subtasks[0].status, 'cancelled');

    const notifications = (await agent.notifications()) as { type: string }[];
    assert.ok(notifications.some(item => item.type === 'cancelled'));
    assert.equal(((await agent.inbox()) as unknown[]).length, 0);
    await expectStatus(owner.cancel(created.id, '重复取消', 'cancel-again'), 409);
  } finally {
    await harness.close();
  }
});

test('归档任务：只归档已结束任务，列表、首页与超时提醒都隐藏', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const outsider = await register(harness, 'owner2', ['owner']);
    const created = await owner.createTask(TASK_INPUT, 'create-archive');

    await expectStatus(owner.archiveTask(created.id, 'archive-open'), 409);

    await owner.cancel(created.id, '需求取消', 'cancel-archive');
    await expectStatus(outsider.archiveTask(created.id, 'archive-outsider'), 403);

    const archived = await owner.archiveTask(created.id, 'archive');
    assert.ok(archived.archivedAt);
    const view = (await owner.task(created.id)) as {
      task: { archivedAt: string | null };
      events: { type: string }[];
    };
    assert.equal(view.task.archivedAt, archived.archivedAt);
    assert.ok(view.events.some((event) => event.type === 'task_archived'));

    const visible = (await owner.tasks()) as { id: string }[];
    assert.ok(!visible.some((item) => item.id === created.id));
    const all = (await owner.tasks({ includeArchived: true })) as { id: string; archivedAt?: string | null }[];
    assert.ok(all.some((item) => item.id === created.id && item.archivedAt));

    await expectStatus(owner.archiveTask(created.id, 'archive-again'), 409);

    await owner.unarchiveTask(created.id, 'unarchive');
    const restored = (await owner.tasks()) as { id: string }[];
    assert.ok(restored.some((item) => item.id === created.id));
    const after = (await owner.task(created.id)) as { task: { archivedAt: string | null } };
    assert.equal(after.task.archivedAt, null);
    await expectStatus(owner.unarchiveTask(created.id, 'unarchive-again'), 409);
  } finally {
    await harness.close();
  }
});
