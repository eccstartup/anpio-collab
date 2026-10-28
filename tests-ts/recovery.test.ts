import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../platform/store.ts';
import {createServer} from '../platform/server.ts';
import {CollabClient} from '../sdk/client.ts';
import {fixture,taskInput} from './helpers/fixture.ts';

test('restart preserves notifications, acknowledgment, revocation and task state',async()=>{
  const f=await fixture();
  try {
    const agent=await f.register('agent');const other=await f.register('other');
    const task=await f.admin.request('tasks',taskInput,'task');
    const sub=await f.admin.request(`tasks/${task.id}/assign`,{agent:'agent',kind:'inventory'},'assign');
    const original=await agent.notifications();assert.equal(original.length,1);
    await f.restart();assert.deepEqual(await agent.notifications(),original);
    assert.deepEqual(await f.admin.request(`tasks/${task.id}/assign`,{agent:'agent',kind:'inventory'},'assign'),sub);
    assert.equal((await agent.notifications()).length,1);
    await agent.acknowledge(original[0].id,'ack');await f.restart();assert.equal((await agent.notifications()).length,0);
    assert.equal((await agent.inbox()).length,1);
    await assert.rejects(other.acknowledge(original[0].id,'bad'),/404/);
    await agent.accept(sub.id,'accept');await f.restart();
    assert.equal((await agent.inbox())[0].status,'accepted');
    await f.admin.request('principals/agent/deactivate',{},'revoke');await f.restart();
    await assert.rejects(agent.inbox(),/401/);
  } finally {await f.close();}
});

test('failed transaction rolls back state, event, notification and idempotency record',async()=>{
  const f=await fixture();
  try {
    await f.register('agent');const p=await f.store.authenticate(f.adminToken);
    const task=await f.admin.request('tasks',taskInput);
    await assert.rejects(f.store.exclusive(()=>f.store.operation(p,'fail','/v1/tasks/'+task.id+'/assign',{agent:'agent',kind:'inventory'},async()=>{
      await f.store.assign(p,task.id,{agent:'agent',kind:'inventory'});throw new Error('injected before commit');
    })),/injected/);
    assert.equal((await f.admin.task(task.id)).subtasks.length,0);
    assert.equal((await f.store.all('SELECT * FROM notifications')).length,0);
    assert.equal(await f.store.one('SELECT * FROM operations WHERE op=?','fail'),undefined);
    const events=(await f.admin.task(task.id)).events;assert.equal(events.length,1);
  } finally {await f.close();}
});

test('parallel writes use one idempotent result and do not mix transactions',async()=>{
  const f=await fixture();
  try {
    const results=await Promise.all(Array.from({length:20},()=>f.admin.request('tasks',taskInput,'same-operation')));
    assert.equal(new Set(results.map(r=>r.id)).size,1);
    const separate=await Promise.all(Array.from({length:15},(_,i)=>f.admin.request('tasks',{...taskInput,title:'task '+i},'distinct-'+i)));
    assert.equal(new Set(separate.map(r=>r.id)).size,15);
    assert.equal((await f.admin.request('tasks')).length,16);
    if(process.env.COLLAB_TEST_DATABASE) {
      const second=await Store.open(f.database);const server=createServer(second);
      await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
      try {
        const client=new CollabClient(`http://127.0.0.1:${(server.address() as any).port}`,f.adminToken);
        const responses=await Promise.all([f.admin.request('tasks',taskInput,'two-connections'),client.request('tasks',taskInput,'two-connections')]);
        assert.equal(responses[0].id,responses[1].id);
      } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await second.close();}
    }
  } finally {await f.close();}
});
