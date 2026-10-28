/**
 * 智能体接入：ANP 登录换会话、缓存复用、与人和同一账号的绑定码协作。
 *
 * 这些用例回答"智能体到底怎么登录平台"这个问题：
 * 私钥留在智能体自己的机器上，平台只验签；令牌只在会话期内有效。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportPrivateJwk, type AnpIdentity } from '../src/anp/identity.ts';
import { anpLogin } from '../src/anp/client.ts';
import { loadIdentityFromEnv, resolveAgentSession, withAgentClient } from '../src/agents/session.ts';
import { CollabClient } from '../src/sdk/client.ts';
import { startHarness, type Harness } from './helpers/harness.ts';

type Env = Record<string, string | undefined>;

function withEnv(env: Env): () => void {
  const saved: Env = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * 把身份写成 JWK 文件，模拟"智能体自己保管的密钥"。
 * 文件名就是默认 handle（DID 由公钥 + handle 共同决定），所以必须与生成时一致。
 */
function writeKey(directory: string, handle: string, identity: AnpIdentity): string {
  const path = join(directory, `${handle}.json`);
  writeFileSync(path, JSON.stringify(exportPrivateJwk(identity)));
  return path;
}

test('智能体用 ANP 密钥登录：自动登记为 agent，会话缓存复用，撤销后重登', async () => {
  const harness: Harness = await startHarness();
  const directory = mkdtempSync(join(tmpdir(), 'collab-agent-'));
  const identity = harness.did.identity('inventory');
  const keyPath = writeKey(directory, 'inventory', identity);
  const restore = withEnv({
    COLLAB_URL: harness.url,
    COLLAB_ANP_KEY: keyPath,
    COLLAB_STATE_DIR: directory,
    COLLAB_ANP_DOMAIN: harness.did.domain,
    COLLAB_TOKEN: undefined,
  });

  try {
    assert.equal(loadIdentityFromEnv()?.identity.did, identity.did, '应能从 JWK 文件还原同一个 DID');

    const session = await resolveAgentSession({ baseUrl: harness.url });
    assert.equal(session.mode, 'anp');
    assert.equal(session.did, identity.did);

    const client = new CollabClient(harness.url, session.token);
    const me = await client.me();
    assert.equal(me.kind, 'agent');
    assert.deepEqual(me.roles, ['agent'], 'agent 客户端首次登录应按 agent 登记');
    assert.equal(me.did, identity.did);

    // 第二次取会话应命中缓存：没有多出一条登录会话。
    const again = await resolveAgentSession({ baseUrl: harness.url });
    assert.equal(again.token, session.token, '缓存期内不应重新登录');
    const sessions = await client.sessions();
    assert.equal(sessions.length, 1, `重复登录产生了多条会话：${JSON.stringify(sessions)}`);

    // 撤销会话后：本地缓存还不知道，第一次调用会撞 401，然后自动重登再试。
    await client.revokeSession(sessions[0]!.id, 'revoke:1');
    assert.equal((await resolveAgentSession({ baseUrl: harness.url })).token, session.token, '缓存本身不会被远端撤销感知到');
    const me2 = await withAgentClient(current => current.me());
    assert.equal(me2.id, me.id, '重新登录后应还是同一个主体');
    const renewed = await resolveAgentSession({ baseUrl: harness.url });
    assert.notEqual(renewed.token, session.token, '撤销后应换新令牌');
    assert.equal((await new CollabClient(harness.url, renewed.token).sessions()).length, 2);

    await assert.rejects(
      new CollabClient(harness.url, session.token).me(),
      /登录|令牌|认证|未授权/i,
      '被撤销的令牌不应还能用',
    );
  } finally {
    restore();
    rmSync(directory, { recursive: true, force: true });
    await harness.close();
  }
});

