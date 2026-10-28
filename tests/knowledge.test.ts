/**
 * 知识闭环：候选 → 审核 → 发布 → 引用 → 调整范围 → 撤销 → 修订。
 *
 * 验收重点不是"能存下文本"，而是：谁能看到、引用固定在哪个版本、
 * 撤销之后旧引用还查不查得到、历史版本是否保留。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectStatus, register, startHarness, TASK_INPUT, type Harness } from './helpers/harness.ts';
import type { CollabClient } from '../src/sdk/client.ts';

const RESULT = { quantity: 30, source: 'fixture', observedAt: '2026-10-28T00:00:00Z' };
const FUTURE = '2099-01-01T00:00:00Z';

type Agent = { client: CollabClient; token: string };

async function registerAgent(harness: Harness, id: string, roles: string[] = ['agent']): Promise<Agent> {
  const token = harness.token(id);
  await harness.admin.registerPrincipal({ id, roles, token, displayName: id }, `register:${id}`);
  return { client: harness.client(token), token };
}

/** 造一个已验收的任务：一个子任务提交并被接受。 */
async function completedTask(harness: Harness, owner: CollabClient, agent: Agent, agentId: string): Promise<string> {
  const created = await owner.createTask(TASK_INPUT, `create:${agentId}:${Date.now()}`);
  const sub = (await owner.assign(created.id, { agent: agentId, kind: 'inventory' }, `assign:${created.id}`)) as {
    id: string;
  };
  await agent.client.accept(sub.id, `accept:${sub.id}`);
  await agent.client.submit(sub.id, RESULT, `submit:${sub.id}`);
  await owner.summary(created.id, '核心结论：库存不足，需要补货', `summary:${created.id}`);
  await owner.review(created.id, 'accept', '已核对来源', `review:${created.id}`);
  return created.id;
}

test('只有已验收的任务能沉淀经验，且需审核后才能发布', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await registerAgent(harness, 'inv1');
    const created = await owner.createTask(TASK_INPUT, 'create');

    await expectStatus(
      owner.candidate(created.id, { content: '缺料先查库存', conditions: 'M-100' }, 'too-early'),
      409,
    );

    const sub = (await owner.assign(created.id, { agent: 'inv1', kind: 'inventory' }, 'assign')) as { id: string };
    await agent.client.accept(sub.id, 'accept');
    await agent.client.submit(sub.id, RESULT, 'submit');
    await owner.summary(created.id, '库存 30', 'summary');
    await owner.review(created.id, 'accept', '确认', 'review');

    const candidate = (await owner.candidate(
      created.id,
      { content: '缺料时先查库存再查供应商可供量', conditions: '物料 M-100，需求 ≤ 100' },
      'candidate',
    )) as { id: string; state: string; version: number };
    assert.equal(candidate.state, 'candidate');
    assert.equal(candidate.version, 1);

    // 候选不对外可见，只有作者与审核人能看到。
    assert.equal(((await agent.client.knowledge()) as unknown[]).length, 0);
    assert.equal(((await harness.admin.candidates()) as unknown[]).length, 1);
    await expectStatus(agent.client.candidates(), 403);
    await expectStatus(agent.client.publish(candidate.id, { expiresAt: FUTURE }, 'agent-publish'), 403);

    await harness.admin.publish(candidate.id, { expiresAt: FUTURE, audience: ['inv1'] }, 'publish');
    assert.equal(((await agent.client.knowledge()) as unknown[]).length, 1);
    assert.equal(((await owner.knowledge()) as unknown[]).length, 0, '未授权的负责人看不到受限知识');
  } finally {
    await harness.close();
  }
});

