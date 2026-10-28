/**
 * 运行时校验原语。
 *
 * 每个函数在输入不合法时抛出 AppError('invalid')，错误信息直接面向调用方，
 * 因此需要写清字段名和期望。刻意不引入 schema 库：协议字段很少，
 * 显式读取比隐式 DSL 更容易审阅。
 */

import { invalid } from './errors.ts';

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown, name = 'body'): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${name} 必须是 JSON 对象`);
  }
  return value as JsonObject;
}

export function asString(
  value: unknown,
  name: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  const { min = 1, max = 4000, pattern } = options;
  if (typeof value !== 'string') throw invalid(`${name} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw invalid(`${name} 不能为空`);
  if (value.length > max) throw invalid(`${name} 过长（上限 ${max} 字符）`);
  if (pattern && !pattern.test(trimmed)) throw invalid(`${name} 格式不合法`);
  return trimmed;
}

export function asOptionalString(
  value: unknown,
  name: string,
  options: { max?: number } = {},
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, name, { min: 0, max: options.max ?? 4000 });
}

/** 标识符：限制为可安全出现在 URL、日志和 SQL 参数里的字符集。 */
export function asId(value: unknown, name: string): string {
  return asString(value, name, { max: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ });
}

export function asInteger(
  value: unknown,
  name: string,
  options: { min?: number; max?: number } = {},
): number {
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = options;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(`${name} 必须是整数`);
  }
  if (value < min || value > max) throw invalid(`${name} 必须在 ${min}..${max} 之间`);
  return value;
}

/** 只接受 UTC ISO 8601（含 Z）。本地时区时间会被拒绝，避免跨时区歧义。 */
export function asTimestamp(value: unknown, name: string): string {
  const text = asString(value, name, { max: 64 });
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(text)) {
    throw invalid(`${name} 必须是 UTC 时间，例如 2026-10-28T00:00:00Z`);
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw invalid(`${name} 不是有效时间`);
  const normalized = new Date(parsed).toISOString();
  if (normalized.slice(0, 19) !== text.slice(0, 19)) {
    throw invalid(`${name} 是不存在的日期`);
  }
  return normalized;
}

export function asEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalid(`${name} 必须是 ${allowed.join(' / ')} 之一`);
  }
  return value as T;
}

export function asBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`${name} 必须是布尔值`);
  return value;
}

export function asStringArray(
  value: unknown,
  name: string,
  options: { max?: number; maxLength?: number } = {},
): string[] {
  const { max = 100, maxLength = 200 } = options;
  if (!Array.isArray(value)) throw invalid(`${name} 必须是字符串数组`);
  if (value.length > max) throw invalid(`${name} 最多 ${max} 项`);
  const items = value.map((item, index) => asString(item, `${name}[${index}]`, { max: maxLength }));
  if (new Set(items).size !== items.length) throw invalid(`${name} 存在重复项`);
  return items;
}

/**
 * 任务输入是开放的 JSON 对象，但限制为一层标量字段：
 * 深层嵌套会让检索、展示与审计都变得不可控。
 */
export function asTaskInput(value: unknown, name = 'input'): JsonObject {
  const object = asObject(value, name);
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(object)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw invalid(`${name}.${key} 字段名不合法`);
    }
    const type = typeof item;
    if (item === null || (type !== 'string' && type !== 'number' && type !== 'boolean')) {
      throw invalid(`${name}.${key} 只允许字符串、数字或布尔值`);
    }
    if (type === 'string' && (item as string).length > 1000) {
      throw invalid(`${name}.${key} 过长`);
    }
    if (type === 'number' && !Number.isFinite(item as number)) {
      throw invalid(`${name}.${key} 必须是有限数字`);
    }
    result[key] = item;
  }
  return result;
}

/** 从查询串读取整数，缺省时返回默认值。 */
export function queryInteger(
  params: URLSearchParams,
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw invalid(`${name} 必须是整数`);
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  if (value < min || value > max) throw invalid(`${name} 必须在 ${min}..${max} 之间`);
  return value;
}
