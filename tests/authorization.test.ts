/**
 * 授权边界。
 *
 * 平台分别判断"谁能看"、"谁能做"和"谁批准"：签名或令牌只证明来源，
 * 不证明权限；消息与知识内容也不能用来扩大权限。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_TOKEN, expectStatus, register, startHarness, TASK_INPUT } from './helpers/harness.ts';
import type { CollabError } from '../src/sdk/client.ts';

const RESULT = { quantity: 10, source: 'fixture', observedAt: '2026-10-28T00:00:00Z' };

test('非管理员不能管理主体、不能读审计', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const agent = await register(harness, 'agent1', ['agent']);

    await expectStatus(
      owner.registerPrincipal({ id: 'x', roles: ['agent'], token: harness.token('x') }, 'owner-register'),
      403,
    );
    await expectStatus(owner.deactivatePrincipal('agent1', 'owner-deactivate'), 403);
    await expectStatus(agent.audit(), 403);
    await expectStatus(owner.audit(), 403);
    assert.equal((await harness.admin.audit()).length > 0, true);
  } finally {
    await harness.close();
  }
});

test('任务对无关主体不可见，子任务对其他智能体不可见', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const inventory = await register(harness, 'inv1', ['agent']);
    const outsider = await register(harness, 'out1', ['agent']);

    const created = await owner.createTask(TASK_INPUT, 'create');
    const sub = (await owner.assign(created.id, { agent: 'inv1', kind: 'inventory' }, 'assign')) as { id: string };

    await expectStatus(outsider.task(created.id), 403);
    await expectStatus(outsider.context(created.id), 403);
    await expectStatus(outsider.accept(sub.id, 'outsider-accept'), 403);
    await expectStatus(outsider.submit(sub.id, RESULT, 'outsider-submit'), 403);

    // 任务列表按可见性过滤。
    assert.equal(((await outsider.tasks()) as unknown[]).length, 0);
    assert.equal(((await inventory.tasks()) as unknown[]).length, 1);
    assert.equal(((await owner.tasks()) as unknown[]).length, 1);
  } finally {
    await harness.close();
  }
});

test('撤销协调委派后，重放旧请求也要重新授权', async () => {
  const harness = await startHarness();
  try {
    const owner = await register(harness, 'owner1', ['owner']);
    const coordinator = await register(harness, 'coord1', ['agent']);
    const created = await owner.createTask(TASK_INPUT, 'create');
    await owner.delegate(created.id, 'coord1', 'delegate');

    await coordinator.assign(created.id, { agent: 'coord1', kind: 'self' }, 'assign');
    await owner.undelegate(created.id, 'coord1', 'undelegate');

    // 同一 operationId 重放：缓存命中，但授权已失效，仍应 403。
    await expectStatus(
      coordinator.assign(created.id, { agent: 'coord1', kind: 'self' }, 'assign'),
      403,
    );
  } finally {
    await harness.close();
  }
});

test('停用主体后令牌立即失效，轮换后可继续使用新令牌', async () => {
  const harness = await startHarness();
  try {
    const agent = await register(harness, 'agent1', ['agent']);
    assert.equal((await agent.me()).id, 'agent1');

    const newToken = harness.token('rotated');
    await harness.admin.request('principals/agent1/rotate-token', {
      body: { token: newToken },
      operationId: 'rotate',
    });
    await expectStatus(agent.me(), 401);
    assert.equal((await harness.client(newToken).me()).id, 'agent1');

    await harness.admin.deactivatePrincipal('agent1', 'deactivate');
    await expectStatus(harness.client(newToken).me(), 401);
    // 停用不能把自己关在门外，也不能重复停用。
    await expectStatus(harness.admin.deactivatePrincipal('admin', 'self'), 409);
  } finally {
    await harness.close();
  }
});

test('缺少或错误令牌返回 401，未知路径返回 404，缺少幂等键返回 400', async () => {
  const harness = await startHarness();
  try {
    const noAuth = await fetch(`${harness.url}/v1/me`);
    assert.equal(noAuth.status, 401);

    const wrongToken = await fetch(`${harness.url}/v1/me`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrongToken.status, 401);

    const unknown = await harness.admin
      .request('does-not-exist')
      .then(() => null, (error: CollabError) => error);
    assert.equal(unknown?.status, 404);

    const noKey = await fetch(`${harness.url}/v1/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(TASK_INPUT),
    });
    assert.equal(noKey.status, 400);

    const badJson = await fetch(`${harness.url}/v1/tasks`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': 'bad-json',
      },
      body: '{',
    });
    assert.equal(badJson.status, 400);
  } finally {
    await harness.close();
  }
});
