/**
 * 测试基座：临时数据库 + 真实 HTTP 服务 + 已初始化的管理员。
 *
 * 每个测试用独立 SQLite 文件，避免互相污染；设置 COLLAB_TEST_DATABASE
 * 时改用该 PostgreSQL，并在开始时清空 schema，用于验证方言差异。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../../src/platform/app.ts';
import type { Database } from '../../src/platform/db/driver.ts';
import { openDatabase } from '../../src/platform/db/index.ts';
import { createServer } from '../../src/platform/http/server.ts';
import { CollabClient } from '../../src/sdk/client.ts';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { CollabError } from '../../src/sdk/client.ts';

export const ADMIN_TOKEN = 'admin-token-0123456789abcdef';
export const ADMIN_ID = 'admin';

export type Harness = {
  app: App;
  db: Database;
  url: string;
  directory: string;
  databasePath: string;
  server: http.Server;
  admin: CollabClient;
  token(prefix?: string): string;
  client(token: string): CollabClient;
  /** 关闭服务与数据库但保留目录，用于重启与备份测试。 */
  stop(): Promise<void>;
  close(): Promise<void>;
};

async function resetPostgres(db: Database): Promise<void> {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

export async function startHarness(
  options: { workspace?: string; enroll?: 'open' | 'pending' | 'off' } = {},
): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'collab-test-'));
  const postgres = process.env.COLLAB_TEST_DATABASE;
  const databasePath = postgres ?? join(directory, 'collab.sqlite3');
  const db = openDatabase(databasePath);
  if (postgres) await resetPostgres(db);

  const workspace = options.workspace ?? 'acme';
  const app = await createApp(db, {
    identity: { workspace, enroll: options.enroll ?? 'open' },
  });
  await app.principals.bootstrap(workspace, {
    id: ADMIN_ID,
    roles: ['admin', 'owner', 'reviewer'],
    token: ADMIN_TOKEN,
    displayName: '管理员',
  });

  const server = createServer({
    app,
    webRoot: new URL('../../src/web', import.meta.url).pathname,
    bodyLimit: 65536,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    app,
    db,
    url,
    directory,
    databasePath,
    server,
    admin: new CollabClient(url, ADMIN_TOKEN),
    token: (prefix = 'agent') => `${prefix}-${randomBytes(16).toString('hex')}`,
    client: token => new CollabClient(url, token),
    stop: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await db.close();
    },
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** 登记一个带指定角色的主体并返回其客户端。 */
export async function register(
  harness: Harness,
  id: string,
  roles: string[],
  options: { capabilities?: string[] } = {},
): Promise<CollabClient> {
  const token = harness.token(id);
  await harness.admin.registerPrincipal(
    { id, roles, token, displayName: id, capabilities: options.capabilities ?? [] },
    `register:${id}`,
  );
  return harness.client(token);
}

let operationCounter = 0;
export const nextOperationId = (prefix = 'op'): string => `${prefix}:${++operationCounter}`;

/** 常用测试数据：一个待分派的缺料分析任务。 */
export const TASK_INPUT = {
  title: '缺料分析 M-100',
  type: 'shortage-analysis',
  goal: '判断 100 件 M-100 能否按时交付',
  acceptance: '核对库存与供应商数据来源与时效',
  input: { material: 'M-100', quantity: 100 },
};

/** 断言请求以指定 HTTP 状态失败，并输出实际消息便于定位。 */
export async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const failure = error as CollabError;
    assert.ok(error instanceof CollabError, `期望 CollabError，实际 ${String(error)}`);
    assert.equal(failure.status, status, `期望 HTTP ${status}，实际 ${failure.status}: ${failure.message}`);
    return true;
  });
}
