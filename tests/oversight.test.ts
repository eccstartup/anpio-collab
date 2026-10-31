/**
 * 监管与报警。
 *
 * 关注三件事：规则能不能把"不对"变成一条可处理的告警、重复扫描会不会
 * 制造噪音、以及人工结论（已解决）会不会被下一次扫描推翻。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectStatus, nextOperationId, register, startHarness, TASK_INPUT } from './helpers/harness.ts';

type Alert = {
  id: string;
  rule: string;
  severity: string;
  status: string;
  occurrences: number;
  subjectId: string;
  detail: string;
};

type Overview = {
  counts: { openAlerts: number; overdueSubtasks: number };
  alerts: Alert[];
  riskyTasks: { id: string }[];
  bySeverity: Record<string, number>;
};

const past = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

test('逾期子任务产生 high 告警；重复扫描只累加次数', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent']);
    const task = await owner.createTask(TASK_INPUT, 'create');
    const subtask = (await owner.assign(task.id, { agent: 'agent1', kind: 'inventory' }, 'assign')) as { id: string };

    await harness.db.run('UPDATE subtasks SET due_at = :due WHERE id = :id', { due: past(60), id: subtask.id });

    const first = await harness.admin.scanAlerts();
    assert.ok(first.total >= 1);

    const firstScan = (await harness.admin.oversight()) as Overview;
    const overdue = firstScan.alerts.filter(item => item.rule === 'subtask_overdue');
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0]!.severity, 'high');
    assert.equal(overdue[0]!.subjectId, subtask.id);
    assert.equal(firstScan.counts.overdueSubtasks, 1);

    const second = await harness.admin.scanAlerts();
    assert.equal(second.opened, 0);
    const secondScan = (await harness.admin.oversight()) as Overview;
    const sameAlert = secondScan.alerts.filter(item => item.rule === 'subtask_overdue');
    assert.equal(sameAlert.length, 1, '同一主体同一规则只有一条');
    assert.equal(sameAlert[0]!.id, overdue[0]!.id);
    assert.equal(sameAlert[0]!.occurrences, 2);

    // 危险任务清单里能直接看到它。
    assert.equal(secondScan.riskyTasks.some(item => item.id === task.id), true);
    assert.equal(agent.me !== undefined, true);
  } finally {
    await harness.close();
  }
});

test('条件消失后自动解决，条件重现则重开', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    await register(harness, 'agent1', ['agent']);
    const task = await owner.createTask(TASK_INPUT, 'create');
    const subtask = (await owner.assign(task.id, { agent: 'agent1', kind: 'inventory' }, 'assign')) as { id: string };
    await harness.db.run('UPDATE subtasks SET due_at = :due WHERE id = :id', { due: past(60), id: subtask.id });

    await harness.admin.scanAlerts();
    await harness.db.run('UPDATE subtasks SET due_at = :due WHERE id = :id', {
      due: new Date(Date.now() + 86_400_000).toISOString(),
      id: subtask.id,
    });
    const cleared = await harness.admin.scanAlerts();
    assert.ok(cleared.resolved >= 1);
    const afterClear = ((await harness.admin.oversight()) as Overview).alerts;
    assert.equal(afterClear.some(item => item.rule === 'subtask_overdue'), false);

    await harness.db.run('UPDATE subtasks SET due_at = :due WHERE id = :id', { due: past(60), id: subtask.id });
    const again = await harness.admin.scanAlerts();
    assert.equal(again.opened, 1);
  } finally {
    await harness.close();
  }
});

test('人工解决的告警不会被下一次扫描重开，直到条件真的变化', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    await register(harness, 'agent1', ['agent']);
    const task = await owner.createTask(TASK_INPUT, 'create');
    const subtask = (await owner.assign(task.id, { agent: 'agent1', kind: 'inventory' }, 'assign')) as { id: string };
    await harness.db.run('UPDATE subtasks SET due_at = :due WHERE id = :id', { due: past(60), id: subtask.id });
    await harness.admin.scanAlerts();

    const alert = ((await harness.admin.oversight()) as Overview).alerts.find(
      item => item.rule === 'subtask_overdue',
    )!;
    await harness.admin.resolveAlert(alert.id, 'resolve-1');
    assert.equal(
      ((await harness.admin.oversight()) as Overview).alerts.some(item => item.rule === 'subtask_overdue'),
      false,
    );

    const scan = await harness.admin.scanAlerts();
    assert.equal(scan.opened, 0, '人工结论不该被扫描器立刻推翻');
    const row = await harness.db.read.one<{ status: string }>('SELECT status FROM alerts WHERE id = :id', {
      id: alert.id,
    });
    assert.equal(row?.status, 'resolved');
  } finally {
    await harness.close();
  }
});

test('确认告警不等于解决，两者都留痕', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    await register(harness, 'agent1', ['agent']);
    const task = await owner.createTask(TASK_INPUT, 'create');
    const subtask = (await owner.assign(task.id, { agent: 'agent1', kind: 'inventory' }, 'assign')) as { id: string };
    await harness.db.run('UPDATE subtasks SET due_at = :due WHERE id = :id', { due: past(60), id: subtask.id });
    await harness.admin.scanAlerts();

    const alert = ((await harness.admin.oversight()) as Overview).alerts.find(
      item => item.rule === 'subtask_overdue',
    )!;
    const acked = (await harness.admin.acknowledgeAlert(alert.id, 'ack-1')) as { status: string; acknowledgedBy: string };
    assert.equal(acked.status, 'acknowledged');
    assert.equal(acked.acknowledgedBy, 'admin');

    const stillOpen = ((await harness.admin.oversight()) as Overview).alerts;
    assert.equal(stillOpen.some(item => item.id === alert.id && item.status === 'acknowledged'), true);
  } finally {
    await harness.close();
  }
});

test('有活没干完的智能体失联会被点名', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent']);
    const task = await owner.createTask(TASK_INPUT, 'create');
    await owner.assign(task.id, { agent: 'agent1', kind: 'inventory' }, 'assign');

    await agent.heartbeat({ state: 'online' });
    await harness.admin.scanAlerts();
    assert.equal(
      ((await harness.admin.oversight()) as Overview).alerts.some(item => item.rule === 'agent_offline'),
      false,
      '刚心跳过不算失联',
    );

    // 30 分钟没动静，而手上还有未完成子任务。
    await harness.db.run(`UPDATE agent_presence SET last_seen_at = :at WHERE principal_id = 'agent1'`, {
      at: past(30),
    });
    await harness.admin.scanAlerts();
    const offline = ((await harness.admin.oversight()) as Overview).alerts.find(item => item.rule === 'agent_offline');
    assert.ok(offline);
    assert.equal(offline!.subjectId, 'agent1');
    assert.match(offline!.detail, /未完成子任务/);
  } finally {
    await harness.close();
  }
});

test('智能体发起的提案长期无人接管会提醒', async () => {
  const harness = await startHarness();
  try {
    const agent = await register(harness, 'watcher', ['agent']);
    const proposal = await agent.createTask({ title: '库存低于安全线', acceptance: '给出建议' }, 'p-1');
    await harness.db.run('UPDATE tasks SET created_at = :at WHERE id = :id', { at: past(60 * 24), id: proposal.id });

    await harness.admin.scanAlerts();
    const alert = ((await harness.admin.oversight()) as Overview).alerts.find(
      item => item.rule === 'agent_task_unadopted',
    );
    assert.ok(alert);
    assert.equal(alert!.subjectId, proposal.id);
  } finally {
    await harness.close();
  }
});

test('监管视图只对监管者与管理员开放', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent']);
    const supervisor = await register(harness, 'sup1', ['supervisor']);

    await expectStatus(owner.oversight(), 403);
    await expectStatus(agent.oversight(), 403);
    await expectStatus(owner.scanAlerts(), 403);

    const view = (await supervisor.oversight()) as Overview;
    assert.equal(typeof view.counts.openAlerts, 'number');
    assert.equal(Array.isArray(view.alerts), true);
  } finally {
    await harness.close();
  }
});

test('拒绝请求激增会形成一条工作空间级告警', async () => {
  const harness = await startHarness();
  try {
    await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent']);
    const task = await harness.admin.createTask(TASK_INPUT, 'create');

    // 连续越权读取，触发 denied_spike（阈值默认 8 次/小时）。
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await expectStatus(agent.task(task.id), 403);
    }
    await harness.admin.scanAlerts();
    const alert = ((await harness.admin.oversight()) as Overview).alerts.find(item => item.rule === 'denied_spike');
    assert.ok(alert);
    assert.equal(alert!.subjectId, 'acme');
  } finally {
    await harness.close();
  }
});

test('提问与 @ 提醒超时进入监管；回答与已读后自动解决', async () => {
  const harness = await startHarness();
  try {
    const agent = await register(harness, 'ask-agent', ['agent']);
    const task = (await harness.admin.createTask(TASK_INPUT, nextOperationId('create'))) as { id: string };
    const subtask = (await harness.admin.assign(
      task.id,
      { agent: 'ask-agent', kind: 'inventory' },
      nextOperationId('assign'),
    )) as { id: string };
    await agent.accept(subtask.id, nextOperationId('accept'));

    const question = (await agent.sendMessage(
      task.id,
      { body: '@admin 盘点口径用哪天的？', kind: 'question', payload: { to: 'admin' } },
      nextOperationId('ask'),
    )) as { id: string };

    await harness.db.run('UPDATE task_comments SET created_at = :at WHERE id = :id', {
      at: past(300),
      id: question.id,
    });
    await harness.db.run('UPDATE task_mentions SET created_at = :at WHERE comment_id = :id', {
      at: past(300),
      id: question.id,
    });

    await harness.admin.scanAlerts();
    const view = (await harness.admin.oversight()) as Overview;
    assert.equal(view.alerts.filter(item => item.rule === 'question_unanswered').length, 1);
    const mention = view.alerts.find(item => item.rule === 'mention_unread');
    assert.ok(mention, '未读 @ 提醒应形成告警');
    assert.equal(mention!.severity, 'low');

    await harness.admin.markRead(task.id, nextOperationId('read'));
    await harness.admin.sendMessage(
      task.id,
      { body: '用昨天的，注明时效。', kind: 'answer', replyTo: question.id },
      nextOperationId('answer'),
    );
    await harness.admin.scanAlerts();

    const rows = await harness.db.read.all<{ rule: string; status: string }>(
      `SELECT rule, status FROM alerts WHERE rule IN ('question_unanswered', 'mention_unread')`,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows.every(row => row.status === 'resolved'), true, '回答与已读后两条告警都应解决');
  } finally {
    await harness.close();
  }
});
