/**
 * 数据库抽象。
 *
 * 关键约定：读写分离到两条路径上。
 *  - `db.read` 只读，看到的是最后一次已提交的状态；
 *  - `db.transaction(fn)` 在写连接上执行，未提交的中间状态对读路径不可见。
 *
 * 这样"读"不需要和"写事务"抢同一把全局锁，也不会让读请求看到
 * 之后被回滚的数据。SQLite 用一条只读连接实现，PostgreSQL 用连接池实现。
 */

import type { Dialect, SqlParams } from './sql.ts';

export type Row = Record<string, unknown>;

export interface Queryable {
  all<T = Row>(sql: string, params?: SqlParams): Promise<T[]>;
  one<T = Row>(sql: string, params?: SqlParams): Promise<T | undefined>;
  /** 返回受影响行数。 */
  run(sql: string, params?: SqlParams): Promise<number>;
}

export interface Database extends Queryable {
  readonly dialect: Dialect;
  /** 只读通道：只能看到已提交数据。 */
  readonly read: Queryable;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** 仅用于 DDL 与运维语句，不参与业务查询。 */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
