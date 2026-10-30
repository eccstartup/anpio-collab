/**
 * 租户、邮箱登录与 Agent 授权。
 *
 * 这里不测"接口能不能调通"，而是把几条容易含混的语义钉住：
 *  - 第一次用邮箱登录会得到个人组织，本人是所有者；
 *  - 邀请链接同时完成"验证邮箱 + 入组 + 登录"，且只能用一次；
 *  - 邮箱不匹配时拒绝入组（链接被转发也不泄露组织）；
 *  - 管理员不能改自己、不能造第二个所有者；
 *  - Agent 必须先申请、由已登录的人批准，才拿得到令牌；撤销后立即失效。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate } from '../src/platform/db/schema.ts';
import { ADMIN_TOKEN, emailLogin, startHarness, type Harness } from './helpers/harness.ts';

const post = (harness: Harness, path: string, body: unknown, token?: string) =>
  fetch(`${harness.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const get = (harness: Harness, path: string, token: string) =>
  fetch(`${harness.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

const json = async <T = any>(response: Response): Promise<T> => (await response.json()) as T;

/** 从开发模式返回的链接里取出票据。 */
const ticketOf = (link: string): string => {
  const url = new URL(link);
  const ticket = url.searchParams.get('ticket');
  assert.ok(ticket, `链接里没有 ticket: ${link}`);
  return ticket;
};


test('邮箱首次登录：自动创建个人组织，本人是所有者', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const session = await emailLogin(harness, 'alice@example.com');
    assert.equal(session.tenant.role, 'owner');

    const me = await json(await get(harness, '/v1/me', session.token));
    assert.equal(me.tenantRole, 'owner');
    assert.ok(me.accountId, '登录后应绑定全局账号');
    assert.ok(me.roles.includes('admin'), '所有者应能管理组织');

    const tenants = await json<{ id: string; name: string; role: string }[]>(
      await get(harness, '/v1/me/tenants', session.token),
    );
    assert.equal(tenants.length, 1);
    assert.equal(tenants[0].role, 'owner');
    assert.match(tenants[0].name, /的组织$/);
  } finally {
    await harness.close();
  }
});

test('新建团队：创建者是所有者，旧会话作废，团队之间互相隔离', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const session = await emailLogin(harness, 'carol@example.com');
    const created = await post(harness, '/v1/tenants', { name: '供应链小组' }, session.token);
    assert.equal(created.status, 200, await created.clone().text());
    const result = await json<{ token: string; tenant: { id: string; name: string; role: string } }>(created);
    assert.equal(result.tenant.name, '供应链小组');
    assert.equal(result.tenant.role, 'owner');
    assert.notEqual(result.tenant.id, session.tenant.id);

    const me = await json<{ workspace: string; tenantRole: string }>(await get(harness, '/v1/me', result.token));
    assert.equal(me.workspace, result.tenant.id);
    assert.equal(me.tenantRole, 'owner');

    // 换团队后旧令牌立即失效，避免同一浏览器里同时存在两条会话。
    const stale = await get(harness, '/v1/me', session.token);
    assert.equal(stale.status, 401);

    // 新团队是空的：任务不会从上一个团队跟过来。
    const tasks = await json<unknown[]>(await get(harness, '/v1/tasks', result.token));
    assert.deepEqual(tasks, []);

    const tenants = await json<Array<{ id: string; role: string }>>(
      await get(harness, '/v1/me/tenants', result.token),
    );
    assert.equal(tenants.length, 2);
    assert.deepEqual(tenants.map(item => item.role), ['owner', 'owner']);
  } finally {
    await harness.close();
  }
});

