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

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
    this.queryable = new PgQueryable(this.pool);
    this.read = this.queryable;
  }

  all<T = Row>(sql: string, params: SqlParams = {}): Promise<T[]> {
    return this.queryable.all<T>(sql, params);
  }

  one<T = Row>(sql: string, params: SqlParams = {}): Promise<T | undefined> {
    return this.queryable.one<T>(sql, params);
  }

  run(sql: string, params: SqlParams = {}): Promise<number> {
    return this.queryable.run(sql, params);
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function openPostgres(url: string): Database {
  return new PostgresDatabase(url);
}
