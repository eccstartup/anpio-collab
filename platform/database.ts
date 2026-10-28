import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

type Row = Record<string, any>;
export interface Database {
  dialect: 'sqlite' | 'postgres';
  exec(sql: string): Promise<void>;
  one(sql: string, params: any[]): Promise<Row | undefined>;
  all(sql: string, params: any[]): Promise<Row[]>;
  run(sql: string, params: any[]): Promise<{ changes: number }>;
  close(): Promise<void>;
}
export class SQLiteDatabase implements Database {
  dialect = 'sqlite' as const;
  connection: DatabaseSync;
  constructor(path: string) { this.connection = new DatabaseSync(path); }
  async exec(sql: string) { this.connection.exec(sql); }
  async one(sql: string, params: any[]) { return this.connection.prepare(sql).get(...params) as Row | undefined; }
  async all(sql: string, params: any[]) { return this.connection.prepare(sql).all(...params) as Row[]; }
  async run(sql: string, params: any[]) { return { changes: Number(this.connection.prepare(sql).run(...params).changes) }; }
  async close() { this.connection.close(); }
}
function postgresSQL(sql: string) {
  let index=0;
  return sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g,'BIGSERIAL PRIMARY KEY')
    .replace(/quantity INTEGER/g,'quantity BIGINT')
    .replace(/INSERT OR IGNORE INTO ([^;]+)/g,'INSERT INTO $1 ON CONFLICT DO NOTHING')
    .replace(/instr\(/g,'strpos(')
    .replace(/\?/g,()=>`$${++index}`);
}
export class PostgresDatabase implements Database {
  dialect = 'postgres' as const;
  connection: pg.Client;
  constructor(url: string) {
    this.connection=new pg.Client({connectionString:url,types:{getTypeParser(oid: number, format?: string) {
      if(oid===20) return (value: string)=>Number(value);
      return pg.types.getTypeParser(oid,format as 'text');
    }}});
  }
  async connect() { await this.connection.connect(); }
  async exec(sql: string) {
    const statements=sql.replace(/PRAGMA[^;]*;/g,'').trim();
    if(statements) await this.connection.query(postgresSQL(statements));
  }
  async one(sql: string, params: any[]) { return (await this.connection.query(postgresSQL(sql),params)).rows[0] as Row | undefined; }
  async all(sql: string, params: any[]) { return (await this.connection.query(postgresSQL(sql),params)).rows as Row[]; }
  async run(sql: string, params: any[]) { return {changes:(await this.connection.query(postgresSQL(sql),params)).rowCount ?? 0}; }
  async close() { await this.connection.end(); }
}
