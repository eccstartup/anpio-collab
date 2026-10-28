/**
 * 已登录之后补绑 DID。
 *
 * 场景：人用邮箱链接进来（或本来就用令牌），在「设置 → 绑定我的 DID」里
 * 让浏览器钱包对一条一次性挑战签名，这条 DID 就挂到当前账号下。
 *
 * 这组用例守两件事：
 *  1. 绑定必须同时有「有效会话」和「该 DID 的私钥签名」，少一个都不成；
 *  2. 绑定只是登记归属，不产生新主体、不改角色，也不吃掉别人的 DID。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { generateIdentity, type AnpIdentity } from '../src/anp/identity.ts';
import { signRequest } from '../src/anp/signature.ts';
import { anpLogin } from '../src/anp/client.ts';
import { ADMIN_TOKEN, startHarness, type Harness } from './helpers/harness.ts';

type BindOptions = {
  /** 复用挑战（用于重放与篡改用例）；不传就现取一个。 */
  nonce?: string;
  /** 用不同的 Idempotency-Key 重发同一份签名请求。 */
  operationId?: string;
  tamper?: boolean;
  /** 拿登录挑战去补绑。 */
  loginNonce?: boolean;
};

async function challenge(harness: Harness, token: string): Promise<string> {
  const response = await fetch(`${harness.url}/v1/me/identities/challenge`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { nonce: string; purpose: string };
  assert.equal(payload.purpose, 'bind');
  return payload.nonce;
}

/** 走一遍真实签名：与 anpio-extension 的 signAnpLogin 覆盖同样的分量。 */
async function signBind(
  harness: Harness,
  identity: AnpIdentity,
  nonce: string,
): Promise<{ url: string; body: string; headers: Record<string, string> }> {
  const url = `${harness.url}/v1/me/identities/bind`;
  const body = JSON.stringify({
    nonce,
    did: identity.did,
    didDocument: identity.didDocument,
    client: 'browser',
  });
  const signed = signRequest({
    url,
    method: 'POST',
    body,
    nonce,
    keyid: identity.keyid,
    privateKey: identity.privateKey,
  });
  return { url, body: signed.body, headers: signed.headers };
}

async function bind(
  harness: Harness,
  token: string,
  identity: AnpIdentity,
  options: BindOptions = {},
): Promise<Response> {
  const nonce = options.loginNonce
    ? ((await (await fetch(`${harness.url}/auth/anp/challenge`)).json()) as { nonce: string }).nonce
    : options.nonce ?? (await challenge(harness, token));
  const signed = await signBind(harness, identity, nonce);
  const body = options.tamper ? signed.body.replace(identity.did, identity.did.replace(/e1_/, 'e1_x')) : signed.body;
  return fetch(signed.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': options.operationId ?? crypto.randomUUID(),
      ...signed.headers,
    },
    body,
  });
}

test('已登录后补绑 DID：登记归属、设为主身份、之后用该 DID 登录落到同一主体', async () => {
  const harness = await startHarness();
  try {
    const identity = generateIdentity({ handle: 'carol' });
    const before = await harness.client(ADMIN_TOKEN).me();
    assert.equal(before.did, null);

    const response = await bind(harness, ADMIN_TOKEN, identity);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      did: string;
      primary: boolean;
      existing: boolean;
      client: string;
      fingerprint: string;
    };
    assert.equal(payload.did, identity.did);
    assert.equal(payload.primary, true, '主体原来没有 DID，绑定后应成为主身份');
    assert.equal(payload.existing, false);
    assert.equal(payload.client, 'browser');
    assert.equal(payload.fingerprint, identity.fingerprint);

    const identifiers = await harness.client(ADMIN_TOKEN).identities();
    assert.equal(identifiers.length, 1);
    assert.equal(identifiers[0]!.did, identity.did);

    const after = await harness.client(ADMIN_TOKEN).me();
    assert.equal(after.did, identity.did, '侧栏与 /v1/me 应该认得这条 DID');
    assert.equal(after.id, before.id, '绑定不新建主体');

    // 同一条 DID 之后可以单独登录，且落到同一个主体——这是绑定的意义。
    const login = await anpLogin({ baseUrl: harness.url, identity, client: 'browser' });
    assert.equal(login.principal.id, before.id);
    assert.equal(login.enrollment, 'existing');
  } finally {
    await harness.close();
  }
});

test('重复绑定同一条 DID：幂等成功，不重复登记', async () => {
  const harness = await startHarness();
  try {
    const identity = generateIdentity({ handle: 'dave' });
    assert.equal((await bind(harness, ADMIN_TOKEN, identity)).status, 200);

    const again = await bind(harness, ADMIN_TOKEN, identity);
    assert.equal(again.status, 200);
    const payload = (await again.json()) as { existing: boolean; primary: boolean };
    assert.equal(payload.existing, true);
    assert.equal(payload.primary, false, '主 DID 已存在，不应再改');

    const identifiers = await harness.client(ADMIN_TOKEN).identities();
    assert.equal(identifiers.length, 1);
  } finally {
    await harness.close();
  }
});

