/**
 * ANP 验签的负例。
 *
 * 这些用例钉住的是「拒绝的理由要对」：证明坏是 401，问不到 DID 文档是 503，
 * DID 被替换是 409——把三者混成一个 401，对端就会一直重签一份没问题的证明。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { generateIdentity, type AnpIdentity } from '../src/anp/identity.ts';
import { signDidDocumentProofSync } from '@anpio-cli/core/advanced';
import { signRequest } from './helpers/anp-sign.ts';
import { startHarness, type Harness } from './helpers/harness.ts';

type Body = Record<string, unknown>;

async function challenge(harness: Harness): Promise<string> {
  const response = await fetch(`${harness.url}/auth/anp/challenge`);
  const payload = (await response.json()) as { nonce: string };
  return payload.nonce;
}

async function postLogin(
  harness: Harness,
  options: {
    nonce: string;
    body: Body;
    keyid: string;
    signWith: AnpIdentity['privateKey'];
    components?: string[];
  },
): Promise<Response> {
  const url = `${harness.url}/auth/anp/login`;
  const signed = await signRequest({
    url,
    body: JSON.stringify(options.body),
    nonce: options.nonce,
    keyid: options.keyid,
    privateKey: options.signWith,
    components: options.components,
  });
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed.headers },
    body: signed.body,
  });
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const payload = (await response.json()) as { error?: { code: string; message: string } };
  assert.ok(payload.error, '拒绝时必须带 error 对象');
  return payload.error;
}

test('DID 文档缺 proof：拒绝登录，并说明文档不可用', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('no-proof');
    const { proof: _proof, ...document } = identity.didDocument as Record<string, unknown>;
    harness.did.register({ ...identity, didDocument: document });

    const nonce = await challenge(harness);
    const response = await postLogin(harness, {
      nonce,
      body: { nonce, did: identity.did, didDocument: document },
      keyid: identity.keyid,
      signWith: identity.privateKey,
    });
    assert.equal(response.status, 401);
    const error = await errorOf(response);
    assert.equal(error.code, 'unauthenticated');
    assert.match(error.message, /DID 文档不可用/);
  } finally {
    await harness.close();
  }
});

test('文档 proof 被篡改：拒绝登录', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('bad-proof');
    const document = structuredClone(identity.didDocument) as {
      proof: { proofValue: string };
    };
    document.proof.proofValue = `${document.proof.proofValue.slice(0, -4)}AAAA`;
    harness.did.register({ ...identity, didDocument: document as unknown as Record<string, unknown> });

    const nonce = await challenge(harness);
    const response = await postLogin(harness, {
      nonce,
      body: { nonce, did: identity.did, didDocument: identity.didDocument },
      keyid: identity.keyid,
      signWith: identity.privateKey,
    });
    assert.equal(response.status, 401);
    const error = await errorOf(response);
    assert.equal(error.code, 'unauthenticated');
    assert.match(error.message, /DID 文档不可用/);
  } finally {
    await harness.close();
  }
});

test('Signature-Input 的 keyid 属于另一个 DID：拒绝登录', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('wrong-keyid');
    const other = harness.did.identity('someone-else');

    const nonce = await challenge(harness);
    const response = await postLogin(harness, {
      nonce,
      body: { nonce, did: identity.did, didDocument: identity.didDocument },
      keyid: other.keyid,
      signWith: identity.privateKey,
    });
    assert.equal(response.status, 401);
    const error = await errorOf(response);
    assert.match(error.message, /签名声明的 DID 与请求体不一致/);
  } finally {
    await harness.close();
  }
});

test('请求体 keyid 与 Signature-Input 不一致：拒绝登录', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('body-keyid');
    const other = harness.did.identity('other-keyid');

    const nonce = await challenge(harness);
    const response = await postLogin(harness, {
      nonce,
      body: { nonce, did: identity.did, keyid: other.keyid, didDocument: identity.didDocument },
      keyid: identity.keyid,
      signWith: identity.privateKey,
    });
    assert.equal(response.status, 401);
    const error = await errorOf(response);
    assert.match(error.message, /请求体 keyid 与 Signature-Input 不一致/);
  } finally {
    await harness.close();
  }
});

test('覆盖集缺 @target-uri：拒绝登录', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('no-target');
    const nonce = await challenge(harness);
    const response = await postLogin(harness, {
      nonce,
      body: { nonce, did: identity.did, didDocument: identity.didDocument },
      keyid: identity.keyid,
      signWith: identity.privateKey,
      components: ['@method', '@authority', 'content-digest'],
    });
    assert.equal(response.status, 401);
    const error = await errorOf(response);
    assert.match(error.message, /组件不完整|签名校验失败/);
  } finally {
    await harness.close();
  }
});

test('有请求体却不覆盖 content-digest：拒绝登录', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('no-digest');
    const nonce = await challenge(harness);
    const response = await postLogin(harness, {
      nonce,
      body: { nonce, did: identity.did, didDocument: identity.didDocument },
      keyid: identity.keyid,
      signWith: identity.privateKey,
      components: ['@method', '@target-uri', '@authority'],
    });
    assert.equal(response.status, 401);
    const error = await errorOf(response);
    assert.match(error.message, /组件不完整|签名校验失败/);
  } finally {
    await harness.close();
  }
});

test('DID 服务器连不上：503 可重试，而不是 401', async () => {
  const harness = await startHarness();
  try {
    // 本机 1 号端口没有服务：解析必然得到 unreachable。
    const identity = generateIdentity({ handle: 'unreachable', domain: '127.0.0.1%3A1' });
    const nonce = await challenge(harness);
    const response = await postLogin(harness, {
      nonce,
      body: { nonce, did: identity.did, didDocument: identity.didDocument },
      keyid: identity.keyid,
      signWith: identity.privateKey,
    });
    assert.equal(response.status, 503);
    const error = await errorOf(response);
    assert.equal(error.code, 'unavailable');
    assert.match(error.message, /暂时无法取回 DID 文档/);
  } finally {
    await harness.close();
  }
});

test('DID 已被替换：409 did_superseded，并带 currentDid', async () => {
  const harness = await startHarness();
  try {
    const identity = harness.did.identity('retired');
    const successor = harness.did.identity('successor');
    const { proof: _proof, ...unsigned } = identity.didDocument as Record<string, unknown>;
    const document: Record<string, unknown> = {
      ...unsigned,
      deactivated: true,
      successorDid: successor.did,
    };
    document.proof = signDidDocumentProofSync(document, identity.keyid, identity.priv);
    harness.did.register({ ...identity, didDocument: document });

    const nonce = await challenge(harness);
    const response = await postLogin(harness, {
      nonce,
      body: { nonce, did: identity.did, didDocument: document },
      keyid: identity.keyid,
      signWith: identity.privateKey,
    });
    assert.equal(response.status, 409);
    const payload = (await response.json()) as {
      error: { code: string };
      requestedDid?: string;
      currentDid?: string;
    };
    assert.equal(payload.error.code, 'did_superseded');
    assert.equal(payload.requestedDid, identity.did);
    assert.equal(payload.currentDid, successor.did);
  } finally {
    await harness.close();
  }
});
