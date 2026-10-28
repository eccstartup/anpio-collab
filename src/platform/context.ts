/**
 * 运行时上下文。
 *
 * 时间与 ID 生成都通过注入，测试可以用固定时钟构造确定性场景；
 * 生产代码永远通过这里取时间，避免各模块各自 new Date()。
 */

import { randomUUID } from 'node:crypto';
import type { Database } from './db/driver.ts';

export type Context = {
  db: Database;
  /** 返回 UTC ISO 8601 时间，毫秒精度以下截断到毫秒。 */
  now: () => string;
  /** 生成新对象 ID。 */
  newId: () => string;
};

export function createContext(
  db: Database,
  options: { now?: () => string; newId?: (prefix?: string) => string } = {},
): Context {
  return {
    db,
    now: options.now ?? (() => new Date().toISOString()),
    newId: options.newId ?? (() => randomUUID()),
  };
}

/** 解析相对当前时间的偏移，用于 dueAt 缺省值。 */
export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 24 * 60 * 60 * 1000).toISOString();
}
