/**
 * 反向绑定：DID 先登录，再把邮箱挂到同一个账号上。
 *
 * 两种入口是并列的——
 *   邮箱登录 → 绑 DID（见 identity-bind.test.ts）
 *   DID 登录 → 绑邮箱（本文件）
 * 都必须先证明"这个东西归你"，然后只是登记归属：不新建主体、不换组织、不换令牌。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { anpLogin } from '../src/anp/client.ts';
import { startHarness, type Harness } from './helpers/harness.ts';

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

const get = async <T>(harness: Harness, path: string, token: string): Promise<T> =>
  (await (await fetch(`${harness.url}${path}`, { headers: { authorization: `Bearer ${token}` } })).json()) as T;

const ticketOf = (link: string): string => {
  const ticket = new URL(link).searchParams.get('ticket');
  assert.ok(ticket, `链接里没有 ticket: ${link}`);
  return ticket;
};

async function emailLogin(harness: Harness, email: string) {
  const started = await post(harness, '/auth/email/start', { email });
  assert.equal(started.status, 202);
  const { devLink } = (await started.json()) as { devLink: string };
  const verified = await post(harness, '/auth/email/verify', { ticket: ticketOf(devLink) });
  assert.equal(verified.status, 200, await verified.clone().text());
  return (await verified.json()) as {
    token: string;
    principal: { id: string; accountId: string };
    tenant: { id: string };
  };
}

test('DID 先登录，再绑邮箱：之后用邮箱登录落到同一个账号', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const identity = harness.did.identity('wallet-only');
    const wallet = await anpLogin({ baseUrl: harness.url, identity, client: 'browser' });

    const started = await post(harness, '/v1/me/emails/start', { email: 'Wallet@Example.com' }, wallet.token);
    assert.equal(started.status, 200, await started.clone().text());
    const { devLink, email } = (await started.json()) as { devLink: string; email: string };
    assert.equal(email, 'wallet@example.com', '入库前统一小写');

    const verified = await post(harness, '/auth/email/verify', { ticket: ticketOf(devLink) });
    assert.equal(verified.status, 200);
    const bound = (await verified.json()) as { bound: boolean; email: string; token?: string };
    assert.equal(bound.bound, true);
    assert.equal(bound.email, 'wallet@example.com');
    assert.equal(bound.token, undefined, '绑定链接不该顺手发一个会话');

    // 用新绑的邮箱走登录：同一个账号、同一个组织、同一个主体。
    const byEmail = await emailLogin(harness, 'wallet@example.com');
    assert.equal(byEmail.principal.id, wallet.principal.id);
    const walletMe = await get<{ accountId: string }>(harness, '/v1/me', wallet.token);
    assert.equal(byEmail.principal.accountId, walletMe.accountId);

    const links = await get<{ links: { kind: string; value: string }[] }>(harness, '/v1/me/links', wallet.token);
    const kinds = links.links.map(item => `${item.kind}:${item.value}`).sort();
    assert.deepEqual(kinds, ['did:' + identity.did, 'email:wallet@example.com']);

    const tenants = await get<{ id: string }[]>(harness, '/v1/me/tenants', wallet.token);
    assert.equal(tenants.length, 1, '绑邮箱不该再开一个组织');
  } finally {
    await harness.close();
  }
});

test('邮箱已被别的账号占用时当场拒绝，不白发一封注定失败的信', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    await emailLogin(harness, 'taken@example.com');
    const identity = harness.did.identity('second-wallet');
    const wallet = await anpLogin({ baseUrl: harness.url, identity, client: 'browser' });

    const response = await post(harness, '/v1/me/emails/start', { email: 'taken@example.com' }, wallet.token);
    assert.equal(response.status, 409);
    const payload = (await response.json()) as { error: { message: string } };
    assert.match(payload.error.message, /另一个账号/);
  } finally {
    await harness.close();
  }
});

test('同一个邮箱重复绑定会被认出来，而不是悄悄再插一条', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const session = await emailLogin(harness, 'same@example.com');
    const response = await post(harness, '/v1/me/emails/start', { email: 'same@example.com' }, session.token);
    assert.equal(response.status, 409);
    const payload = (await response.json()) as { error: { message: string } };
    assert.match(payload.error.message, /本账号/);
  } finally {
    await harness.close();
  }
});

test('绑定链接只能用一次', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const identity = harness.did.identity('one-shot');
    const wallet = await anpLogin({ baseUrl: harness.url, identity, client: 'browser' });
    const started = await post(harness, '/v1/me/emails/start', { email: 'once@example.com' }, wallet.token);
    const { devLink } = (await started.json()) as { devLink: string };
    const ticket = ticketOf(devLink);

    assert.equal((await post(harness, '/auth/email/verify', { ticket })).status, 200);
    const again = await post(harness, '/auth/email/verify', { ticket });
    assert.equal(again.status, 409);
  } finally {
    await harness.close();
  }
});
