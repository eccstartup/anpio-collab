/**
 * 第二阶段：房间未读、点名提问、交接包与跨任务检索。
 *
 * 这几件事都不推进任务版本：已读是每人的游标，提问是消息，
 * 检索与交接包只是读。测试同时经由 SDK 调用，顺带覆盖客户端封装。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expectStatus,
  nextOperationId,
  register,
  startHarness,
  TASK_INPUT,
} from './helpers/harness.ts';
import type { SpaceFile, TaskComment, TaskRoom } from '../src/sdk/client.ts';

test('未读按人记录：标已读不推进任务版本，提问只算点名问我的', async () => {
  const harness = await startHarness();
  try {
    const owner = harness.admin;
    const agent = await register(harness, 'room-agent', ['agent']);
    const created = (await owner.createTask(TASK_INPUT, nextOperationId('create'))) as {
      id: string;
      version: number;
    };
    const subtask = (await owner.assign(
      created.id,
      { agent: 'room-agent', kind: 'inventory' },
      nextOperationId('assign'),
    )) as { id: string };
    await agent.accept(subtask.id, nextOperationId('accept'));

    const question = (await agent.sendMessage(
      created.id,
      { body: '库存数据只有昨天的，可以吗？', kind: 'question', payload: { to: 'admin' } },
      nextOperationId('ask'),
    )) as TaskComment;

    const before = await owner.room(created.id);
    assert.equal(before.unread.messages, 1);
    assert.equal(before.unread.questions, 1);
    assert.equal(before.lastReadAt, null);
    assert.equal((await agent.room(created.id)).unread.messages, 0, '自己的消息不算未读');

    const versionBefore = ((await owner.task(created.id)) as { task: { version: number } }).task.version;
    const read = await owner.markRead(created.id, nextOperationId('read'));
    assert.equal(read.unread.messages, 0);
    assert.ok(read.lastReadAt);
    const versionAfter = ((await owner.task(created.id)) as { task: { version: number } }).task.version;
    assert.equal(versionAfter, versionBefore, '已读不改变任务版本');

    const after = await owner.room(created.id);
    assert.equal(after.unread.messages, 0);
    assert.equal(after.unread.questions, 0);
    assert.equal(after.lastReadAt, read.lastReadAt);

    const addressed = (await owner.questions()) as TaskComment[];
    assert.deepEqual(addressed.map(item => item.id), [question.id], '点名问我的问题还在待回答里');

    await owner.sendMessage(
      created.id,
      { body: '可以先按昨天的来，备注时效。', kind: 'answer', replyTo: question.id },
      nextOperationId('answer'),
    );
    assert.deepEqual((await owner.questions()) as TaskComment[], [], '回答后不再追问');

    const second = (await agent.sendMessage(
      created.id,
      { body: '第二家供应商也要询价吗？', kind: 'question', payload: { to: ['admin'] } },
      nextOperationId('ask'),
    )) as TaskComment;
    assert.equal((await owner.room(created.id)).unread.messages, 1);
    assert.deepEqual(((await owner.questions()) as TaskComment[]).map(item => item.id), [second.id]);

    await expectStatus(
      agent.sendMessage(
        created.id,
        { body: '发给不存在的人', kind: 'question', payload: { to: 'nobody' } },
        nextOperationId('bad-ask'),
      ),
      400,
    );
  } finally {
    await harness.close();
  }
});

test('交接包：markdown 给人看，manifest 给程序用，文件带下载地址', async () => {
  const harness = await startHarness();
  try {
    const owner = harness.admin;
    const agent = await register(harness, 'pack-agent', ['agent']);
    const created = (await owner.createTask(TASK_INPUT, nextOperationId('create'))) as { id: string };
    const subtask = (await owner.assign(
      created.id,
      { agent: 'pack-agent', kind: 'inventory' },
      nextOperationId('assign'),
    )) as { id: string };
    await agent.accept(subtask.id, nextOperationId('accept'));

    await agent.openThread(
      created.id,
      { topic: '供应商交期', assigneeId: 'pack-agent' },
      nextOperationId('thread'),
    );
    await agent.sendMessage(
      created.id,
      { body: '供应商回复下周一到货。', kind: 'status' },
      nextOperationId('say'),
    );
    const file = (await agent.uploadBytes(
      { name: 'plan.md', mime: 'text/markdown', taskId: created.id, kind: 'output' },
      new TextEncoder().encode('# 补货计划\n'),
      nextOperationId('upload'),
    )) as SpaceFile;

    const pack = await owner.contextPack(created.id);
    assert.match(pack.markdown, /任务交接包：缺料分析 M-100/);
    assert.match(pack.markdown, /判断 100 件 M-100 能否按时交付/);
    assert.match(pack.markdown, /供应商交期/);
    assert.match(pack.markdown, /plan\.md/);
    assert.match(pack.markdown, new RegExp(`/v1/tasks/${created.id}/files/${file.id}/content`));

    const manifest = pack.manifest as {
      task: { id: string; version: number };
      files: { id: string; downloadUrl: string }[];
      threads: { topic: string }[];
      messages: { body: string }[];
    };
    assert.equal(manifest.task.id, created.id);
    assert.deepEqual(manifest.files.map(item => item.id), [file.id]);
    assert.ok(manifest.files[0]!.downloadUrl.endsWith(`/files/${file.id}/content`));
    assert.deepEqual(manifest.threads.map(item => item.topic), ['供应商交期']);
    assert.ok(manifest.messages.some(item => item.body.includes('下周一到货')));

    const downloaded = await owner.downloadTaskFile(created.id, file.id);
    assert.equal(new TextDecoder().decode(downloaded.data), '# 补货计划\n');

    const outsider = await register(harness, 'pack-outsider', ['agent']);
    await expectStatus(outsider.contextPack(created.id), 403);
  } finally {
    await harness.close();
  }
});

test('跨任务检索只返回调用方有权读取的消息与文件', async () => {
  const harness = await startHarness();
  try {
    const owner = harness.admin;
    const agent = await register(harness, 'search-agent', ['agent']);
    const mine = (await owner.createTask(
      { ...TASK_INPUT, title: '缺料分析 M-100' },
      nextOperationId('create'),
    )) as { id: string };
    const other = (await owner.createTask(
      { ...TASK_INPUT, title: '冷链补货复盘', type: 'review' },
      nextOperationId('create'),
    )) as { id: string };
    const subtask = (await owner.assign(
      mine.id,
      { agent: 'search-agent', kind: 'inventory' },
      nextOperationId('assign'),
    )) as { id: string };
    await agent.accept(subtask.id, nextOperationId('accept'));

    await owner.sendMessage(
      other.id,
      { body: '蓝色批次需要全程冷藏，温度记录随货。', kind: 'decision' },
      nextOperationId('say'),
    );
    const file = (await owner.uploadBytes(
      { name: 'cold-chain.md', mime: 'text/markdown', taskId: other.id, kind: 'output' },
      new TextEncoder().encode('# 冷链\n'),
      nextOperationId('upload'),
    )) as SpaceFile;

    const adminHits = await owner.search('冷藏');
    assert.deepEqual(adminHits.messages.map(item => item.taskTitle), ['冷链补货复盘']);
    assert.equal(adminHits.messages[0]!.id.length > 0, true);

    const agentHits = await agent.search('冷藏');
    assert.deepEqual(agentHits.messages, [], '未参与的任务不出现在检索结果里');

    assert.deepEqual((await owner.search('cold-chain')).files.map(item => item.id), [file.id]);
    assert.deepEqual((await agent.search('cold-chain')).files, []);
    await expectStatus(agent.search('   '), 400);
  } finally {
    await harness.close();
  }
});

test('团队首页：提问、提醒、待验收与提案各自归位，处理后从队列消失', async () => {
  const harness = await startHarness();
  try {
    const owner = harness.admin;
    const agent = await register(harness, 'home-agent', ['agent']);
    const outsider = await register(harness, 'home-outsider', ['agent']);

    const created = (await owner.createTask(TASK_INPUT, nextOperationId('create'))) as { id: string };
    const subtask = (await owner.assign(
      created.id,
      { agent: 'home-agent', kind: 'inventory' },
      nextOperationId('assign'),
    )) as { id: string };
    await agent.accept(subtask.id, nextOperationId('accept'));

    const question = (await agent.sendMessage(
      created.id,
      { body: '昨天的库存快照能直接用吗？', kind: 'question', payload: { to: 'admin' } },
      nextOperationId('ask'),
    )) as TaskComment;
    await agent.sendMessage(
      created.id,
      { body: '@admin 口径请确认一下', kind: 'comment' },
      nextOperationId('mention'),
    );

    // 待验收状态直接改库，聚焦首页查询本身而不是再走一遍汇总流程。
    const reviewTask = (await owner.createTask(
      { ...TASK_INPUT, title: '补货方案复核' },
      nextOperationId('create'),
    )) as { id: string };
    await harness.db.run(`UPDATE tasks SET status = 'review', updated_at = :at WHERE id = :id`, {
      at: new Date().toISOString(),
      id: reviewTask.id,
    });

    await agent.createTask({ ...TASK_INPUT, title: '自动发现：冷库温度异常' }, nextOperationId('proposal'));

    const home = await owner.home();
    assert.deepEqual(home.totals, { questions: 1, mentions: 1, reviews: 1, proposals: 1 });
    assert.deepEqual(
      home.needsYou.map(item => item.kind).sort(),
      ['mention', 'proposal', 'question', 'review'],
    );
    const questionItem = home.needsYou.find(item => item.kind === 'question');
    assert.ok(questionItem);
    assert.equal(questionItem.taskId, created.id);
    assert.equal(questionItem.id, question.id);
    assert.match(questionItem.title, /库存快照/);
    assert.ok(home.needsYou.every(item => item.taskTitle.length > 0 && item.at.length > 0));

    // 未参与任务、也不是审核人的智能体，队列里只有自己的提案。
    const quiet = await outsider.home();
    assert.deepEqual(quiet.totals, { questions: 0, mentions: 0, reviews: 0, proposals: 0 });
    assert.deepEqual(quiet.needsYou, []);

    await owner.markRead(created.id, nextOperationId('read'));
    await owner.sendMessage(
      created.id,
      { body: '可以用，标明快照时间。', kind: 'answer', replyTo: question.id },
      nextOperationId('answer'),
    );
    const after = await owner.home();
    assert.deepEqual(after.totals, { questions: 0, mentions: 0, reviews: 1, proposals: 1 });
  } finally {
    await harness.close();
  }
});

test('房间未读与提问在 PostgreSQL 上行为一致', async () => {
  if (!process.env.COLLAB_TEST_DATABASE) return;
  const harness = await startHarness();
  try {
    const owner = harness.admin;
    const agent = await register(harness, 'pg-room-agent', ['agent']);
    const created = (await owner.createTask(TASK_INPUT, nextOperationId('create'))) as { id: string };
    const subtask = (await owner.assign(
      created.id,
      { agent: 'pg-room-agent', kind: 'inventory' },
      nextOperationId('assign'),
    )) as { id: string };
    await agent.accept(subtask.id, nextOperationId('accept'));
    await agent.sendMessage(
      created.id,
      { body: '数据口径按哪个？', kind: 'question', payload: { to: 'admin' } },
      nextOperationId('ask'),
    );
    const room = (await owner.room(created.id)) as TaskRoom;
    assert.equal(room.unread.questions, 1);
    assert.equal((await owner.home()).totals.questions, 1);
    await owner.markRead(created.id, nextOperationId('read'));
    assert.equal((await owner.room(created.id)).unread.questions, 0);
    assert.equal((await owner.home()).totals.questions, 1, '已读不等于已回答');
    assert.equal((await owner.home()).totals.mentions, 0);
    assert.equal(((await owner.questions()) as TaskComment[]).length, 1);
  } finally {
    await harness.close();
  }
});
