/**
 * 个人资料：姓名、头像、头衔、简介由本人修改，不再只是 DID handle。
 *
 * 资料属于账号而不是某个租户：改一次，同一账号下的团队一起更新；
 * 新建团队时直接带上，不需要再填一遍。头像只收 https 地址或上传后
 * 压出来的 data URL，其他协议在入库前就拒绝。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startHarness, type Harness } from './helpers/harness.ts';

type Me = {
  id: string;
  workspace: string;
  displayName: string;
  avatar: string;
  title: string;
  bio: string;
};

type Member = {
  principalId: string;
  displayName: string;
  avatar: string;
  title: string;
};

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

test('本人改姓名、头像、头衔与简介：成员列表与新建团队都会带上', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const login = await emailLogin(harness, 'alice@example.com');
    const before = await get<Me>(harness, '/v1/me', login.token);
    assert.equal(before.displayName, 'alice', '邮箱登录默认用 @ 前面的部分');
    assert.equal(before.avatar, '');
    assert.equal(before.title, '');

    const avatar = 'https://cdn.example.com/alice.png';
    const updated = await post(harness, '/v1/me/profile', {
      displayName: 'Alice Chen',
      avatar,
      title: '履约负责人',
      bio: '负责交付与供应商协同。',
    }, login.token);
    assert.equal(updated.status, 200, await updated.clone().text());

    const after = await get<Me>(harness, '/v1/me', login.token);
    assert.equal(after.displayName, 'Alice Chen');
    assert.equal(after.avatar, avatar);
    assert.equal(after.title, '履约负责人');
    assert.equal(after.bio, '负责交付与供应商协同。');

    // 成员列表读的是主体上的展示副本，必须一起更新。
    const members = await get<Member[]>(harness, '/v1/tenants/current/members', login.token);
    const self = members.find(item => item.principalId === login.principal.id);
    assert.ok(self, '成员列表里应该有自己');
    assert.equal(self.displayName, 'Alice Chen');
    assert.equal(self.avatar, avatar);
    assert.equal(self.title, '履约负责人');

    // 资料属于账号：新建团队时不用再填一遍。
    const created = await post(harness, '/v1/tenants', { name: '第二个团队' }, login.token);
    assert.equal(created.status, 200, await created.clone().text());
    const second = (await created.json()) as { token: string; tenant: { id: string } };
    const meInSecond = await get<Me>(harness, '/v1/me', second.token);
    assert.equal(meInSecond.workspace, second.tenant.id);
    assert.equal(meInSecond.displayName, 'Alice Chen');
    assert.equal(meInSecond.avatar, avatar);
    assert.equal(meInSecond.title, '履约负责人');
    assert.equal(meInSecond.bio, '负责交付与供应商协同。');
  } finally {
    await harness.close();
  }
});

test('头像只接受 https 地址与图片 data URL，其余协议在入库前拒绝', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const login = await emailLogin(harness, 'bob@example.com');

    const uploaded = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    const accepted = await post(harness, '/v1/me/profile', { avatar: uploaded }, login.token);
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.equal((await get<Me>(harness, '/v1/me', login.token)).avatar, uploaded);

    const scripted = await post(harness, '/v1/me/profile', { avatar: 'javascript:alert(1)' }, login.token);
    assert.equal(scripted.status, 400, '脚本协议不能进 img');
    assert.equal((await get<Me>(harness, '/v1/me', login.token)).avatar, uploaded, '被拒绝时保持原值');

    const huge = `data:image/png;base64,${'A'.repeat(48_000)}`;
    const tooBig = await post(harness, '/v1/me/profile', { avatar: huge }, login.token);
    assert.equal(tooBig.status, 400, '过大的 data URL 应被拒绝');

    const empty = await post(harness, '/v1/me/profile', { displayName: '' }, login.token);
    assert.equal(empty.status, 400, '姓名不能是空的');
  } finally {
    await harness.close();
  }
});