test('邀请：邮件链接一次完成验证、入组与登录，且只能用一次', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const invited = await post(
      harness,
      '/v1/tenants/current/invites',
      { email: 'bob@example.com', role: 'member' },
      ADMIN_TOKEN,
    );
    assert.equal(invited.status, 200, await invited.clone().text());
    const invite = await json<{ id: string; link: string; role: string }>(invited);
    assert.equal(invite.role, 'member');
    assert.ok(invite.link, '开发模式应返回可复制的邀请链接');

    const ticket = ticketOf(invite.link);
    const first = await post(harness, '/auth/email/verify', { ticket });
    assert.equal(first.status, 200, await first.clone().text());
    const session = await json<{ token: string; joinedTenant: boolean; tenant: { role: string } }>(first);
    assert.equal(session.joinedTenant, true);
    assert.equal(session.tenant.role, 'member');

    const members = await json<{ displayName: string; tenantRole: string; email: string | null }[]>(
      await get(harness, '/v1/tenants/current/members', ADMIN_TOKEN),
    );
    assert.ok(members.some(item => item.email === 'bob@example.com' && item.tenantRole === 'member'));

    const second = await post(harness, '/auth/email/verify', { ticket });
    assert.equal(second.status, 409, '同一张票不能登录两次');
  } finally {
    await harness.close();
  }
});

test('邀请：邮箱与邀请不一致时拒绝入组', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const invited = await post(
      harness,
      '/v1/tenants/current/invites',
      { email: 'carol@example.com', role: 'member' },
      ADMIN_TOKEN,
    );
    const invite = await json<{ id: string }>(invited);

    const account = await harness.app.accounts.ensure('email', 'someone-else@example.com', { verified: true });
    await assert.rejects(
      harness.app.tenants.acceptInvite(invite.id, account, 'someone-else@example.com'),
      /另一个邮箱/,
    );
  } finally {
    await harness.close();
  }
});

test('成员角色：不能改自己、不能邀请第二个所有者、可转让所有权', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const self = await post(harness, '/v1/members/admin/role', { role: 'member' }, ADMIN_TOKEN);
    assert.equal(self.status, 409);

    const secondOwner = await post(
      harness,
      '/v1/tenants/current/invites',
      { email: 'owner2@example.com', role: 'owner' },
      ADMIN_TOKEN,
    );
    assert.equal(secondOwner.status, 409);

    // 造一个管理员，再由所有者把所有权转给他。
    const invite = await post(
      harness,
      '/v1/tenants/current/invites',
      { email: 'dave@example.com', role: 'admin' },
      ADMIN_TOKEN,
    );
    const link = (await json<{ link: string }>(invite)).link;
    const session = await json<{ token: string; principal: { id: string } }>(
      await post(harness, '/auth/email/verify', { ticket: ticketOf(link) }),
    );

    const transfer = await post(harness, `/v1/members/${session.principal.id}/role`, { role: 'owner' }, ADMIN_TOKEN);
    assert.equal(transfer.status, 200, await transfer.clone().text());

    const oldOwner = await json<{ tenantRole: string }>(await get(harness, '/v1/me', ADMIN_TOKEN));
    assert.equal(oldOwner.tenantRole, 'admin', '转让后原所有者降为管理员');

    const newOwner = await json<{ tenantRole: string }>(await get(harness, '/v1/me', session.token));
    assert.equal(newOwner.tenantRole, 'owner');

    // 新所有者也不能改自己的角色（想降级必须先转让）。
    const again = await post(harness, `/v1/members/${session.principal.id}/role`, { role: 'owner' }, session.token);
    assert.equal(again.status, 409);
  } finally {
    await harness.close();
  }
});

test('租户隔离：两个组织的任务互不可见', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const bob = await emailLogin(harness, 'bob@example.com');
    assert.notEqual(alice.tenant.id, bob.tenant.id);

    const created = await post(
      harness,
      '/v1/tasks',
      {
        title: '只有 alice 能看到的任务',
        type: 'shortage-analysis',
        goal: '验证租户隔离',
        acceptance: 'bob 看不到',
        input: { material: 'M-1', quantity: 1 },
      },
      alice.token,
    );
    assert.equal(created.status, 200, await created.clone().text());

    const aliceTasks = await json<unknown[]>(await get(harness, '/v1/tasks', alice.token));
    const bobTasks = await json<unknown[]>(await get(harness, '/v1/tasks', bob.token));
    assert.equal(aliceTasks.length, 1);
    assert.equal(bobTasks.length, 0);

    const bobMembers = await get(harness, '/v1/tenants/current/members', bob.token);
    assert.equal(bobMembers.status, 200, 'bob 在自己的组织里也是所有者');
  } finally {
    await harness.close();
  }
});

