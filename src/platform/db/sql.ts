/**
 * SQL 参数编译。
 *
 * 业务代码统一写 `:name` 形式的命名参数，由这里按方言编译成
 * SQLite 的 `?` 或 PostgreSQL 的 `$1`。这样两种数据库共用同一份 SQL，
 * 又不依赖对 `?` 做正则替换（那会把字符串字面量里的问号也改掉）。
 */

export type Dialect = 'sqlite' | 'postgres';
export type SqlParams = Record<string, unknown>;

export type CompiledSql = { text: string; values: unknown[] };

/** `::` 是 PostgreSQL 的类型转换，不作为参数前缀。 */
const PARAM = /(^|[^:]):([a-z_][a-z0-9_]*)/gi;

export function compile(sql: string, dialect: Dialect, params: SqlParams = {}): CompiledSql {
  const values: unknown[] = [];
  const text = sql.replace(PARAM, (_match, prefix: string, name: string) => {
    if (!(name in params)) throw new Error(`SQL 缺少参数 :${name}`);
    const value = params[name];
    values.push(value === undefined ? null : value);
    return prefix + (dialect === 'postgres' ? `$${values.length}` : '?');
  });
  return { text, values };
}
