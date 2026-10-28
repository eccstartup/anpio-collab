/**
 * 数据库选择：按连接串决定方言，调用方无需关心。
 */

import type { Database } from './driver.ts';
import { openPostgres } from './postgres.ts';
import { openSqlite } from './sqlite.ts';

export function openDatabase(target: string): Database {
  if (/^postgres(ql)?:\/\//.test(target)) return openPostgres(target);
  return openSqlite(target);
}