test('Agent 授权：申请 → 人批准 → 换成令牌 → 撤销后立即失效', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const owner = await emailLogin(harness, 'owner@example.com');

    const requested = await post(harness, '/auth/agent/request', {
      did: harness.did.identity('inventory-agent').did,
      name: '库存查询 Agent',
      capabilities: ['inventory'],
    });
    assert.equal(requested.status, 201);
    const request = await json<{ deviceCode: string; userCode: string }>(requested);
    assert.match(request.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const pending = await post(harness, '/auth/agent/token', { deviceCode: request.deviceCode });
    assert.equal(pending.status, 202, '未批准时只能拿到 pending');

    const unauthenticated = await post(harness, '/v1/agents/approve', { userCode: request.userCode });
    assert.equal(unauthenticated.status, 401, '批准必须发生在已登录会话里');

    const approved = await post(
      harness,
      '/v1/agents/approve',
      { userCode: request.userCode, scopes: ['tasks:read', 'tasks:submit'] },
      owner.token,
    );
    assert.equal(approved.status, 200, await approved.clone().text());

    const polled = await post(harness, '/auth/agent/token', { deviceCode: request.deviceCode });
    assert.equal(polled.status, 200, await polled.clone().text());
    const agent = await json<{ token: string; principal: { kind: string; id: string }; scopes: string[] }>(polled);
    assert.equal(agent.principal.kind, 'agent');
    assert.deepEqual(agent.scopes, ['tasks:read', 'tasks:submit']);

    const me = await json<{ scopes: string[]; kind: string; tenantRole: string }>(
      await get(harness, '/v1/me', agent.token),
    );
    assert.equal(me.kind, 'agent');
    assert.equal(me.tenantRole, 'member');
    assert.deepEqual(me.scopes, ['tasks:read', 'tasks:submit']);

    const grants = await json<{ id: string; agentName: string; status: string }[]>(
      await get(harness, '/v1/agents', owner.token),
    );
    assert.equal(grants.length, 1);
    assert.equal(grants[0].agentName, '库存查询 Agent');

    // scopes 不是写给界面看的：没勾「读经验库」，就真的读不到。
    const knowledge = await get(harness, '/v1/knowledge', agent.token);
    assert.equal(knowledge.status, 403, '未授权的范围必须拒绝');

    const pollAgain = await post(harness, '/auth/agent/token', { deviceCode: request.deviceCode });
    assert.equal(pollAgain.status, 409, 'deviceCode 只能换一次令牌');

    const revoked = await post(harness, `/v1/agents/${grants[0].id}/revoke`, {}, owner.token);
    assert.equal(revoked.status, 200, await revoked.clone().text());

    const afterRevoke = await get(harness, '/v1/me', agent.token);
    assert.equal(afterRevoke.status, 401, '撤销后会话立即失效');

    const reused = await post(harness, '/auth/agent/token', { deviceCode: request.deviceCode });
    assert.equal(reused.status, 409, 'deviceCode 只能换一次令牌');
  } finally {
    await harness.close();
  }
});

test('Agent 授权：共用账号模式不会新建主体，撤销时也不停用本人', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const owner = await emailLogin(harness, 'owner@example.com');
    const requested = await post(harness, '/auth/agent/request', {
      did: harness.did.identity('shared-agent').did,
      name: '共用账号 Agent',
    });
    const request = await json<{ deviceCode: string; userCode: string }>(requested);

    const approved = await json<{ principalId: string; mode: string }>(
      await post(
        harness,
        '/v1/agents/approve',
        { userCode: request.userCode, mode: 'link' },
        owner.token,
      ),
    );
    assert.equal(approved.mode, 'link');
    assert.equal(approved.principalId, owner.principal.id);

    const polled = await post(harness, '/auth/agent/token', { deviceCode: request.deviceCode });
    const agent = await json<{ token: string; principal: { id: string } }>(polled);
    assert.equal(agent.principal.id, owner.principal.id);

    const grants = await json<{ id: string }[]>(await get(harness, '/v1/agents', owner.token));
    const revoked = await post(harness, `/v1/agents/${grants[0].id}/revoke`, {}, owner.token);
    assert.equal(revoked.status, 200);

    const stillMe = await get(harness, '/v1/me', owner.token);
    assert.equal(stillMe.status, 200, '撤销共用账号的授权不能把本人踢出去');

    const agentGone = await get(harness, '/v1/me', agent.token);
    assert.equal(agentGone.status, 401);
  } finally {
    await harness.close();
  }
});

