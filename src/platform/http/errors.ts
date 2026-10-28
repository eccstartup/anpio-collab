/**
 * 错误归一化。
 *
 * 领域层抛 AppError；数据库约束冲突等底层错误在这里翻译成有意义的 4xx，
 * 避免把 "UNIQUE constraint failed" 变成 500 或直接泄漏给调用方。
 */

import { AppError, conflict, invalid } from '../../protocol/errors.ts';

type PostgresError = { code?: string; constraint?: string };
type SqliteError = { code?: string; message?: string };

const isUniqueViolation = (error: unknown): boolean => {
  const pg = error as PostgresError;
  if (pg?.code === '23505') return true;
  const sqlite = error as SqliteError;
  return typeof sqlite?.message === 'string' && sqlite.message.includes('UNIQUE constraint failed');
};

const isForeignKeyViolation = (error: unknown): boolean => {
  const pg = error as PostgresError;
  if (pg?.code === '23503') return true;
  const sqlite = error as SqliteError;
  return typeof sqlite?.message === 'string' && sqlite.message.includes('FOREIGN KEY constraint failed');
};

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (isUniqueViolation(error)) return conflict('对象已存在，或同一请求已被处理');
  if (isForeignKeyViolation(error)) return invalid('引用的对象不存在');
  return new AppError('internal', '服务器内部错误', { cause: error });
}
