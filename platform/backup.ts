/** Consistent SQLite snapshot using VACUUM INTO. The destination must not already exist. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
const [source,destination]=process.argv.slice(2);
if (!source || !destination || existsSync(destination)) throw new Error('Usage: node platform/backup.ts EXISTING_DATABASE NEW_BACKUP_PATH');
if (!existsSync(source)) throw new Error('Source database does not exist');
const db=new DatabaseSync(source,{readOnly:true});
try {
  const check=db.prepare('PRAGMA integrity_check').get() as Record<string,unknown>;
  if(Object.values(check)[0]!=='ok') throw new Error('Source database integrity check failed');
  db.prepare('VACUUM INTO ?').run(destination);
} finally { db.close(); }
const backup=new DatabaseSync(destination,{readOnly:true});
try {
  const check=backup.prepare('PRAGMA integrity_check').get() as Record<string,unknown>;
  if(Object.values(check)[0]!=='ok') throw new Error('Backup integrity check failed');
} finally { backup.close(); }
console.log('Backup created and integrity checked');
