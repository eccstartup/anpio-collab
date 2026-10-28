import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,taskInput} from './helpers/fixture.ts';

test('dependencies gate acceptance, unknown outcomes require reconciliation, cancellation persists',async()=>{
 const f=await fixture();
 try {
  const a=await f.register('a'),b=await f.register('b');const t=await f.admin.request('tasks',taskInput);
  const first=await f.admin.request(`tasks/${t.id}/assign`,{agent:'a',kind:'inventory'});
  const dependent=await f.admin.request(`tasks/${t.id}/assign`,{agent:'b',kind:'supplier',dependsOn:[first.id]});
  assert.equal((await b.inbox()).length,0);
  await assert.rejects(b.accept(dependent.id,'early'),/409/);
  await a.accept(first.id,'accept');
  await a.request(`subtasks/${first.id}/outcome-unknown`,{reason:'lost business response',externalOperationId:'read-123'},'unknown');
  assert.equal((await a.inbox()).length,0);
  await assert.rejects(a.submit(first.id,{quantity:2,source:'fixture',observedAt:new Date().toISOString()},'blind-retry'),/409/);
  await f.admin.request(`subtasks/${first.id}/return`,{note:'external read confirmed safe to repeat'});
  await a.accept(first.id,'accept2');
  await a.submit(first.id,{quantity:2,source:'fixture',observedAt:new Date().toISOString()},'submit');
  assert.equal((await b.inbox()).length,1);
  await b.accept(dependent.id,'accept');
  await f.admin.request(`tasks/${t.id}/cancel`,{note:'business cancelled'});
  assert.equal((await b.inbox()).length,0);
  assert.ok((await b.notifications()).some((n:any)=>n.type==='cancelled'));
  assert.ok((await f.admin.task(t.id)).subtasks.every((s:any)=>s.status==='cancelled'));
  await f.restart();assert.equal((await f.admin.task(t.id)).status,'cancelled');
 } finally {await f.close();}
});

test('deadline expiration is idempotent and does not report business failure',async()=>{
 const f=await fixture();
 try {
  const agent=await f.register('agent');const t=await f.admin.request('tasks',taskInput);
  const sub=await f.admin.request(`tasks/${t.id}/assign`,{agent:'agent',kind:'inventory',due:'2020-01-01T00:00:00Z'});
  const expired=await f.admin.request('maintenance/expire',{},'tick');assert.equal(expired.expired,1);
  assert.deepEqual(await f.admin.request('maintenance/expire',{},'tick'),expired);
  assert.equal((await f.admin.request('maintenance/expire',{},'tick2')).expired,0);
  assert.equal((await f.admin.task(t.id)).status,'running');
  assert.equal((await f.admin.task(t.id)).subtasks[0].status,'timed_out');
  await assert.rejects(agent.accept(sub.id,'after-timeout'),/409/);
  await assert.rejects(agent.request('maintenance/expire',{}),/403/);
 } finally {await f.close();}
});

test('optimistic versions reject stale concurrent edits and allow exact replay',async()=>{
 const f=await fixture();
 try {
  await f.register('agent');const t=await f.admin.request('tasks',taskInput);
  const options={expectedVersion:t.version};
  const responses=await Promise.allSettled([
   f.admin.request(`tasks/${t.id}/assign`,{agent:'agent',kind:'one'},'one',options),
   f.admin.request(`tasks/${t.id}/assign`,{agent:'agent',kind:'two'},'two',options)
  ]);
  assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);
  assert.match(String((responses.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/412/);
  const winner=responses[0].status==='fulfilled'?'one':'two';
  const replay=await f.admin.request(`tasks/${t.id}/assign`,{agent:'agent',kind:winner},winner,options);
  assert.equal((await f.admin.task(t.id)).subtasks[0].id,replay.id);
  await assert.rejects(f.admin.request('tasks',{...taskInput,due:'2026-02-30T00:00:00Z'}),/400/);
 } finally {await f.close();}
});
