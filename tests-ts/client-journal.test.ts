import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {CollabClient,CollabError} from '../sdk/client.ts';
import {RequestJournal} from '../sdk/journal.ts';
import {fixture,taskInput} from './helpers/fixture.ts';

test('journal replays an unconfirmed committed request after platform and worker restart',async()=>{
  const f=await fixture();let journal:RequestJournal|undefined;
  try {
    const agent=await f.register('agent');const task=await f.admin.request('tasks',taskInput);
    const sub=await f.admin.request(`tasks/${task.id}/assign`,{agent:'agent',kind:'inventory'});
    await agent.accept(sub.id,'accept');
    const path=join(f.dir,'journal.sqlite');const binding={url:'logical-test-service',principal:'agent',workspace:'acme'};
    journal=new RequestJournal(path,binding);
    const result={quantity:31,source:'fixture',observedAt:new Date().toISOString()};
    const actual=agent.request.bind(agent);let lose=true;
    agent.request=async(...args)=>{const response=await actual(...args);if(lose){lose=false;throw new CollabError('simulated lost response',0,true);}return response;};
    await assert.rejects(journal.send(agent,`subtasks/${sub.id}/submit`,{result},'fixed-submit'),/lost response/);
    journal.close();journal=undefined;
    await f.restart();
    journal=new RequestJournal(path,binding);await journal.replay(agent);
    const detail=await f.admin.task(task.id);
    assert.deepEqual(detail.subtasks[0].result,result);
    assert.equal(detail.events.filter((e:any)=>e.type==='subtask_submitted').length,1);
    await journal.replay(agent);
    assert.equal((await f.admin.task(task.id)).events.filter((e:any)=>e.type==='subtask_submitted').length,1);
    journal.close();journal=undefined;
    assert.throws(()=>new RequestJournal(path,{...binding,principal:'other'}),/different service or principal/);
  } finally {journal?.close();await f.close();}
});

test('journal prevents simultaneous use and recovers a killed worker lease',async()=>{
  const f=await fixture();const path=join(f.dir,'lease.sqlite');const binding={url:f.url,principal:'agent',workspace:'acme'};
  let child:ReturnType<typeof spawn>|undefined;
  try {
    const journal=new RequestJournal(path,binding);
    assert.throws(()=>new RequestJournal(path,binding),/already in use/);journal.close();
    const script=`import {RequestJournal} from ${JSON.stringify(new URL('../sdk/journal.ts',import.meta.url).href)};const j=new RequestJournal(${JSON.stringify(path)},${JSON.stringify(binding)});process.stdout.write('ready');setInterval(()=>{},1000);`;
    child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
    await once(child.stdout!,'data');
    assert.throws(()=>new RequestJournal(path,binding),/already in use/);
    const exit=once(child,'exit');child.kill('SIGKILL');await exit;child=undefined;
    const recovered=new RequestJournal(path,binding);recovered.close();
    assert.ok(readFileSync(path).length>0);
  } finally {child?.kill('SIGKILL');await f.close();}
});

test('client marks timed-out writes unknown and refuses redirects',async()=>{
  let requests=0;
  const server=http.createServer((req,res)=>{requests++;if(req.url?.includes('redirect')){res.writeHead(302,{location:'/elsewhere'});res.end();}else setTimeout(()=>{res.end('{}');},150);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new CollabClient(`http://127.0.0.1:${(server.address() as any).port}`,'test',{timeoutMs:25});
  try {
    await assert.rejects(client.request('slow',{},'fixed'),(e:any)=>e instanceof CollabError&&e.outcomeUnknown&&e.status===0);
    await assert.rejects(client.request('slow'),(e:any)=>e instanceof CollabError&&!e.outcomeUnknown);
    const before=requests;
    await assert.rejects(client.request('redirect'),(e:any)=>e instanceof CollabError);
    assert.equal(requests,before+1);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
