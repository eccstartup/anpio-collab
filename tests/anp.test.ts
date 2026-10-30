/**
 * ANP 登录：浏览器钱包与命令行客户端走同一条路。
 *
 * 这里用平台自己的签名实现扮演两个客户端。它与 `anpio-extension` 的
 * `signAnpLogin` 和 `anpio-cli` 的 `anp login` 覆盖同样的分量、同样的参数拼写，
 * 因此这组用例验证的是**协议行为**：nonce 单次、字节一致、挑战语义、会话边界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_TOKEN, startHarness } from './helpers/harness.ts';
import { anpLogin, AnpLoginError, nonceFromChallenge } from '../src/anp/client.ts';
import type { AnpIdentity } from '../src/anp/identity.ts';
import { signRequest } from '../src/anp/signature.ts';

/** 手动构造一次登录请求，用来覆盖客户端会避开的坏路径。 */
async function rawLogin(
  base: string,
  identity: AnpIdentity,
  options: { nonce: string; tamper?: boolean; signedNonce?: string } = { nonce: '' },
) {
  const url = `${base}/auth/anp/login`;
  const body = JSON.stringify({ nonce: options.nonce, did: identity.did, didDocument: identity.didDocument, client: 'agent' });
  const signed = signRequest({
    url,
    body,
    nonce: options.signedNonce ?? options.nonce,
    keyid: identity.keyid,
    privateKey: identity.privateKey,
  });
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed.headers },
    body: options.tamper ? signed.body.replace('"agent"', '"browser"') : signed.body,
  });
}

test('钱包身份首次登录：自动登记、签发会话、可读 /v1/me', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('alice');
    const result = await anpLogin({ baseUrl: harness.url, identity, client: 'browser' });

    assert.equal(result.tokenType, 'Bearer');
    assert.equal(result.did, identity.did);
    assert.equal(result.principal.kind, 'human');
    assert.deepEqual(result.principal.roles, ['owner']);
    assert.equal(result.enrollment, 'auto');

    const me = await harness.client(result.token).me();
    assert.equal(me.id, result.principal.id);
    assert.equal(me.did, identity.did);
    assert.equal(me.kind, 'human');
    assert.equal(me.handle, `alice@${decodeURIComponent(harness.did.domain)}`);
  } finally {
    await harness.close();
  }
});

test('请求体不带 keyid 时按 #key-1 解析：文档里有多把钥匙也能登录', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('wallet');
    // 钱包发布的文档除 #key-1 外还有设备钥；浏览器请求体里不带 keyid，
    // 默认取 #key-1——这时不能退化成"任取一把钥匙"，也不能匹配不上。
    const document = identity.didDocument as {
      verificationMethod: unknown[];
      authentication: string[];
    };
    harness.did.register({
      ...identity,
      didDocument: {
        ...identity.didDocument,
        verificationMethod: [
          ...document.verificationMethod,
          {
            id: `${identity.did}#device-1-sign`,
            type: 'Multikey',
            controller: identity.did,
            publicKeyMultibase: identity.publicKeyMultibase,
          },
        ],
        authentication: [identity.keyid],
      },
    });

    const challenge = (await (await fetch(`${harness.url}/auth/anp/challenge`)).json()) as { nonce: string };
    const url = `${harness.url}/auth/anp/login`;
    const body = JSON.stringify({
      nonce: challenge.nonce,
      did: identity.did,
      didDocument: identity.didDocument,
      client: 'browser',
    });
    const signed = signRequest({
      url,
      method: 'POST',
      body,
      nonce: challenge.nonce,
      keyid: identity.keyid,
      privateKey: identity.privateKey,
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed.headers },
      body: signed.body,
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { keyid: string };
    assert.equal(payload.keyid, identity.keyid);
  } finally {
    await harness.close();
  }
});

