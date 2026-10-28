/**
 * 一致性备份（SQLite）。
 *
 * 运行中的数据库不能直接复制文件：WAL 里可能还有未合并的页。
 * 这里用 SQLite 的 VACUUM INTO 在只读连接上生成一致快照，并校验完整性。
 *
 * 用法：node src/platform/tools/backup.ts collab.sqlite3 /secure/collab-backup.sqlite3
 *
 * PostgreSQL 部署请使用 pg_dump 或云厂商的备份能力；本工具不代为实现。
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isMain } from '../runtime.ts';

export function backupSqlite(source: string, destination: string): void {
  if (existsSync(destination)) throw new Error('目标文件已存在，请换一个路径');
  if (!existsSync(source)) throw new Error('源数据库不存在');
  if (/^postgres/.test(source)) throw new Error('这是 PostgreSQL 连接串，请使用 pg_dump');

  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
    if (Object.values(check)[0] !== 'ok') throw new Error('源数据库完整性检查失败');
    db.prepare('VACUUM INTO ?').run(destination);
  } finally {
    db.close();
  }

  const backup = new DatabaseSync(destination, { readOnly: true });
  try {
    const check = backup.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
    if (Object.values(check)[0] !== 'ok') throw new Error('备份完整性检查失败');
  } finally {
    backup.close();
  }
}

if (isMain(import.meta.url)) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) {
    console.error('用法: node src/platform/tools/backup.ts <现有数据库> <新的备份路径>');
    process.exit(1);
  }
  try {
    backupSqlite(source, destination);
    console.log('备份完成，已通过完整性检查');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
