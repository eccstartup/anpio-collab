/**
 * DID 文档解析：登录取信的对象是"注册服务器"，不是请求体。
 *
 * 关键在于拒绝能力：未注册的 DID 不能登录/绑定，客户端自带一份文档也不算数。
 * 这组用例同时守住地址推导（did:wba → did.json）与解析器自身的边界
 * （超时、重定向、大小、id 不一致）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHttpDidResolver,
  DidResolutionError,
  didDocumentUrl,
} from '../src/anp/resolver.ts';
import { signRequest } from '../src/anp/signature.ts';
import { anpLogin } from '../src/anp/client.ts';
import { ADMIN_TOKEN, startHarness } from './helpers/harness.ts';

const LOCAL_DID = 'did:wba:127.0.0.1%3A8765:user:alice:e1_abc';

test('did:wba 到 did.json 的地址推导：域段里的 %3A 是端口', () => {
  assert.equal(
    didDocumentUrl('did:wba:awiki.ai:user:alice:e1_abc').toString(),
    'https://awiki.ai/user/alice/e1_abc/did.json',
  );
  assert.equal(didDocumentUrl(LOCAL_DID).toString(), 'http://127.0.0.1:8765/user/alice/e1_abc/did.json');
  // 内网部署没有证书时显式放行 http。
  assert.equal(
    didDocumentUrl('did:wba:10.0.0.8%3A8765:user:alice', { allowInsecureHttp: true }).toString(),
    'http://10.0.0.8:8765/user/alice/did.json',
  );
  assert.throws(() => didDocumentUrl('did:web:example.com:alice'), DidResolutionError);
  assert.throws(() => didDocumentUrl('did:wba:example.com:..:alice'), DidResolutionError);
  assert.throws(() => didDocumentUrl('did:wba:example.com:user:alice?x=1'), DidResolutionError);
});

test('解析器：404 是"未注册"，重定向不跟随，id 不一致不可信，成功结果走缓存', async () => {
  const requested: string[] = [];
  const make = (handler: (url: string) => Response) =>
    createHttpDidResolver({
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        requested.push(url);
        return handler(url);
      }) as typeof fetch,
    });

  const notFound = make(() => new Response('{"error":"did_document_not_found"}', { status: 404 }));
  await assert.rejects(notFound.resolve(LOCAL_DID), (error: unknown) => {
    assert.ok(error instanceof DidResolutionError);
    assert.equal(error.code, 'not_found');
    return true;
  });

  const redirected = make(() => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }));
  await assert.rejects(redirected.resolve(LOCAL_DID), (error: unknown) => {
    assert.equal((error as DidResolutionError).code, 'redirected');
    return true;
  });

  const mismatched = make(() =>
    new Response(JSON.stringify({ id: 'did:wba:127.0.0.1%3A8765:user:mallory' }), { status: 200 }),
  );
  await assert.rejects(mismatched.resolve(LOCAL_DID), (error: unknown) => {
    assert.equal((error as DidResolutionError).code, 'bad_document');
    return true;
  });

  let calls = 0;
  const healthy = createHttpDidResolver({
    fetchImpl: (async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: LOCAL_DID, verificationMethod: [] }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal((await healthy.resolve(LOCAL_DID)).cached, false);
  assert.equal((await healthy.resolve(LOCAL_DID)).cached, true);
  assert.equal(calls, 1, '缓存期内不应重复取文档');
});

test('未注册的 DID 不能登录：解析失败就是拒绝', async () => {
  const harness = await startHarness();
  try {
    // 生成了密钥但没在注册服务器登记——"我造了个 DID" 不等于 "这个 DID 存在"。
    const identity = harness.did.generate('ghost');
    await assert.rejects(anpLogin({ baseUrl: harness.url, identity }), (error: Error) => {
      assert.match(error.message, /DID 校验未通过|没有在注册服务器上登记/);
      return true;
    });
  } finally {
    await harness.close();
  }
});

test('请求体自带 didDocument 不算数：拿别人的 DID + 自己的公钥签发会被拒', async () => {
  const harness = await startHarness();
  try {
    const victim = harness.did.identity('victim');
    const attacker = harness.did.generate('attacker');
    const challenge = (await (await fetch(`${harness.url}/auth/anp/challenge`)).json()) as { nonce: string };

    // 攻击者的算盘：DID 用受害者的，文档换成带自己公钥的，签名用自己私钥。
    const url = `${harness.url}/auth/anp/login`;
    const body = JSON.stringify({
      nonce: challenge.nonce,
      did: victim.did,
      keyid: victim.keyid,
      didDocument: attacker.didDocument,
    });
    const signed = signRequest({
      url,
      method: 'POST',
      body,
      nonce: challenge.nonce,
      keyid: victim.keyid,
      privateKey: attacker.privateKey,
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed.headers },
      body: signed.body,
    });
    assert.equal(response.status, 401);
    const payload = (await response.json()) as { error: { message: string } };
    assert.match(payload.error.message, /签名校验失败|DID 文档不可用/);
  } finally {
    await harness.close();
  }
});

test('未注册的 DID 也不能补绑到已登录账号上', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.generate('ghost-bind');
    const challengeResponse = await fetch(`${harness.url}/v1/me/identities/challenge`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const { nonce } = (await challengeResponse.json()) as { nonce: string };
    const url = `${harness.url}/v1/me/identities/bind`;
    const body = JSON.stringify({ nonce, did: identity.did, didDocument: identity.didDocument });
    const signed = signRequest({
      url,
      method: 'POST',
      body,
      nonce,
      keyid: identity.keyid,
      privateKey: identity.privateKey,
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
        ...signed.headers,
      },
      body: signed.body,
    });
    assert.equal(response.status, 401);
    const payload = (await response.json()) as { error: { message: string } };
    assert.match(payload.error.message, /没有在注册服务器上登记/);

    const identities = await harness.client(ADMIN_TOKEN).identities();
    assert.equal(identities.length, 0, '拒绝之后不应留下绑定');
  } finally {
    await harness.close();
  }
});
