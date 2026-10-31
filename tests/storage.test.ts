/**
 * 本地对象存储：三步上传、内容去重、独立附件与流式下载。
 *
 * 钉住几条容易退化的语义：
 *  - 上传地址只接受 PUT，令牌过期或哈希不符都不能写入；
 *  - 同一团队同一份内容只落一个对象，但可以有多个文件记录；
 *  - 文件不必属于任务，AICD 可以直接挂附件；
 *  - 下载支持 Range，软删除后立即不可读。
 */

import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { ADMIN_TOKEN, emailLogin, expectStatus, register, startHarness, TASK_INPUT, type Harness } from './helpers/harness.ts';

const authHeaders = (token = ADMIN_TOKEN, extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

const post = async (
  harness: Harness,
  path: string,
  body: unknown,
  token = ADMIN_TOKEN,
): Promise<Response> =>
  fetch(`${harness.url}${path}`, {
    method: 'POST',
    headers: authHeaders(token, {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    }),
    body: JSON.stringify(body),
  });

const ok = async <T = any>(response: Response): Promise<T> => {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as T;
};

async function upload(
  harness: Harness,
  bytes: Buffer,
  options: Record<string, unknown> = {},
  token = ADMIN_TOKEN,
): Promise<{ file: any; sha256: string }> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const session = await ok<{ id: string; url: string; method: string; expiresAt: string }>(
    await post(
      harness,
      '/v1/space/files/upload-url',
      {
        name: '库存快照.txt',
        mime: 'text/plain',
        size: bytes.byteLength,
        sha256,
        ...options,
      },
      token,
    ),
  );
  assert.equal(session.method, 'PUT');
  const target = session.url.startsWith('http') ? session.url : `${harness.url}${session.url}`;
  const put = await fetch(target, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) },
    body: bytes,
  });
  const uploaded = await ok<{ status: string; sha256: string; size: number }>(put);
  assert.equal(uploaded.status, 'uploaded');
  assert.equal(uploaded.sha256, sha256);
  const file = await ok<any>(await post(harness, `/v1/space/uploads/${session.id}/complete`, {}, token));
  return { file, sha256 };
}

test('本地对象存储：申请、PUT、确认，随后可流式读取与按 Range 读取', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const bytes = Buffer.from('库存快照：M-100 剩 30 件\n', 'utf8');
    const { file, sha256 } = await upload(harness, bytes);

    assert.equal(file.taskId, null);
    assert.equal(file.storage, 'fs');
    assert.equal(file.size, bytes.byteLength);
    assert.equal(file.sha256, sha256);
    assert.equal(file.status, 'ready');

    const status = await fetch(`${harness.url}/v1/space/uploads/${file.id}`, {
      headers: authHeaders(),
    });
    assert.equal(status.status, 404, '上传 ID 与文件 ID 不是一回事');

    const download = await fetch(`${harness.url}/v1/space/files/${file.id}/content`, {
      headers: authHeaders(),
    });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

    const ranged = await fetch(`${harness.url}/v1/space/files/${file.id}/content`, {
      headers: authHeaders(ADMIN_TOKEN, { range: 'bytes=0-8' }),
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 0-8/${bytes.byteLength}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 9));

    const json = await ok<any>(
      await fetch(`${harness.url}/v1/space/files/${file.id}`, { headers: authHeaders() }),
    );
    assert.equal(Buffer.from(json.data, 'base64').toString('utf8'), bytes.toString('utf8'));
  } finally {
    await harness.close();
  }
});

test('同一团队同一份内容只落一个对象，文件记录可以有多条', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const bytes = Buffer.from('重复的证据\n'.repeat(20), 'utf8');
    const first = await upload(harness, bytes);
    const second = await upload(harness, bytes, { name: '另一份副本.txt' });
    assert.notEqual(first.file.id, second.file.id);
    assert.equal(first.sha256, second.sha256);

    const objects = await harness.db.read.all(
      'SELECT * FROM space_objects WHERE workspace = :workspace AND sha256 = :sha',
      { workspace: 'acme', sha: first.sha256 },
    );
    assert.equal(objects.length, 1, '同一哈希只应有一个对象');
    const files = await harness.db.read.all(
      'SELECT id FROM space_files WHERE workspace = :workspace AND sha256 = :sha',
      { workspace: 'acme', sha: first.sha256 },
    );
    assert.equal(files.length, 2);
  } finally {
    await harness.close();
  }
});