test('同一个 DID 再次登录落到同一个主体，不会重复登记', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('bob');
    const first = await anpLogin({ baseUrl: harness.url, identity });
    const second = await anpLogin({ baseUrl: harness.url, identity });
    assert.equal(second.principal.id, first.principal.id);
    assert.equal(second.enrollment, 'existing');

    const identities = await harness.client(second.token).identities();
    assert.equal(identities.length, 1);
    assert.equal(identities[0]!.did, identity.did);
    assert.equal(identities[0]!.loginCount >= 2, true);
  } finally {
    await harness.close();
  }
});

test('nonce 只能用一次；重放被拒并换发新挑战', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('replay');
    const challenge = (await (await fetch(`${harness.url}/auth/anp/challenge`)).json()) as { nonce: string };

    const url = `${harness.url}/auth/anp/login`;
    const body = JSON.stringify({ nonce: challenge.nonce, did: identity.did, didDocument: identity.didDocument });
    const signed = signRequest({
      url,
      body,
      nonce: challenge.nonce,
      keyid: identity.keyid,
      privateKey: identity.privateKey,
    });
    const headers = { 'content-type': 'application/json', ...signed.headers };
    const first = await fetch(url, { method: 'POST', headers, body: signed.body });
    assert.equal(first.status, 200);

    const replay = await fetch(url, { method: 'POST', headers, body: signed.body });
    assert.equal(replay.status, 401);
    const payload = (await replay.json()) as { error: { code: string }; nonce?: string };
    assert.equal(payload.error.code, 'challenge_required');
    assert.ok(payload.nonce, '拒绝时要给出可用的新 nonce');
  } finally {
    await harness.close();
  }
});

test('请求体被改动后签名失效', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('tamper');
    const challenge = (await (await fetch(`${harness.url}/auth/anp/challenge`)).json()) as { nonce: string };
    const response = await rawLogin(harness.url, identity, { nonce: challenge.nonce, tamper: true });
    assert.equal(response.status, 401);
    const payload = (await response.json()) as { error: { message: string } };
    assert.match(payload.error.message, /签名校验失败|content-digest|不一致/);
  } finally {
    await harness.close();
  }
});

test('不带 nonce 时返回 401 挑战，客户端读 WWW-Authenticate 重签即可登录（anpio-cli 语义）', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('cli');
    const rejected = await rawLogin(harness.url, identity, { nonce: '' });
    assert.equal(rejected.status, 401);
    const challenge = nonceFromChallenge(rejected.headers.get('www-authenticate'));
    assert.ok(challenge, 'WWW-Authenticate 必须带 nonce');

    // anpio-cli 的行为：用挑战给的 nonce 重签一次，而且只重试一次。
    const accepted = await rawLogin(harness.url, identity, { nonce: challenge! });
    assert.equal(accepted.status, 200);
    const payload = (await accepted.json()) as { token: string; principal: { id: string } };
    assert.ok(payload.token);
    assert.ok(payload.principal.id);
    // 令牌同时出现在 Authentication-Info 里，头部读法的客户端也能用。
    assert.match(accepted.headers.get('authentication-info') ?? '', /access_token="/);
  } finally {
    await harness.close();
  }
});

test('退出登录只撤销当前会话，其他会话不受影响', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('sessions');
    const laptop = await anpLogin({ baseUrl: harness.url, identity });
    const desktop = await anpLogin({ baseUrl: harness.url, identity });

    await harness.client(laptop.token).logout();
    await assert.rejects(harness.client(laptop.token).me(), (error: unknown) => {
      assert.equal((error as { status: number }).status, 401);
      return true;
    });
    assert.equal((await harness.client(desktop.token).me()).id, desktop.principal.id);
  } finally {
    await harness.close();
  }
});

