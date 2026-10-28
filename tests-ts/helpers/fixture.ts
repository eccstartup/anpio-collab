import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Store } from '../../platform/store.ts';
import { createServer } from '../../platform/server.ts';
import { CollabClient } from '../../sdk/client.ts';

export const taskInput={title:'缺料分析',material:'M-100',quantity:100,due:'2099-01-01T00:00:00Z',acceptance:'核对来源'};
export async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'collab-test-'));
  let database=join(dir,'platform.sqlite');
  let control: pg.Client | undefined;
  const schema='test_'+randomUUID().replaceAll('-','');
  if(process.env.COLLAB_TEST_DATABASE) {
    control=new pg.Client({connectionString:process.env.COLLAB_TEST_DATABASE}); await control.connect();
    await control.query(`CREATE SCHEMA ${schema}`);
    const url=new URL(process.env.COLLAB_TEST_DATABASE); url.searchParams.set('options',`-c search_path=${schema}`); database=url.toString();
  }
  let store=await Store.open(database);
  const token='admin-'+randomUUID();
  await store.bootstrap({id:'admin',workspace:'acme',roles:['admin','owner','reviewer'],token,active:true});
  let server=createServer(store);
  async function listen() { await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}); }
  await listen();
  let url=`http://127.0.0.1:${(server.address() as any).port}`;
  const clients: {client:CollabClient,token:string}[]=[];
  function client(t: string) { const c=new CollabClient(url,t);clients.push({client:c,token:t});return c; }
  const admin=client(token);
  async function stop() { await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); await store.close(); }
  return {
    dir,database,admin,adminToken:token, get store(){return store;},get url(){return url;},client,
    async register(id: string,roles=['agent']) {const t=id+'-'+randomUUID();await admin.request('principals',{id,roles,token:t});return client(t);},
    async restart() {await stop();store=await Store.open(database);server=createServer(store);await listen();url=`http://127.0.0.1:${(server.address() as any).port}`;for(const {client:c} of clients)c.baseUrl=url;},
    async close() {await stop();if(control){await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();}rmSync(dir,{recursive:true,force:true});}
  };
}
