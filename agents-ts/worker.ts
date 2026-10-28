import { readFile } from 'node:fs/promises';
import { CollabClient } from '../sdk/client.ts';
import { RequestJournal } from '../sdk/journal.ts';

const url=process.env.COLLAB_URL, token=process.env.COLLAB_TOKEN, file=process.env.COLLAB_DATA, kind=process.env.COLLAB_KIND, path=process.env.COLLAB_WORKER_DB;
if(!url||!token||!file||!kind||!path) throw new Error('Set COLLAB_URL, COLLAB_TOKEN, COLLAB_DATA, COLLAB_KIND and COLLAB_WORKER_DB');
const client=new CollabClient(url,token);
const data=JSON.parse(await readFile(file,'utf8')) as Record<string,number>;
if(!data || typeof data!=='object' || Array.isArray(data) || Object.values(data).some(n=>!Number.isSafeInteger(n)||n<0)) throw new Error('Expected material quantities as nonnegative integers');
const me=await client.me();
const journal=new RequestJournal(path,{url:client.baseUrl,principal:me.id,workspace:me.workspace});
try {
  await journal.replay(client);
  for(const task of await client.inbox()) {
    if(task.kind!==kind) continue;
    if(!Object.hasOwn(data,task.material)) {
      if(task.status!=='accepted') await journal.send(client,`subtasks/${encodeURIComponent(task.id)}/reject`,{reason:'Material not found'},`reject:${task.id}:${task.version}`);
      continue;
    }
    if(task.status!=='accepted') await journal.send(client,`subtasks/${encodeURIComponent(task.id)}/accept`,{},`accept:${task.id}:${task.version}`);
    const result={quantity:data[task.material],source:file,observedAt:new Date().toISOString()};
    await journal.send(client,`subtasks/${encodeURIComponent(task.id)}/submit`,{result},`submit:${task.id}:${task.version}`);
    console.log(`Submitted ${task.id}`);
  }
} finally { journal.close(); }
