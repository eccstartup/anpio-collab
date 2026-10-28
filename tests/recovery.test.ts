/**
 * 恢复能力：进程重启、请求日志重放、一致性备份。
 *
 * 这些是"能不能在出故障后解释清楚状态"的最低要求，
 * 不代表已经达到企业级的容灾标准。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/platform/app.ts';
import { openDatabase } from '../src/platform/db/index.ts';
import { createServer } from '../src/platform/http/server.ts';
import { backupSqlite } from '../src/platform/tools/backup.ts';
import { RequestJournal } from '../src/sdk/journal.ts';
import { CollabClient } from '../src/sdk/client.ts';
import { ADMIN_TOKEN, register, startHarness, TASK_INPUT } from './helpers/harness.ts';

const RESULT = { quantity: 30, source: 'fixture', observedAt: '2026-10-28T00:00:00Z' };
const WEB_ROOT = new URL('../src/web', import.meta.url).pathname;

test('进程重启后任务、事件与令牌仍然有效', async () => {
  const harness = await startHarness();
  const created = await harness.admin.createTask(TASK_INPUT, 'create');
  await harness.stop();

  const db = openDatabase(harness.databasePath);
  const app = await createApp(db);
  const server = createServer({ app, webRoot: WEB_ROOT, bodyLimit: 65536 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = new CollabClient(`http://127.0.0.1:${port}`, ADMIN_TOKEN);

  try {
    const me = await client.me();
    assert.equal(me.id, 'admin');
    const detail = await client.task(created.id);
    assert.equal(detail.task.title, TASK_INPUT.title);
    assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0].type, 'task_created');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    await harness.close();
  }
});

test('请求日志在发送失败后重放同一操作，只生效一次', async () => {
  const harness = await startHarness();
  try {
    const agent = await register(harness, 'inv1', ['agent']);
    const created = await harness.admin.createTask(TASK_INPUT, 'create');
    const sub = await harness.admin.assign(created.id, { agent: 'inv1', kind: 'inventory' }, 'assign');
    await agent.accept(sub.id, 'accept');

    const journalPath = join(harness.directory, 'worker.sqlite');
    const journal = new RequestJournal(journalPath, {
      url: harness.url,
      principal: 'inv1',
      workspace: 'acme',
    });
    try {
      // 指向一个不可达端口：请求已落盘，发送失败，模拟崩溃前的状态。
      const broken = new CollabClient('http://127.0.0.1:1', harness.token('inv1'), { timeoutMs: 1000 });
      await assert.rejects(journal.send(broken, `subtasks/${sub.id}/submit`, { result: RESULT }, 'submit-once'));
      assert.equal(journal.pendingCount(), 1);

      // 恢复后重放：平台按幂等返回结果，日志清空。
      const replayed = await journal.replay(agent);
      assert.equal(replayed, 1);
      assert.equal(journal.pendingCount(), 0);

      const detail = await harness.admin.task(created.id);
      assert.equal(detail.subtasks[0].status, 'submitted');
      assert.equal((detail.subtasks[0].result as { quantity?: number }).quantity, 30);

      // 再放一次同样的操作不会产生第二次提交。
      await agent.submit(sub.id, RESULT, 'submit-once');
      const after = await harness.admin.task(created.id);
      assert.equal(after.events.filter(event => event.type === 'subtask_submitted').length, 1);
    } finally {
      journal.close();
    }
  } finally {
    await harness.close();
  }
});

test('备份快照可独立打开并保留全部数据', async () => {
  if (process.env.COLLAB_TEST_DATABASE) return; // PostgreSQL 使用 pg_dump，本工具不处理。
  const harness = await startHarness();
  const created = await harness.admin.createTask(TASK_INPUT, 'create');
  const taskCount = (await harness.admin.tasks()).length;
  await harness.stop();

  const backupPath = join(harness.directory, 'backup.sqlite3');
  backupSqlite(harness.databasePath, backupPath);

  const db = openDatabase(backupPath);
  const app = await createApp(db);
  try {
    const principal = await app.principals.authenticate(ADMIN_TOKEN);
    assert.equal(principal.id, 'admin');
    assert.equal(await app.principals.isEmpty(), false);
    const detail = await app.tasks.detail(principal, created.id);
    assert.equal((detail.task as { id: string }).id, created.id);
    assert.equal(taskCount, 1);
  } finally {
    await db.close();
    await harness.close();
  }
});

test('同一数据库目录不能被两个进程同时写入（日志租约）', async () => {
  const harness = await startHarness();
  try {
    const path = join(harness.directory, 'lease.sqlite');
    const first = new RequestJournal(path, { url: harness.url, principal: 'p', workspace: 'acme' });
    try {
      assert.throws(
        () => new RequestJournal(path, { url: harness.url, principal: 'p', workspace: 'acme' }),
        /占用/,
      );
    } finally {
      first.close();
    }
    // 释放后可以重新获取。
    const second = new RequestJournal(path, { url: harness.url, principal: 'p', workspace: 'acme' });
    second.close();
  } finally {
    await harness.close();
  }
});
