/**
 * 任务归属与个人经验分享。
 *
 * 这里钉住几条边界：
 *  - 个人任务只落在个人空间，团队看不到；
 *  - 团队任务必须由目标团队的正常成员创建，访客和智能体不能指定归属；
 *  - 个人经验发布后可以分享给多个团队，但管理权永远留在来源空间；
 *  - 团队经验不能分享出去，历史证据只认分享是否仍在。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { CollabClient } from '../src/sdk/client.ts';
import { hashToken } from '../src/platform/services/principals.ts';
import {
  emailLogin,
  expectStatus,
  startHarness,
  TASK_INPUT,
  type Harness,
} from './helpers/harness.ts';

const FUTURE = '2099-01-01T00:00:00Z';
const RESULT = { quantity: 30, source: 'fixture', observedAt: '2026-10-28T00:00:00Z' };

const post = (harness: Harness, path: string, body: unknown, token: string) =>
  fetch(`${harness.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

const get = (harness: Harness, path: string, token: string) =>
  fetch(`${harness.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

const json = async <T = any>(response: Response): Promise<T> => (await response.json()) as T;

async function createTeam(harness: Harness, token: string, name: string) {
  const response = await post(harness, '/v1/tenants', { name }, token);
  assert.equal(response.status, 200, await response.clone().text());
  return json<{ token: string; tenant: { id: string; name: string; role: string } }>(response);
}

async function switchTo(harness: Harness, token: string, tenantId: string) {
  const response = await post(harness, '/v1/me/switch', { tenantId }, token);
  assert.equal(response.status, 200, await response.clone().text());
  return json<{ token: string; tenant: { id: string; role: string } }>(response);
}

async function registerAgent(harness: Harness, token: string, id: string) {
  const agentToken = harness.token(id);
  const response = await post(
    harness,
    '/v1/principals',
    { id, roles: ['agent'], token: agentToken, displayName: id },
    token,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return { client: harness.client(agentToken), token: agentToken };
}

/** 直接把某个账号加进团队，省去邀请登录把已有会话顶掉。 */
async function addMembership(
  harness: Harness,
  workspace: string,
  accountId: string,
  tenantRole: 'guest' | 'member',
): Promise<string> {
  const id = `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await harness.db.run(
    `INSERT INTO principals(id, workspace, roles, token_hash, did, kind, handle, display_name,
                            avatar, title, bio, description, capabilities, active, created_at, account_id, tenant_role)
     VALUES(:id, :workspace, :roles, :hash, NULL, 'human', NULL, :name,
            '', '', '', '', '[]', 1, :at, :account, :role)`,
    {
      id,
      workspace,
      roles: JSON.stringify(tenantRole === 'guest' ? ['reviewer'] : ['owner', 'reviewer']),
      hash: hashToken(harness.token('unused')),
      name: '外部成员',
      at: new Date().toISOString(),
      account: accountId,
      role: tenantRole,
    },
  );
  return id;
}

async function completedTask(
  owner: CollabClient,
  agent: { client: CollabClient },
  agentId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; workspace?: string }> {
  const created = await owner.createTask({ ...TASK_INPUT, ...body }, `create:${agentId}:${randomUUID()}`);
  const sub = (await owner.assign(created.id, { agent: agentId, kind: 'inventory' }, `assign:${created.id}`)) as {
    id: string;
  };
  await agent.client.accept(sub.id, `accept:${sub.id}`);
  await agent.client.submit(sub.id, RESULT, `submit:${sub.id}`);
  await owner.summary(created.id, '核心结论：库存不足', `summary:${created.id}`);
  await owner.review(created.id, 'accept', '已核对', `review:${created.id}`);
  return created;
}

test('个人任务落在个人空间，团队任务落在指定团队', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const personalId = alice.tenant.id;
    let token = alice.token;

    const teamA = await createTeam(harness, token, '供应链小组');
    const teamAId = teamA.tenant.id;
    token = teamA.token;

    // 团队里创建：显式选择团队，任务落在团队。
    const teamTask = await harness.client(token).createTask(
      { ...TASK_INPUT, ownership: 'team', teamId: teamAId },
      'team-task',
    );
    assert.equal(teamTask.workspace, teamAId);

    // 不传归属的旧请求仍留在当前团队。
    const legacy = await harness.client(token).createTask({ ...TASK_INPUT, title: '旧请求' }, 'legacy-task');
    assert.equal(legacy.workspace, teamAId);

    // 切回个人空间：个人任务只出现在这里，团队列表看不到。
    token = (await switchTo(harness, token, personalId)).token;
    const personal = await harness.client(token).createTask(
      { ...TASK_INPUT, ownership: 'personal' },
      'personal-task',
    );
    assert.equal(personal.workspace, personalId);
    const personalList = (await harness.client(token).tasks()) as { id: string }[];
    assert.ok(personalList.some(item => item.id === personal.id));
    assert.ok(!personalList.some(item => item.id === teamTask.id));

    token = (await switchTo(harness, token, teamAId)).token;
    const teamList = (await harness.client(token).tasks()) as { id: string }[];
    assert.ok(teamList.some(item => item.id === teamTask.id));
    assert.ok(teamList.some(item => item.id === legacy.id));
    assert.ok(!teamList.some(item => item.id === personal.id), '团队不该看到别人的个人任务');

    // 非成员必须被拒绝。
    const bob = await emailLogin(harness, 'bob@example.com');
    const stranger = harness.client(bob.token).createTask(
      { ...TASK_INPUT, ownership: 'team', teamId: teamAId },
      'stranger-team-task',
    );
    await expectStatus(stranger, 403);

    // 目标团队的访客也不能建团队任务；访客的个人空间仍属于自己，
    // 所以这里只钉住团队归属。
    const carol = await emailLogin(harness, 'carol@example.com');
    const carolMe = await json<{ accountId: string }>(await get(harness, '/v1/me', carol.token));
    await addMembership(harness, teamAId, carolMe.accountId, 'guest');
    await expectStatus(
      harness.client(carol.token).createTask(
        { ...TASK_INPUT, ownership: 'team', teamId: teamAId },
        'guest-team-task',
      ),
      403,
    );

    // 智能体不能自己指定归属。
    const agent = await registerAgent(harness, token, 'team-agent');
    await expectStatus(
      agent.client.createTask(
        { ...TASK_INPUT, ownership: 'team', teamId: teamAId },
        'agent-team-task',
      ),
      403,
    );
  } finally {
    await harness.close();
  }
});

test('个人空间按需创建：多次任务复用同一个空间，幂等重放不重复建租户', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const firstPersonal = alice.tenant.id;
    let token = (await createTeam(harness, alice.token, '临时团队')).token;

    // 模拟 DID 首次登录的账号还没有个人空间：删掉邮箱登录建的那个。
    await harness.db.run('DELETE FROM anp_sessions WHERE principal_id = :id', { id: alice.principal.id });
    await harness.db.run('DELETE FROM principals WHERE id = :id', { id: alice.principal.id });
    await harness.db.run('DELETE FROM tenants WHERE id = :id', { id: firstPersonal });

    const client = harness.client(token);
    const first = await client.createTask({ ...TASK_INPUT, ownership: 'personal' }, 'personal-1');
    assert.ok(first.workspace);
    assert.notEqual(first.workspace, alice.tenant.id);
    const second = await client.createTask(
      { ...TASK_INPUT, title: '第二次个人任务', ownership: 'personal' },
      'personal-2',
    );
    assert.equal(second.workspace, first.workspace, '同一账号只应有一个个人空间');

    const replay = await client.createTask({ ...TASK_INPUT, ownership: 'personal' }, 'personal-1');
    assert.equal(replay.id, first.id, '同一 Idempotency-Key 应返回同一个任务');
    assert.equal(replay.workspace, first.workspace);

    const tenants = await json<{ id: string }[]>(await get(harness, '/v1/me/tenants', token));
    assert.equal(tenants.length, 2, '一个团队 + 一个个人空间');
  } finally {
    await harness.close();
  }
});

test('个人经验分享给团队：目标可见、管理权留在来源空间、取消分享后收回', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const personalId = alice.tenant.id;
    let token = alice.token;

    const teamA = await createTeam(harness, token, '团队 A');
    const teamAId = teamA.tenant.id;
    token = teamA.token;
    const teamB = await createTeam(harness, token, '团队 B');
    const teamBId = teamB.tenant.id;
    token = teamB.token;
    const aliceMe = await json<{ accountId: string }>(await get(harness, '/v1/me', token));
    token = (await switchTo(harness, token, personalId)).token;

    // 一个和 alice 无关的团队 C，以及一个 alice 只是访客的团队 D。
    const bob = await emailLogin(harness, 'bob@example.com');
    let bobToken = (await createTeam(harness, bob.token, '团队 D')).token;
    const teamDId = (await json<{ workspace: string }>(await get(harness, '/v1/me', bobToken))).workspace;
    bobToken = (await createTeam(harness, bobToken, '团队 C')).token;
    const teamCId = (await json<{ workspace: string }>(await get(harness, '/v1/me', bobToken))).workspace;

    // alice 在 D 里只是访客。
    await addMembership(harness, teamDId, aliceMe.accountId, 'guest');

    // 在个人空间完成一个任务并发布经验。
    const agent = await registerAgent(harness, token, 'personal-agent');
    const task = await completedTask(harness.client(token), agent, 'personal-agent', { ownership: 'personal' });
    const candidate = await harness.client(token).candidate(
      task.id,
      { content: '个人经验：缺料先查在途库存', conditions: '物料 M-100' },
      'candidate',
    );
    await harness.client(token).publish(candidate.id, { expiresAt: FUTURE }, 'publish');

    // 非法目标整单失败。
    await expectStatus(
      harness.client(token).shareKnowledge(candidate.id, ['no-such-team'], 'share-unknown'),
      400,
    );
    await expectStatus(
      harness.client(token).shareKnowledge(candidate.id, [bob.tenant.id], 'share-personal'),
      400,
    );
    await expectStatus(
      harness.client(token).shareKnowledge(candidate.id, [teamAId, teamAId], 'share-dup'),
      400,
    );
    await expectStatus(
      harness.client(token).shareKnowledge(candidate.id, [teamDId], 'share-guest'),
      403,
    );

    await harness.client(token).shareKnowledge(candidate.id, [teamAId, teamBId], 'share-valid');

    token = (await switchTo(harness, token, teamAId)).token;
    const a = harness.client(token);
    const aItem = ((await a.knowledge()) as { id: string; sourcePersonal?: boolean; authorName?: string; sharedTeams?: unknown[] }[])
      .find(item => item.id === candidate.id);
    assert.ok(aItem, '团队 A 应能看到分享进来的个人经验');
    assert.equal(aItem.sourcePersonal, true);
    assert.equal(aItem.authorName, 'alice');
    assert.equal(aItem.sharedTeams, undefined, '目标团队不应看到来源的分享清单');
    assert.ok(((await a.searchKnowledge('在途', 5, 400)) as { items: { id: string }[] }).items.some(item => item.id === candidate.id));

    // 目标团队的管理员也拿不到管理入口：404，而不是 403。
    await expectStatus(a.publish(candidate.id, { expiresAt: FUTURE }, 'a-publish'), 404);
    await expectStatus(a.revise(candidate.id, { content: '改不了', conditions: 'x', reason: '越权' }, 'a-revise'), 404);
    await expectStatus(a.versions(candidate.id), 404);
    await expectStatus(a.knowledgeShares(candidate.id), 404);
    await expectStatus(a.shareKnowledge(candidate.id, [teamAId], 'a-share'), 404);

    // 团队 B 同样可见。
    token = (await switchTo(harness, token, teamBId)).token;
    assert.ok(((await harness.client(token).knowledge()) as { id: string }[]).some(item => item.id === candidate.id));

    // 无关团队 C 看不到。
    assert.ok(!((await harness.client(bobToken).knowledge()) as { id: string }[]).some(item => item.id === candidate.id));
    assert.equal(teamCId, (await json<{ workspace: string }>(await get(harness, '/v1/me', bobToken))).workspace);

    // 在团队 A 里引用这条经验，再回到个人空间修订为候选。
    token = (await switchTo(harness, token, teamAId)).token;
    const aClient = harness.client(token);
    const aTask = await aClient.createTask({ ...TASK_INPUT, title: '团队 A 引用任务' }, 'a-ref-task');
    await aClient.reference(aTask.id, candidate.id, 'a-ref');
    const pinned = (await aClient.evidence(aTask.id, candidate.id, 1)) as { content: string };
    assert.match(pinned.content, /在途库存/);

    token = (await switchTo(harness, token, personalId)).token;
    const personal = harness.client(token);
    await personal.revise(
      candidate.id,
      { content: '修订后的内容', conditions: '物料 M-100', reason: '补充口径' },
      'personal-revise',
    );

    // 修订后不再出现在目标团队列表里，但已钉住的证据仍可读。
    token = (await switchTo(harness, token, teamAId)).token;
    const afterRevise = harness.client(token);
    assert.ok(!((await afterRevise.knowledge()) as { id: string }[]).some(item => item.id === candidate.id));
    const evidence = (await afterRevise.evidence(aTask.id, candidate.id, 1)) as { content: string };
    assert.match(evidence.content, /在途库存/);

    // 取消分享（候选状态允许纯撤回），历史证据立即不可见。
    token = (await switchTo(harness, token, personalId)).token;
    await harness.client(token).shareKnowledge(candidate.id, [], 'unshare');
    token = (await switchTo(harness, token, teamAId)).token;
    await expectStatus(harness.client(token).evidence(aTask.id, candidate.id, 1), 404);
  } finally {
    await harness.close();
  }
});

test('团队经验不能分享到团队之外', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    let token = (await createTeam(harness, alice.token, '团队 E')).token;
    const teamId = (await json<{ workspace: string }>(await get(harness, '/v1/me', token))).workspace;
    const agent = await registerAgent(harness, token, 'team-e-agent');
    const task = await completedTask(harness.client(token), agent, 'team-e-agent', {});
    const candidate = await harness.client(token).candidate(
      task.id,
      { content: '团队内经验', conditions: '仅限团队 E' },
      'candidate',
    );
    await harness.client(token).publish(candidate.id, { expiresAt: FUTURE }, 'publish');
    await expectStatus(
      harness.client(token).shareKnowledge(candidate.id, [teamId], 'team-share'),
      403,
    );
  } finally {
    await harness.close();
  }
});

test('智能体只看到当前租户，不能切换或新建团队；人的团队列表不含智能体加入的团队', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const personalId = alice.tenant.id;
    const aliceMe = await json<{ accountId: string }>(await get(harness, '/v1/me', alice.token));

    const bob = await emailLogin(harness, 'bob@example.com');
    const bobToken = (await createTeam(harness, bob.token, '智能体团队')).token;
    const agentTeamId = (await json<{ workspace: string }>(await get(harness, '/v1/me', bobToken))).workspace;

    // 在 bob 的团队里放一个绑定 alice 账号的智能体。
    const agentToken = harness.token('bound-agent');
    await harness.db.run(
      `INSERT INTO principals(id, workspace, roles, token_hash, did, kind, handle, display_name,
                              avatar, title, bio, description, capabilities, active, created_at, account_id, tenant_role)
       VALUES(:id, :workspace, '["agent"]', :hash, NULL, 'agent', NULL, '绑定智能体',
              '', '', '', '', '[]', 1, :at, :account, 'member')`,
      {
        id: 'bound-agent',
        workspace: agentTeamId,
        hash: hashToken(agentToken),
        at: new Date().toISOString(),
        account: aliceMe.accountId,
      },
    );

    const agentTenants = await json<{ id: string }[]>(await get(harness, '/v1/me/tenants', agentToken));
    assert.deepEqual(agentTenants.map(item => item.id), [agentTeamId], '智能体只该看到自己所在的租户');

    const switchRes = await post(harness, '/v1/me/switch', { tenantId: personalId }, agentToken);
    assert.equal(switchRes.status, 403);
    const createRes = await post(harness, '/v1/tenants', { name: '智能体的团队' }, agentToken);
    assert.equal(createRes.status, 403);

    // alice 的人类成员列表不包含「智能体加入的团队」。
    const aliceTenants = await json<{ id: string }[]>(await get(harness, '/v1/me/tenants', alice.token));
    assert.deepEqual(aliceTenants.map(item => item.id), [personalId]);
  } finally {
    await harness.close();
  }
});

test('schema：分享表存在，一个账号不能有两个个人空间', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    await harness.db.read.all('SELECT 1 AS present FROM knowledge_shares LIMIT 1');
    const alice = await emailLogin(harness, 'alice@example.com');
    const me = await json<{ accountId: string }>(await get(harness, '/v1/me', alice.token));
    await assert.rejects(
      harness.db.run(
        `INSERT INTO tenants(id, name, status, personal, created_by, created_at)
         VALUES(:id, '第二个个人空间', 'active', 1, :account, :at)`,
        { id: `t_${randomUUID().slice(0, 8)}`, account: me.accountId, at: new Date().toISOString() },
      ),
      /UNIQUE|unique|duplicate/i,
    );
  } finally {
    await harness.close();
  }
});