test('引用固定版本，范围收窄后不可再用，撤销后仍可追溯历史', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await registerAgent(harness, 'inv1');
    const taskId = await completedTask(harness, owner, agent, 'inv1');

    const candidate = (await owner.candidate(
      taskId,
      { content: '缺料时先查库存快照，再确认供应商可供', conditions: 'M-100' },
      'candidate',
    )) as { id: string };
    await harness.admin.publish(candidate.id, { expiresAt: FUTURE, audience: 'workspace' }, 'publish');

    const second = await owner.createTask({ ...TASK_INPUT, title: '第二次缺料' }, 'second');
    const referenced = (await owner.reference(second.id, candidate.id, 'ref')) as { version: number };
    assert.equal(referenced.version, 1);
    await expectStatus(owner.reference(second.id, candidate.id, 'ref-dup'), 409);

    const evidence = (await owner.evidence(second.id, candidate.id, 1)) as {
      content: string;
      currentState: string;
    };
    assert.match(evidence.content, /库存快照/);
    assert.equal(evidence.currentState, 'published');

    // 范围收窄到只有 inv1：负责人失去引用与证据访问权。
    await harness.admin.setKnowledgeAccess(candidate.id, ['inv1'], 'narrow');
    assert.equal(((await owner.knowledge()) as unknown[]).length, 0);
    await expectStatus(owner.evidence(second.id, candidate.id, 1), 404);
    await expectStatus(owner.reference(second.id, candidate.id, 'ref-after-narrow'), 404);

    // 撤销：不再作为有效经验返回，但历史引用与快照可被授权者审计。
    await harness.admin.setKnowledgeAccess(candidate.id, 'workspace', 'widen');
    await harness.admin.revoke(candidate.id, '证据过期', 'revoke');
    assert.equal(((await agent.client.knowledge()) as unknown[]).length, 0);
    await expectStatus(owner.reference(second.id, candidate.id, 'ref-after-revoke'), 404);
    const revoked = (await owner.evidence(second.id, candidate.id, 1)) as { currentState: string };
    assert.equal(revoked.currentState, 'revoked');

    // 任务详情里仍能看到曾经引用过哪个版本，便于影响分析；
    // 正文取自被钉住的版本，所以经验撤销之后依然读得到当时的依据。
    const detail = (await owner.task(second.id)) as {
      knowledgeRefs: { knowledgeId: string; version: number; content: string; conditions: string }[];
    };
    assert.deepEqual(detail.knowledgeRefs, [
      {
        knowledgeId: candidate.id,
        version: 1,
        content: '缺料时先查库存快照，再确认供应商可供',
        conditions: 'M-100',
      },
    ]);
  } finally {
    await harness.close();
  }
});

test('修订生成新版本，重新审核后旧引用仍指向旧版本', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await registerAgent(harness, 'inv1');
    const taskId = await completedTask(harness, owner, agent, 'inv1');

    const candidate = (await owner.candidate(taskId, { content: '旧建议', conditions: 'M-100' }, 'candidate')) as {
      id: string;
    };
    await harness.admin.publish(candidate.id, { expiresAt: FUTURE, audience: 'workspace' }, 'publish');

    const second = await owner.createTask({ ...TASK_INPUT, title: '第二次' }, 'second');
    await owner.reference(second.id, candidate.id, 'ref');

    const revised = (await harness.admin.revise(
      candidate.id,
      { content: '新建议：先确认在途库存', conditions: 'M-100', reason: '补充在途口径' },
      'revise',
    )) as { version: number; state: string };
    assert.equal(revised.version, 2);
    assert.equal(revised.state, 'candidate');
    // 修订中的内容不对外可见。
    assert.equal(((await owner.knowledge()) as unknown[]).length, 0);

    await harness.admin.publish(candidate.id, { expiresAt: FUTURE, audience: 'workspace' }, 'publish-v2');
    const versions = (await harness.admin.versions(candidate.id)) as { version: number; content: string }[];
    assert.deepEqual(
      versions.map(item => item.version),
      [1, 2],
    );
    assert.equal(versions[1].content, '新建议：先确认在途库存');

    const oldEvidence = (await owner.evidence(second.id, candidate.id, 1)) as { content: string; currentVersion: number };
    assert.equal(oldEvidence.content, '旧建议');
    assert.equal(oldEvidence.currentVersion, 2);
  } finally {
    await harness.close();
  }
});

test('过期经验不再返回，检索预算可截断正文', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await registerAgent(harness, 'inv1');
    const taskId = await completedTask(harness, owner, agent, 'inv1');

    const candidate = (await owner.candidate(
      taskId,
      { content: '缺料处理流程：核对库存快照、确认供应商可供量与交期，再决定是否补货。', conditions: '物料 M-100 缺料' },
      'candidate',
    )) as { id: string };
    await harness.admin.publish(candidate.id, { expiresAt: FUTURE, audience: 'workspace' }, 'publish');

    const search = (await owner.searchKnowledge('缺料', 5, 400)) as { items: unknown[]; budgetUnit: string };
    assert.ok(search.items.length > 0);
    assert.equal(search.budgetUnit, 'characters');

    const tiny = (await owner.searchKnowledge('缺料', 5, 256)) as {
      items: { contentTruncated: boolean }[];
      truncated: boolean;
    };
    assert.equal(tiny.truncated, true);
    assert.ok(tiny.items.every(item => item.contentTruncated));

    // 手动把有效期改到过去，模拟自然过期。
    await harness.db.run('UPDATE knowledge SET expires_at = :at WHERE id = :id', {
      at: '2000-01-01T00:00:00Z',
      id: candidate.id,
    });
    assert.equal(((await owner.knowledge()) as unknown[]).length, 0);
    await expectStatus(owner.knowledgeEvidence(candidate.id), 404);
  } finally {
    await harness.close();
  }
});
