/** One-shot rule-based coordinator. Run again after business agents complete. */
import { CollabClient } from '../sdk/client.ts';
const url=process.env.COLLAB_URL, token=process.env.COLLAB_TOKEN, taskId=process.env.COLLAB_TASK;
const inventory=process.env.COLLAB_INVENTORY_AGENT, supplier=process.env.COLLAB_SUPPLIER_AGENT;
if(!url||!token||!taskId||!inventory||!supplier) throw new Error('Set COLLAB_URL, COLLAB_TOKEN, COLLAB_TASK, COLLAB_INVENTORY_AGENT and COLLAB_SUPPLIER_AGENT');
const client=new CollabClient(url,token);
let task=await client.task(taskId);
if(!['pending','running'].includes(task.status)) { console.log(`Task is ${task.status}`); process.exit(0); }
for(const [kind,agent] of [['inventory',inventory],['supplier',supplier]]) {
  if(!task.subtasks.some((s: any)=>s.kind===kind && s.agent===agent))
    await client.request(`tasks/${taskId}/assign`,{agent,kind},`coordinator:assign:${taskId}:${kind}:${agent}`);
}
task=await client.task(taskId);
if(task.subtasks.length && task.subtasks.every((s: any)=>s.status==='submitted')) {
  const stock=task.subtasks.find((s: any)=>s.kind==='inventory')?.result;
  const offer=task.subtasks.find((s: any)=>s.kind==='supplier')?.result;
  if (!stock || !offer || !Number.isSafeInteger(stock.quantity) || !Number.isSafeInteger(offer.quantity)) throw new Error('Required numeric inventory and supplier results missing');
  const text=`需求 ${task.quantity}，库存 ${stock.quantity}，缺口 ${Math.max(0,task.quantity-stock.quantity)}，供应商可供 ${offer.quantity}；需要人工确认交期与数据时效，不自动下单。`;
  await client.request(`tasks/${taskId}/summary`,{text},`coordinator:summary:${taskId}:${task.version}`);
  console.log('Summary submitted for human review');
} else console.log('Waiting for agent results');