test('绑定码让智能体登进人的账号，审计仍能分辨 DID', async () => {
  const harness = await startHarness();
  try {
    const human = harness.did.identity('boss');
    const humanLogin = await anpLogin({ baseUrl: harness.url, identity: human, client: 'browser' });
    const client = harness.client(humanLogin.token);

    const invite = await client.inviteIdentity({ role: 'agent', note: '库存智能体' }, 'invite-1');
    assert.ok(invite.code.length >= 8);

    const agent = harness.did.identity('stock-bot');
    const bound = await anpLogin({ baseUrl: harness.url, identity: agent, bindCode: invite.code });
    assert.equal(bound.enrollment, 'bound');
    assert.equal(bound.principal.id, humanLogin.principal.id, '同一个账号');

    const identities = await client.identities();
    assert.equal(identities.length, 2);
    assert.deepEqual(
      identities.map(item => item.did).sort(),
      [human.did, agent.did].sort(),
    );

    // 绑定码一次性。
    const second = await anpLogin({ baseUrl: harness.url, identity: harness.did.identity('other'), bindCode: invite.code }).catch(
      (error: unknown) => error,
    );
    assert.ok(second instanceof AnpLoginError);
    assert.equal((second as AnpLoginError).status, 403);
  } finally {
    await harness.close();
  }
});

test('pending 模式下陌生 DID 被拦在门外，管理员批准后才能进', async () => {
  const harness = await startHarness({ enroll: 'pending' });
  try {
    const identity = harness.did.identity('newbie');
    const blocked = await anpLogin({ baseUrl: harness.url, identity }).catch((error: unknown) => error);
    assert.ok(blocked instanceof AnpLoginError);
    assert.equal((blocked as AnpLoginError).status, 403);
    assert.equal((blocked as AnpLoginError).code, 'enrollment_pending');

    const pending = await harness.admin.pendingPrincipals();
    assert.equal(pending.length, 1);
    await harness.admin.activatePrincipal(pending[0]!.id, 'activate');
    const allowed = await anpLogin({ baseUrl: harness.url, identity });
    assert.equal(allowed.principal.id, pending[0]!.id);
  } finally {
    await harness.close();
  }
});

test('无效签名不能换取会话，也不会消耗别人的 nonce', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('forger');
    const challenge = (await (await fetch(`${harness.url}/auth/anp/challenge`)).json()) as { nonce: string };
    const url = `${harness.url}/auth/anp/login`;
    const body = JSON.stringify({ nonce: challenge.nonce, did: identity.did, didDocument: identity.didDocument });
    const signed = signRequest({
      url,
      body,
      nonce: challenge.nonce,
      keyid: identity.keyid,
      // 用别人的钥匙签这份文档：验签必须失败。
      privateKey: harness.did.identity('thief').privateKey,
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed.headers },
      body: signed.body,
    });
    assert.equal(response.status, 401);

    // 失败不消费 nonce：合法客户端还能用它完成登录。
    const good = await rawLogin(harness.url, identity, { nonce: challenge.nonce });
    assert.equal(good.status, 200);
  } finally {
    await harness.close();
  }
});

test('智能体的目录只包含自己和同任务的人', async () => {
  const harness = await startHarness();
  try {
    const ownerToken = harness.token('owner');
    await harness.admin.registerPrincipal({ id: 'owner1', roles: ['owner'], token: ownerToken }, 'register-owner');
    const owner = harness.client(ownerToken);

    const stock = harness.did.identity('stock');
    const stockLogin = await anpLogin({ baseUrl: harness.url, identity: stock });
    const supplier = harness.did.identity('supplier');
    const supplierLogin = await anpLogin({ baseUrl: harness.url, identity: supplier });

    const task = await owner.createTask(
      { title: '缺料分析', acceptance: '有来源', type: 'shortage' },
      'task-1',
    );
    await owner.assign(task.id, { agent: stockLogin.principal.id, kind: 'inventory' }, 'assign-1');

    const stockDirectory = await harness.client(stockLogin.token).directory();
    const supplierDirectory = await harness.client(supplierLogin.token).directory();
    const ids = stockDirectory.map(item => item.id).sort();
    assert.deepEqual(ids, ['owner1', stockLogin.principal.id].sort());
    assert.deepEqual(supplierDirectory.map(item => item.id), [supplierLogin.principal.id]);

    // 管理员仍然看得到全量目录。
    assert.equal((await harness.admin.directory()).length >= 4, true);
    // 非智能体角色（管理员）照旧不受限。
    assert.ok((await harness.admin.request<unknown[]>('principals')).length > 0);
    assert.equal(ADMIN_TOKEN.length > 20, true);
  } finally {
    await harness.close();
  }
});
