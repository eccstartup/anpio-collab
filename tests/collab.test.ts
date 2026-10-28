/**
 * 协作细化：开放认领、提案接管、评论与提及、心跳。
 *
 * 这些用例关心的是**谁先动**：智能体能不能自己发现工作、自己提出问题，
 * 人能不能接管它的提案；以及"只看自己的事"这条边界在新增入口上是否仍然成立。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectStatus, register, startHarness, TASK_INPUT } from './helpers/harness.ts';

test('能力匹配的智能体自行认领开放子任务，认领后任务对它可见', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const stock = await register(harness, 'stock', ['agent'], { capabilities: ['inventory'] });
    const other = await register(harness, 'other', ['agent'], { capabilities: ['supplier'] });

    const task = await owner.createTask(TASK_INPUT, 'create');
    const offer = await owner.publishOffer(
      task.id,
      { kind: 'inventory', capability: 'inventory', description: '核对 M-100 库存' },
      'offer-1',
    );

    const visibleToStock = (await stock.openOffers()) as { id: string; taskTitle: string }[];
    assert.equal(visibleToStock.length, 1);
    assert.equal(visibleToStock[0]!.id, offer.id);
    assert.equal(visibleToStock[0]!.taskTitle, TASK_INPUT.title);

    // 能力不匹配的看不见；负责人（非智能体）也不在开放池里找活。
    assert.equal(((await other.openOffers()) as unknown[]).length, 0);
    assert.equal(((await owner.openOffers()) as unknown[]).length, 0);
    await expectStatus(other.claimOffer(offer.id, 'other-claim'), 403);

    const claimed = (await stock.claimOffer(offer.id, 'claim-1')) as { subtaskId: string };
    const inbox = (await stock.inbox()) as { id: string; kind: string }[];
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.id, claimed.subtaskId);

    // 认领之后才能读到任务本身；在此之前它只见过 offer。
    const detail = (await stock.task(task.id)) as { task: { id: string } };
    assert.equal(detail.task.id, task.id);

    // 只能认领一次。
    await expectStatus(stock.claimOffer(offer.id, 'claim-2'), 409);
    assert.equal(((await stock.openOffers()) as unknown[]).length, 0);
  } finally {
    await harness.close();
  }
});

test('负责人可以撤回开放子任务，撤回后不再接受认领', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const stock = await register(harness, 'stock', ['agent'], { capabilities: ['inventory'] });
    const task = await owner.createTask(TASK_INPUT, 'create');
    const offer = await owner.publishOffer(task.id, { kind: 'inventory', capability: 'inventory' }, 'offer-1');

    await owner.withdrawOffer(offer.id, 'withdraw-1');
    assert.equal(((await stock.openOffers()) as unknown[]).length, 0);
    await expectStatus(stock.claimOffer(offer.id, 'claim-1'), 409);
  } finally {
    await harness.close();
  }
});

test('智能体可以自己发起提案，由人接管后继续', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'watcher', ['agent']);

    const proposal = await agent.createTask(
      { title: '库存异常：M-200 低于安全线', acceptance: '给出补货建议与来源', type: 'shortage' },
      'proposal-1',
    );
    const proposalDetail = (await agent.task(proposal.id)) as {
      task: { origin: string; adoptedAt: string | null; ownerId: string };
    };
    assert.equal(proposalDetail.task.origin, 'agent');
    assert.equal(proposalDetail.task.adoptedAt, null);
    assert.equal(proposalDetail.task.ownerId, 'watcher');

    // 其他负责人看不到这提案（不在自己的范围里），但管理员/负责人可以接管。
    const adopted = await owner.adopt(proposal.id, 'adopt-1');
    assert.equal(adopted.ownerId, 'owner1');

    const after = (await owner.task(proposal.id)) as {
      task: { ownerId: string; origin: string; adoptedAt: string | null };
      events: { type: string }[];
    };
    assert.equal(after.task.ownerId, 'owner1');
    assert.equal(after.task.origin, 'agent');
    assert.ok(after.task.adoptedAt);
    assert.ok(after.events.some(event => event.type === 'task_adopted'));
    await expectStatus(owner.adopt(proposal.id, 'adopt-2'), 409);
  } finally {
    await harness.close();
  }
});

test('评论共用一条时间线，@ 提及只提醒被点名的人', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const stock = await register(harness, 'stock', ['agent']);
    const outsider = await register(harness, 'outsider', ['agent']);

    const task = await owner.createTask(TASK_INPUT, 'create');
    await owner.assign(task.id, { agent: 'stock', kind: 'inventory' }, 'assign');

    await stock.comment(task.id, '@owner1 库存表里 M-100 少了 20 件，按哪份为准？', 'comment-1');
    await owner.comment(task.id, '@stock 以 10:00 那份为准。', 'comment-2');

    const comments = (await owner.comments(task.id)) as { authorId: string; body: string; authorKind: string }[];
    assert.equal(comments.length, 2);
    assert.equal(comments[0]!.authorKind, 'agent');

    const mentions = (await owner.mentions()) as { mentionId: string; body: string; taskTitle: string }[];
    assert.equal(mentions.length, 1);
    assert.match(mentions[0]!.body, /按哪份为准/);
    assert.equal(mentions[0]!.taskTitle, TASK_INPUT.title);

    await owner.readMention(mentions[0]!.mentionId, 'read-1');
    assert.equal(((await owner.mentions()) as unknown[]).length, 0);

    // 评论区同样受任务可见性约束。
    await expectStatus(outsider.comments(task.id), 403);
    await expectStatus(outsider.comment(task.id, '我也来说两句', 'outsider-comment'), 403);
  } finally {
    await harness.close();
  }
});

test('心跳记录在线状态，负责人能看到智能体表', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const stock = await register(harness, 'stock', ['agent']);

    await stock.heartbeat({ state: 'online', note: '等待分配', client: 'demo-worker/1.0' });
    const board = (await owner.presence()) as {
      principalId: string;
      state: string;
      displayName: string;
      silentSeconds: number | null;
    }[];
    const entry = board.find(item => item.principalId === 'stock');
    assert.ok(entry);
    assert.equal(entry!.state, 'online');
    assert.equal(entry!.silentSeconds !== null && entry!.silentSeconds! < 60, true);

    // 心跳过期（15 分钟）在展示层就降级为 offline。
    await harness.db.run(
      `UPDATE agent_presence SET last_seen_at = :at WHERE principal_id = 'stock'`,
      { at: new Date(Date.now() - 30 * 60_000).toISOString() },
    );
    const stale = ((await owner.presence()) as { principalId: string; state: string }[]).find(
      item => item.principalId === 'stock',
    );
    assert.equal(stale!.state, 'offline');

    // 人不能上报心跳冒充智能体。
    await expectStatus(owner.heartbeat({ state: 'online' }), 403);
  } finally {
    await harness.close();
  }
});

test('认领与评论都进事件流，任务版本随之推进', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const stock = await register(harness, 'stock', ['agent'], { capabilities: ['inventory'] });
    const task = await owner.createTask(TASK_INPUT, 'create');
    const before = (await owner.task(task.id)) as { task: { version: number } };

    const offer = await owner.publishOffer(task.id, { kind: 'inventory', capability: 'inventory' }, 'offer-1');
    await owner.comment(task.id, '开工前先确认口径', 'comment-1');
    await stock.claimOffer(offer.id, 'claim-1');

    const detail = (await owner.task(task.id)) as {
      task: { version: number };
      events: { type: string }[];
    };
    assert.ok(detail.task.version > before.task.version);
    const types = detail.events.map(event => event.type);
    assert.ok(types.includes('offer_published'));
    assert.ok(types.includes('comment_added'));
    assert.ok(types.includes('offer_claimed'));
  } finally {
    await harness.close();
  }
});
