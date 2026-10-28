import {CollabClient} from '../sdk/client.ts';
const url=process.env.COLLAB_URL,token=process.env.COLLAB_TOKEN;
if(!url||!token) throw new Error('Set COLLAB_URL and an administrator COLLAB_TOKEN');
const interval=Number(process.env.COLLAB_SCHEDULER_INTERVAL_MS??30000);
if(!Number.isInteger(interval)||interval<1000) throw new Error('Interval must be at least 1000 ms');
const client=new CollabClient(url,token);let stopped=false;let wake:(()=>void)|undefined;
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{stopped=true;wake?.();});
do {
 try {console.log(JSON.stringify(await client.request('maintenance/expire',{})));}
 catch(e) {console.error((e as Error).message);if(process.argv.includes('--once')) process.exitCode=1;}
 if(process.argv.includes('--once')||stopped) break;
 await new Promise<void>(resolve=>{const timer=setTimeout(resolve,interval);wake=()=>{clearTimeout(timer);resolve();};});
} while(!stopped);
