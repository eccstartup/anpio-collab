/** CLI bridge for a user-operated agent. Secrets are read from the environment. */
import { CollabClient } from '../sdk/client.ts';
const {COLLAB_URL:url,COLLAB_TOKEN:token}=process.env;
if(!url||!token) throw new Error('Set COLLAB_URL and COLLAB_TOKEN');
const client=new CollabClient(url,token);
const [command,arg,op]=process.argv.slice(2);
try {
  let result: unknown;
  if(command==='inbox') result=await client.inbox();
  else if(command==='knowledge') result=await client.knowledge();
  else if(command==='context' && arg) result=await client.context(arg);
  else if(command==='task' && arg) result=await client.task(arg);
  else if(command==='accept' && arg && op) result=await client.accept(arg,op);
  else if(command==='submit' && arg && op) {
    let input='';
    for await (const chunk of process.stdin) { input+=chunk; if(Buffer.byteLength(input)>65536) throw new Error('Input too large'); }
    result=await client.submit(arg,JSON.parse(input),op);
  } else throw new Error('Usage: inbox | knowledge | task TASK_ID | context TASK_ID | accept SUBTASK_ID OP_ID | submit SUBTASK_ID OP_ID < result.json');
  console.log(JSON.stringify(result,null,2));
} catch(e) { console.error(e instanceof Error?e.message:'Error'); process.exitCode=1; }