test('上传校验：哈希不符拒绝，令牌只能用于一次上传', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const bytes = Buffer.from('真实内容', 'utf8');
    const wrong = createHash('sha256').update('别的内容').digest('hex');
    const session = await ok<{ id: string; url: string }>(
      await post(harness, '/v1/space/files/upload-url', {
        name: '伪造.txt',
        mime: 'text/plain',
        size: bytes.byteLength,
        sha256: wrong,
      }),
    );
    const put = await fetch(`${harness.url}${session.url}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: bytes,
    });
    assert.equal(put.status, 400);
    assert.equal(((await put.json()) as any).error.code, 'invalid');

    await upload(harness, bytes);
    const reused = await fetch(`${harness.url}${session.url}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('another'),
    });
    assert.notEqual(reused.status, 200, '已失败的令牌不能变成任意写入通道');
  } finally {
    await harness.close();
  }
});

test('任务文件走新上传接口后进入房间时间线，任务内可下载', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const task = await ok<{ id: string }>(
      await post(harness, '/v1/tasks', { ...TASK_INPUT, ownership: 'personal' }, alice.token),
    );
    const bytes = Buffer.from('现场照片的占位内容', 'utf8');
    const { file } = await upload(
      harness,
      bytes,
      {
        name: '现场照片.txt',
        taskId: task.id,
        kind: 'output',
      },
      alice.token,
    );
    assert.equal(file.taskId, task.id);

    const room = await ok<any>(
      await fetch(`${harness.url}/v1/tasks/${task.id}/room`, { headers: authHeaders(alice.token) }),
    );
    assert.ok(room.files.some((entry: any) => entry.id === file.id));

    const taskDownload = await fetch(
      `${harness.url}/v1/tasks/${task.id}/files/${file.id}/content`,
      { headers: authHeaders(alice.token) },
    );
    assert.equal(taskDownload.status, 200);
    assert.deepEqual(Buffer.from(await taskDownload.arrayBuffer()), bytes);
  } finally {
    await harness.close();
  }
});

test('AICD 独立附件：不绑任务也能上传、挂到文档并读取', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const doc = await ok<any>(
      await post(harness, '/v1/aicds', {
        kind: 'document',
        title: '补货检查表',
        content: '先看库存，再确认供应商交期。',
        tags: ['补货'],
      }),
    );
    const bytes = Buffer.from('%PDF-1.4\nattachment fixture\n', 'utf8');
    const { file } = await upload(harness, bytes, {
      name: '补货检查表.pdf',
      mime: 'application/pdf',
      kind: 'attachment',
    });
    const other = await register(harness, 'other-agent', ['agent']);
    await expectStatus(other.downloadFile(file.id), 403);

    const attached = await ok<any>(
      await post(harness, `/v1/aicds/${doc.id}/assets`, { fileId: file.id, role: 'attachment' }),
    );
    assert.equal(attached.fileId, file.id);

    const assets = await ok<any[]>(
      await fetch(`${harness.url}/v1/aicds/${doc.id}/assets`, { headers: authHeaders() }),
    );
    assert.equal(assets.length, 1);
    assert.equal(assets[0].taskId, null);
    assert.equal(assets[0].role, 'attachment');

    const content = await fetch(`${harness.url}/v1/space/files/${file.id}/content`, {
      headers: authHeaders(),
    });
    assert.equal(content.status, 200);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
  } finally {
    await harness.close();
  }
});

test('软删除立即不可读，对象字节保留以便按保留期回收', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const { file, sha256 } = await upload(harness, Buffer.from('待删除附件', 'utf8'));
    await ok(await post(harness, `/v1/space/files/${file.id}/delete`, {}));
    const missing = await fetch(`${harness.url}/v1/space/files/${file.id}/content`, {
      headers: authHeaders(),
    });
    assert.equal(missing.status, 404);
    const object = await harness.db.read.one(
      'SELECT object_key FROM space_objects WHERE workspace = :workspace AND sha256 = :sha',
      { workspace: 'acme', sha: sha256 },
    );
    assert.ok(object, '软删除不应立即删对象');
  } finally {
    await harness.close();
  }
});