test('挑战只能用一次：同一份签名换一个 Idempotency-Key 重放被拒', async () => {
  const harness = await startHarness();
  try {
    const identity = generateIdentity({ handle: 'replay-bind' });
    const nonce = await challenge(harness, ADMIN_TOKEN);
    const signed = await signBind(harness, identity, nonce);
    const headers = (key: string) => ({
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
      'idempotency-key': key,
      ...signed.headers,
    });

    const first = await fetch(signed.url, { method: 'POST', headers: headers(crypto.randomUUID()), body: signed.body });
    assert.equal(first.status, 200);

    const replay = await fetch(signed.url, { method: 'POST', headers: headers(crypto.randomUUID()), body: signed.body });
    assert.equal(replay.status, 401);
    const payload = (await replay.json()) as { error: { message: string } };
    assert.match(payload.error.message, /挑战/);
  } finally {
    await harness.close();
  }
});

test('请求体被改动后签名失效', async () => {
  const harness = await startHarness();
  try {
    const identity = generateIdentity({ handle: 'tamper-bind' });
    const response = await bind(harness, ADMIN_TOKEN, identity, { tamper: true });
    assert.equal(response.status, 401);
  } finally {
    await harness.close();
  }
});

test('登录挑战不能拿去补绑 DID', async () => {
  const harness = await startHarness();
  try {
    const identity = generateIdentity({ handle: 'wrong-purpose' });
    const response = await bind(harness, ADMIN_TOKEN, identity, { loginNonce: true });
    assert.equal(response.status, 401);
    const payload = (await response.json()) as { error: { message: string } };
    assert.match(payload.error.message, /用途不符|挑战/);

    const identifiers = await harness.client(ADMIN_TOKEN).identities();
    assert.equal(identifiers.length, 0, '失败不应留下绑定');
  } finally {
    await harness.close();
  }
});

test('没有会话就不能补绑：DID 归属必须靠已登录的账号来确认', async () => {
  const harness = await startHarness();
  try {
    const identity = generateIdentity({ handle: 'anon' });
    const nonce = ((await (await fetch(`${harness.url}/auth/anp/challenge`)).json()) as { nonce: string }).nonce;
    const signed = await signBind(harness, identity, nonce);
    const response = await fetch(signed.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
        ...signed.headers,
      },
      body: signed.body,
    });
    assert.equal(response.status, 401);
  } finally {
    await harness.close();
  }
});

test('一条 DID 已属于别人时拒绝，不会静默改写归属', async () => {
  const harness = await startHarness();
  try {
    const identity = generateIdentity({ handle: 'taken' });
    // 先让这条 DID 自己登录，落成一个独立主体。
    const owner = await anpLogin({ baseUrl: harness.url, identity });
    assert.notEqual(owner.principal.id, 'admin');

    const response = await bind(harness, ADMIN_TOKEN, identity);
    assert.equal(response.status, 409);

    const identifiers = await harness.client(ADMIN_TOKEN).identities();
    assert.equal(identifiers.length, 0);
    const ownerIdentities = await harness.client(owner.token).identities();
    assert.equal(ownerIdentities[0]!.did, identity.did, '原主人不受影响');
  } finally {
    await harness.close();
  }
});

test('补绑成功后可以解绑，且不影响主体与其他身份', async () => {
  const harness = await startHarness();
  try {
    const walletA = generateIdentity({ handle: 'multi-a' });
    const walletB = generateIdentity({ handle: 'multi-b' });
    assert.equal((await bind(harness, ADMIN_TOKEN, walletA)).status, 200);
    const second = (await (await bind(harness, ADMIN_TOKEN, walletB)).json()) as { primary: boolean };
    assert.equal(second.primary, false, '已有主 DID 时不再改主身份');

    const identifiers = await harness.client(ADMIN_TOKEN).identities();
    assert.equal(identifiers.length, 2);
    const target = identifiers.find(item => item.did === walletB.did)!;

    const revoked = await harness.client(ADMIN_TOKEN).revokeIdentity(target.id, crypto.randomUUID());
    assert.equal(revoked.revoked, true);
    const left = await harness.client(ADMIN_TOKEN).identities();
    assert.equal(left.length, 1);
    assert.equal(left[0]!.did, walletA.did);

    // 解绑后这条 DID 再登录，会作为新的主体重新登记，而不是回到原账号。
    const login = await anpLogin({ baseUrl: harness.url, identity: walletB, client: 'browser' });
    assert.notEqual(login.principal.id, 'admin');
  } finally {
    await harness.close();
  }
});