test('Agent 授权：撤销后同一个 DID 重新申请，复用原主体而不是报冲突', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const owner = await emailLogin(harness, 'owner@example.com');
    const did = harness.did.identity('rerun-agent').did;

    const first = await json<{ deviceCode: string; userCode: string }>(
      await post(harness, '/auth/agent/request', { did, name: '巡检 Agent' }),
    );
    const approvedFirst = await json<{ principalId: string }>(
      await post(harness, '/v1/agents/approve', { userCode: first.userCode }, owner.token),
    );
    const tokenFirst = await json<{ token: string }>(
      await post(harness, '/auth/agent/token', { deviceCode: first.deviceCode }),
    );

    const grants = await json<{ id: string }[]>(await get(harness, '/v1/agents', owner.token));
    await post(harness, `/v1/agents/${grants[0].id}/revoke`, {}, owner.token);
    assert.equal((await get(harness, '/v1/me', tokenFirst.token)).status, 401);

    // 智能体重启后拿同一个 DID 再来一次：应当复用主体，而不是 409 卡死。
    const second = await json<{ deviceCode: string; userCode: string }>(
      await post(harness, '/auth/agent/request', { did, name: '巡检 Agent v2' }),
    );
    const approvedSecondRes = await post(harness, '/v1/agents/approve', { userCode: second.userCode }, owner.token);
    assert.equal(approvedSecondRes.status, 200, await approvedSecondRes.clone().text());
    const approvedSecond = await json<{ principalId: string }>(approvedSecondRes);
    assert.equal(approvedSecond.principalId, approvedFirst.principalId, '同一个 DID 复用同一个主体');

    const members = await json<{ principalId: string; kind: string; displayName: string }[]>(
      await get(harness, '/v1/tenants/current/members', owner.token),
    );
    assert.equal(members.filter(item => item.kind === 'agent').length, 1, '不能造出第二个智能体主体');
    assert.equal(members.find(item => item.principalId === approvedSecond.principalId)?.displayName, '巡检 Agent v2');

    const tokenSecond = await json<{ token: string }>(
      await post(harness, '/auth/agent/token', { deviceCode: second.deviceCode }),
    );
    assert.equal((await get(harness, '/v1/me', tokenSecond.token)).status, 200, '重新批准后应拿到新令牌');
  } finally {
    await harness.close();
  }
});

test('成员角色：智能体不能被设成管理员，更不能被转让所有权', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const owner = await emailLogin(harness, 'owner@example.com');
    const request = await json<{ userCode: string }>(
      await post(harness, '/auth/agent/request', {
        did: harness.did.identity('promote-agent').did,
        name: '想当管理员的 Agent',
      }),
    );
    const approved = await json<{ principalId: string }>(
      await post(harness, '/v1/agents/approve', { userCode: request.userCode }, owner.token),
    );

    const asAdmin = await post(harness, `/v1/members/${approved.principalId}/role`, { role: 'admin' }, owner.token);
    assert.equal(asAdmin.status, 409, '智能体不能拥有组织管理角色');

    const asOwner = await post(harness, `/v1/members/${approved.principalId}/role`, { role: 'owner' }, owner.token);
    assert.equal(asOwner.status, 409, '转让所有权也必须先被这条拦住');

    const me = await json<{ tenantRole: string }>(await get(harness, '/v1/me', owner.token));
    assert.equal(me.tenantRole, 'owner', '拦截后所有者仍是本人');
  } finally {
    await harness.close();
  }
});

test('升级回填：老库里没有所有者时，把最早的管理员补成所有者', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    // 模拟 v3 迁移刚给 principals 补了 tenant_role、默认值还是 member 的状态。
    await harness.db.transaction(async tx => {
      await tx.run(`UPDATE principals SET tenant_role = 'member'`);
    });
    await migrate(harness.db, harness.app.ctx.now);

    const row = await harness.db.read.one<{ tenant_role: string }>(
      `SELECT tenant_role FROM principals WHERE id = 'admin'`,
    );
    assert.equal(row?.tenant_role, 'owner', '老管理员应被补成所有者，否则升级后没人能管成员');
  } finally {
    await harness.close();
  }
});
