import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, chmodSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CollabClient } from './client.ts';

/** Single-host journal: the lease is recovered only when its recorded process is absent. */
export class RequestJournal {
  private db: DatabaseSync;
  private lease = randomUUID();
  constructor(path: string, binding: {url: string; principal: string; workspace: string}) {
    closeSync(openSync(path,'a',0o600)); chmodSync(path,0o600);
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pending(operation TEXT PRIMARY KEY,path TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,pid INTEGER NOT NULL,host TEXT NOT NULL);`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const encoded=JSON.stringify(binding);
      const old=this.db.prepare("SELECT value FROM journal_meta WHERE key='binding'").get() as {value:string}|undefined;
      if(!old && this.db.prepare('SELECT 1 FROM pending LIMIT 1').get()) throw new Error('Unbound legacy journal has pending requests; reconcile before migration');
      if(old && old.value!==encoded) throw new Error('Journal belongs to a different service or principal');
      const held=this.db.prepare('SELECT * FROM journal_lease WHERE singleton=1').get() as {pid:number,host:string}|undefined;
      if(held) {
        if(held.host!==hostname()) throw new Error('Journal lease belongs to another host');
        let alive=true;
        try { process.kill(held.pid,0); } catch(e) { if((e as NodeJS.ErrnoException).code==='ESRCH') alive=false; }
        if(alive) throw new Error('Journal is already in use');
      }
      this.db.prepare("INSERT OR IGNORE INTO journal_meta VALUES('binding',?)").run(encoded);
      this.db.prepare('INSERT OR REPLACE INTO journal_lease VALUES(1,?,?,?)').run(this.lease,process.pid,hostname());
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); this.db.close(); throw e; }
  }
  async replay(client: CollabClient) {
    for(const row of this.db.prepare('SELECT * FROM pending ORDER BY rowid').all() as {path:string,body:string,operation:string}[]) {
      await this.send(client,row.path,JSON.parse(row.body),row.operation);
    }
  }
  async send(client: CollabClient,path: string,body: unknown,operation: string) {
    const encoded=JSON.stringify(body);
    this.db.prepare('INSERT OR IGNORE INTO pending VALUES(?,?,?)').run(operation,path,encoded);
    const row=this.db.prepare('SELECT * FROM pending WHERE operation=?').get(operation) as {path:string,body:string};
    if(row.path!==path||row.body!==encoded) throw new Error('Pending operation conflicts with request');
    const result=await client.request(path,body,operation);
    this.db.prepare('DELETE FROM pending WHERE operation=?').run(operation);
    return result;
  }
  close() {
    this.db.prepare('DELETE FROM journal_lease WHERE owner=?').run(this.lease);
    this.db.close();
  }
}