test('待批准模式下智能体登录：给出可执行的说明而不是裸露的 403', async () => {
  const harness = await startHarness({ enroll: 'pending' });
  const directory = mkdtempSync(join(tmpdir(), 'collab-agent-'));
  const identity = harness.did.identity('pending-agent');
  const keyPath = writeKey(directory, 'pending-agent', identity);
  const restore = withEnv({
    COLLAB_URL: harness.url,
    COLLAB_ANP_KEY: keyPath,
    COLLAB_STATE_DIR: directory,
    COLLAB_ANP_DOMAIN: harness.did.domain,
    COLLAB_TOKEN: undefined,
  });

  try {
    await assert.rejects(
      resolveAgentSession({ baseUrl: harness.url }),
      (error: Error) => {
        assert.match(error.message, /等批准|批准/, `错误信息应告诉人下一步做什么：${error.message}`);
        assert.ok(error.message.includes(identity.did), '错误里应带上 DID，方便管理员核对');
        return true;
      },
    );

    // 管理员批准之后，同一条 DID 可以直接登录，不需要重新登记。
    const pending = await harness.admin.pendingPrincipals();
    assert.equal(pending.length, 1, '应有一个待批准主体');
    const principalId = String((pending[0] as { id: string }).id);
    await harness.admin.activatePrincipal(principalId, 'activate:1');

    const session = await resolveAgentSession({ baseUrl: harness.url });
    const me = await new CollabClient(harness.url, session.token).me();
    assert.equal(me.id, principalId);
    assert.equal(me.kind, 'agent');
  } finally {
    restore();
    rmSync(directory, { recursive: true, force: true });
    await harness.close();
  }
});

test('绑定码：智能体用绑定码登进人的账号，共享同一份任务可见范围', async () => {
  const harness = await startHarness();
  const directory = mkdtempSync(join(tmpdir(), 'collab-agent-'));
  // 人先用钱包（这里是同一套 ANP 代码）登进来。
  const human = harness.did.identity('alice');
  const humanLogin = await anpLogin({ baseUrl: harness.url, identity: human, client: 'browser' });
  const humanClient = new CollabClient(harness.url, humanLogin.token);
  const invite = await humanClient.inviteIdentity({ role: 'agent', note: '库存智能体' }, 'invite:1');

  const agent = harness.did.identity('inventory-shared');
  const restore = withEnv({
    COLLAB_URL: harness.url,
    COLLAB_ANP_KEY: writeKey(directory, 'inventory-shared', agent),
    COLLAB_STATE_DIR: directory,
    COLLAB_ANP_DOMAIN: harness.did.domain,
    COLLAB_TOKEN: undefined,
  });

  try {
    const session = await resolveAgentSession({ baseUrl: harness.url, bindCode: invite.code });
    const agentClient = new CollabClient(harness.url, session.token);
    const me = await agentClient.me();
    assert.equal(me.id, humanLogin.principal.id, '用了绑定码就不应另起一个主体');
    assert.equal(me.did, human.did, '主体详情仍指向人的 DID');

    const identities = await agentClient.identities();
    assert.ok(
      identities.some(item => item.did === agent.did),
      `绑定码应把智能体的 DID 挂到同一账号：${JSON.stringify(identities)}`,
    );

    // 同一个账号的人在任务上写的评论，智能体这边读得到——这就是"协作"的最小证据。
    const task = await humanClient.createTask(
      {
        title: '绑定码协作验证',
        type: 'general',
        goal: '验证同一账号下的人与智能体共享任务',
        acceptance: '双方都能看到同一条评论',
        input: {},
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      'task:shared:1',
    );
    await humanClient.comment(task.id, '这条评论由人写下', 'comment:shared:1');
    const comments = await agentClient.comments(task.id);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.body, '这条评论由人写下');

    // 绑定码是一次性的：换一条 DID 再用就必须被挡住，而不是悄悄给个新账号。
    const intruder = harness.did.identity('intruder');
    await assert.rejects(
      anpLogin({ baseUrl: harness.url, identity: intruder, client: 'agent', bindCode: invite.code }),
      /绑定码/,
    );
    // 填了错的码也不会被当成"自动登记"放行。
    await assert.rejects(
      anpLogin({ baseUrl: harness.url, identity: intruder, client: 'agent', bindCode: 'NOPE-NOT-A-CODE' }),
      /绑定码/,
    );
  } finally {
    restore();
    rmSync(directory, { recursive: true, force: true });
    await harness.close();
  }
});
