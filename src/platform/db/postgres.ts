/**
 * PostgreSQL 驱动。
 *
 * 用连接池而不是单连接：事务独占一条连接，普通查询各自取用连接，
 * 因此读请求和写事务天然并发。行级冲突由业务层的版本条件更新处理。
 */

import pg from 'pg';
import { compile, type SqlParams } from './sql.ts';
import type { Database, Queryable, Row } from './driver.ts';
import { activeTransaction, runInTransaction } from './transaction.ts';

// BIGSERIAL 默认返回字符串，统一转成 number；本项目的序号都在安全整数范围内。
pg.types.setTypeParser(20, (value: string) => Number(value));

class PgQueryable implements Queryable {
  private readonly executor: pg.Pool | pg.PoolClient;

  constructor(executor: pg.Pool | pg.PoolClient) {
    this.executor = executor;
  }

  async all<T = Row>(sql: string, params: SqlParams = {}): Promise<T[]> {
    const { text, values } = compile(sql, 'postgres', params);
    const result = await this.executor.query(text, values);
    return result.rows as T[];
  }

  async one<T = Row>(sql: string, params: SqlParams = {}): Promise<T | undefined> {
    const { text, values } = compile(sql, 'postgres', params);
    const result = await this.executor.query(text, values);
    return result.rows[0] as T | undefined;
  }

  async run(sql: string, params: SqlParams = {}): Promise<number> {
    const { text, values } = compile(sql, 'postgres', params);
    const result = await this.executor.query(text, values);
    return result.rowCount ?? 0;
  }
}

class PostgresDatabase implements Database {
  readonly dialect = 'postgres' as const;
  readonly read: Queryable;
  private readonly pool: pg.Pool;
  private readonly queryable: PgQueryable;
  private closed = false;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
    this.queryable = new PgQueryable(this.pool);
    this.read = {
      all: (sql, params) => this.all(sql, params),
      one: (sql, params) => this.one(sql, params),
      run: (sql, params) => this.run(sql, params),
    };
  }

  /** 事务内的读必须走事务连接，否则看不到本事务刚写入的行。 */
  private active(): Queryable | undefined {
    const active = activeTransaction();
    return active === this.queryable ? undefined : active;
  }

  all<T = Row>(sql: string, params: SqlParams = {}): Promise<T[]> {
    const active = this.active();
    return active ? active.all<T>(sql, params) : this.queryable.all<T>(sql, params);
  }

  one<T = Row>(sql: string, params: SqlParams = {}): Promise<T | undefined> {
    const active = this.active();
    return active ? active.one<T>(sql, params) : this.queryable.one<T>(sql, params);
  }

  run(sql: string, params: SqlParams = {}): Promise<number> {
    const active = this.active();
    return active ? active.run(sql, params) : this.queryable.run(sql, params);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    // 已在事务中：加入外层事务，避免嵌套 BEGIN。
    const active = activeTransaction();
    if (active) return fn(active);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await runInTransaction(new PgQueryable(client), fn);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 连接可能已断开，忽略回滚失败，交由上层处理原始错误。
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  /** 允许重复关闭：停机流程与测试清理都可能调用，pg 的 pool.end() 只接受一次。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

export function openPostgres(url: string): Database {
  return new PostgresDatabase(url);
}
