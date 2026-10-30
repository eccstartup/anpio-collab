/**
 * 团队邀请码：智能体可以不属于任何人，只凭一个短码进团队干活。
 *
 * 这里钉住的是模型本身，而不是接口能不能调通：
 *  - 邀请码由团队的管理员签发，用一次就作废；
 *  - 进来的主体不挂在任何账号下，也没有任何管理权；
 *  - 邀请它的人能在「我的智能体」里看到它手上没结束的子任务；
 *  - 普通成员签不出邀请码。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ADMIN_TOKEN, startHarness, TASK_INPUT, type Harness } from './helpers/harness.ts';

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

const issueInvite = async (harness: Harness, token = ADMIN_TOKEN) => {
  const response = await post(harness, '/v1/tenants/current/agent-invites', {}, token);
  return { response, body: await json<{ code: string; scopes: string[]; expiresAt: string }>(response.clone()) };
};

test('团队邀请码：智能体自己入队，不挂在任何账号下', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const { response: issued, body: invite } = await issueInvite(harness);
    assert.equal(issued.status, 200, await issued.clone().text());
    assert.match(invite.code, /^T[A-Z0-9]{3}-[A-Z0-9]{4}$/, '邀请码以 T 开头，和批准码区分开');
    assert.ok(invite.scopes.includes('tasks:read'));

    const did = harness.did.identity('solo-agent').did;
    const requested = await post(harness, '/auth/agent/request', {
      did,
      name: '独立巡检 Agent',
      invite: invite.code,
    });
    assert.equal(requested.status, 201, await requested.clone().text());
    const request = await json<{ deviceCode: string; userCode: string; joined: { tenant: string; name: string } }>(
      requested,
    );
    assert.equal(request.userCode, '', '邀请码入队不需要人工批准码');
    assert.equal(request.joined.tenant, 'acme');
    assert.equal(request.joined.name, 'acme', '返回团队名字，方便智能体回话');

    const polled = await post(harness, '/auth/agent/token', { deviceCode: request.deviceCode });
    assert.equal(polled.status, 200, '邀请码入队后第一次轮询就该拿到令牌');
    const agent = await json<{ token: string; principal: { id: string; accountId: string | null } }>(polled);

    const me = await json<{ kind: string; tenantRole: string; accountId: string | null }>(
      await get(harness, '/v1/me', agent.token),
    );
    assert.equal(me.kind, 'agent');
    assert.equal(me.tenantRole, 'member');
    assert.equal(me.accountId, null, '智能体属于团队，不属于某个人的账号');

    const grants = await json<{ agentName: string; agentPrincipalId: string; doing: unknown[] }[]>(
      await get(harness, '/v1/agents', ADMIN_TOKEN),
    );
    assert.equal(grants.length, 1);
    assert.equal(grants[0].agentName, '独立巡检 Agent');
    assert.equal(grants[0].agentPrincipalId, agent.principal.id);
    assert.deepEqual(grants[0].doing, [], '还没接活时没有在做的事');

    // 邀请码只能用一次：换一条 DID 再来就是冲突。
    const reused = await post(harness, '/auth/agent/request', {
      did: harness.did.identity('late-agent').did,
      name: '迟到的 Agent',
      invite: invite.code,
    });
    assert.equal(reused.status, 409, '邀请码不能重复使用');
  } finally {
    await harness.close();
  }
});

test('团队邀请码：邀请人看得到智能体正在做的事', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const { body: invite } = await issueInvite(harness);
    const request = await json<{ deviceCode: string }>(
      await post(harness, '/auth/agent/request', {
        did: harness.did.identity('working-agent').did,
        name: '在工作 Agent',
        invite: invite.code,
      }),
    );
    const agent = await json<{ token: string; principal: { id: string } }>(
      await post(harness, '/auth/agent/token', { deviceCode: request.deviceCode }),
    );

    const created = await harness.admin.createTask(TASK_INPUT, `create:${randomUUID()}`);
    await harness.admin.assign(
      created.id,
      { agent: agent.principal.id, kind: 'inventory' },
      `assign:${randomUUID()}`,
    );

    const grants = await json<{ doing: { taskId: string; title: string; status: string }[] }[]>(
      await get(harness, '/v1/agents', ADMIN_TOKEN),
    );
    assert.equal(grants[0].doing.length, 1, '被邀请的智能体接了活，邀请人应当看得到');
    assert.equal(grants[0].doing[0].taskId, created.id);
    assert.equal(grants[0].doing[0].title, TASK_INPUT.title);
    assert.equal(grants[0].doing[0].status, 'invited');
  } finally {
    await harness.close();
  }
});

test('团队邀请码：普通成员签不出来，过期码不能用', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const memberToken = harness.token('member1');
    await harness.admin.registerPrincipal(
      { id: 'member1', roles: ['owner'], token: memberToken, displayName: '成员' },
      `register:member1`,
    );
    const denied = await post(harness, '/v1/tenants/current/agent-invites', {}, memberToken);
    assert.equal(denied.status, 403, '邀请智能体是管理动作');

    const { body: invite } = await issueInvite(harness);
    await harness.db.run('UPDATE agent_invites SET expires_at = :past WHERE code = :code', {
      past: '2000-01-01T00:00:00.000Z',
      code: invite.code,
    });
    const expired = await post(harness, '/auth/agent/request', {
      did: harness.did.identity('expired-agent').did,
      name: '过期 Agent',
      invite: invite.code,
    });
    assert.equal(expired.status, 409, '过期邀请码必须拒绝');
  } finally {
    await harness.close();
  }
});
