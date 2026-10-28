/**
 * 单机请求日志（write-ahead journal）。
 *
 * 智能体在发送写请求之前，先把 operationId 与完整请求体落盘；
 * 请求确认后才删除。进程崩溃或断线后重放同样的 operationId 与请求体，
 * 平台按幂等规则返回同一个结果，不会重复执行。
 *
 * 限制：只适用于单机、单进程。日志绑定服务地址与主体身份，防止误连。
 */

import { chmodSync, closeSync, openSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { CollabClient } from './client.ts';

export type JournalBinding = { url: string; principal: string; workspace: string };

type PendingRow = { operation: string; path: string; body: string };

export class RequestJournal {
  private readonly db: DatabaseSync;
  private readonly lease = randomUUID();
  private closed = false;

  constructor(path: string, binding: JournalBinding) {
    // 以 0600 创建，避免同机其他用户读取待发送内容。
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pending(operation TEXT PRIMARY KEY, path TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_lease(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL
      );
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const encoded = JSON.stringify(binding);
      const stored = this.db.prepare("SELECT value FROM journal_meta WHERE key = 'binding'").get() as
        | { value: string }
        | undefined;
      if (!stored && this.db.prepare('SELECT 1 FROM pending LIMIT 1').get()) {
        throw new Error('旧日志绑定缺失但存在待发送请求，请先人工核对再迁移');
      }
      if (stored && stored.value !== encoded) {
        throw new Error('该日志属于另一个服务地址或主体');
      }
      const held = this.db.prepare('SELECT pid, host FROM journal_lease WHERE singleton = 1').get() as
        | { pid: number; host: string }
        | undefined;
      if (held) {
        if (held.host !== hostname()) throw new Error('该日志正被另一台主机占用');
        let alive = true;
        try {
          process.kill(held.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        }
        if (alive) throw new Error('该日志已被其他进程占用');
      }
      this.db.prepare("INSERT OR IGNORE INTO journal_meta VALUES('binding', ?)").run(encoded);
      this.db.prepare('INSERT OR REPLACE INTO journal_lease VALUES(1, ?, ?, ?)').run(
        this.lease,
        process.pid,
        hostname(),
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  /** 重放上次未确认的写请求，按写入顺序。 */
  async replay(client: CollabClient): Promise<number> {
    const rows = this.db.prepare('SELECT * FROM pending ORDER BY rowid').all() as PendingRow[];
    for (const row of rows) {
      await this.send(client, row.path, JSON.parse(row.body), row.operation);
    }
    return rows.length;
  }

  async send(client: CollabClient, path: string, body: unknown, operationId: string): Promise<unknown> {
    const encoded = JSON.stringify(body ?? {});
    this.db.prepare('INSERT OR IGNORE INTO pending VALUES(?, ?, ?)').run(operationId, path, encoded);
    const row = this.db.prepare('SELECT path, body FROM pending WHERE operation = ?').get(operationId) as
      | PendingRow
      | undefined;
    if (!row || row.path !== path || row.body !== encoded) {
      throw new Error('待发送请求与本次请求冲突，请先人工核对日志');
    }
    const result = await client.request(path, { body, operationId });
    this.db.prepare('DELETE FROM pending WHERE operation = ?').run(operationId);
    return result;
  }

  pendingCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM pending').get() as { n: number };
    return Number(row.n);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.prepare('DELETE FROM journal_lease WHERE owner = ?').run(this.lease);
    this.db.close();
  }
}
