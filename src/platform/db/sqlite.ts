/**
 * SQLite 驱动（node:sqlite）。
 *
 * 两条连接：
 *  - 写连接负责事务，用 WAL + BEGIN IMMEDIATE，由进程内互斥量串行化；
 *  - 只读连接专供查询，因此读请求不会被写事务阻塞，也看不到未提交数据。
 *
 * 注意 node:sqlite 是同步 API，单进程内所有语句会占用事件循环。
 * 本地原型与单机演示可以接受；企业部署应切换 PostgreSQL。
 */

import { DatabaseSync } from 'node:sqlite';
import { compile, type SqlParams } from './sql.ts';
import type { Database, Queryable, Row } from './driver.ts';
import { activeTransaction, runInTransaction } from './transaction.ts';

type BindValue = null | number | bigint | string | Uint8Array;

/** SQLite 只接受标量与二进制，布尔值转 0/1，其余类型在开发阶段就报错。 */
const toSqliteValue = (value: unknown): BindValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  throw new Error(`不支持的 SQL 参数类型: ${typeof value}`);
};

class SqliteConnection implements Queryable {
  private readonly connection: DatabaseSync;

  constructor(connection: DatabaseSync) {
    this.connection = connection;
  }

  async all<T = Row>(sql: string, params: SqlParams = {}): Promise<T[]> {
    const { text, values } = compile(sql, 'sqlite', params);
    return this.connection.prepare(text).all(...values.map(toSqliteValue)) as T[];
  }

  async one<T = Row>(sql: string, params: SqlParams = {}): Promise<T | undefined> {
    const { text, values } = compile(sql, 'sqlite', params);
    return this.connection.prepare(text).get(...values.map(toSqliteValue)) as T | undefined;
  }

  async run(sql: string, params: SqlParams = {}): Promise<number> {
    const { text, values } = compile(sql, 'sqlite', params);
    const result = this.connection.prepare(text).run(...values.map(toSqliteValue));
    return Number(result.changes);
  }

  exec(sql: string): void {
    this.connection.exec(sql);
  }

  close(): void {
    this.connection.close();
  }
}

/** 进程内互斥量：只允许一个写事务同时进行。 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

class SqliteDatabase implements Database {
  readonly dialect = 'sqlite' as const;
  readonly read: Queryable;
  private readonly writer: SqliteConnection;
  private readonly reader: SqliteConnection;
  private readonly mutex = new Mutex();
  private closed = false;

  constructor(path: string) {
    // 写连接先建立并置为 WAL，再打开只读连接；只读连接需要已存在的库文件。
    const writerHandle = new DatabaseSync(path);
    writerHandle.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
    `);
    const readerHandle = new DatabaseSync(path, { readOnly: true });
    readerHandle.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

    this.writer = new SqliteConnection(writerHandle);
    this.reader = new SqliteConnection(readerHandle);
    this.read = {
      all: (sql, params) => this.all(sql, params),
      one: (sql, params) => this.one(sql, params),
      run: (sql, params) => this.run(sql, params),
    };
  }

  /** 事务内的读必须走事务连接，否则看不到本事务刚写入的行（读己之写）。 */
  private active(): Queryable | undefined {
    return activeTransaction();
  }

  async all<T = Row>(sql: string, params: SqlParams = {}): Promise<T[]> {
    const active = this.active();
    if (active) return active.all<T>(sql, params);
    return this.reader.all<T>(sql, params);
  }

  async one<T = Row>(sql: string, params: SqlParams = {}): Promise<T | undefined> {
    const active = this.active();
    if (active) return active.one<T>(sql, params);
    return this.reader.one<T>(sql, params);
  }

  async run(sql: string, params: SqlParams = {}): Promise<number> {
    const active = this.active();
    if (active) return active.run(sql, params);
    return this.mutex.run(async () => this.writer.run(sql, params));
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    // 已在事务中：加入外层事务，由最外层负责提交或回滚。
    const active = activeTransaction();
    if (active) return fn(active);
    return this.mutex.run(async () => {
      this.writer.exec('BEGIN IMMEDIATE');
      try {
        const result = await runInTransaction(this.writer, fn);
        this.writer.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.writer.exec('ROLLBACK');
        } catch {
          // 事务可能已被 SQLite 自动回滚，忽略二次回滚错误。
        }
        throw error;
      }
    });
  }

  async exec(sql: string): Promise<void> {
    this.writer.exec(sql);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.writer.exec('PRAGMA optimize');
    this.writer.close();
    this.reader.close();
  }
}

export function openSqlite(path: string): Database {
  if (path === ':memory:' || path.startsWith('file::memory:')) {
    throw new Error('SQLite 内存库无法提供独立的只读连接，请使用文件路径');
  }
  return new SqliteDatabase(path);
}
