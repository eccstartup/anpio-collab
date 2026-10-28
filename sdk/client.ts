import { randomUUID } from 'node:crypto';

export class CollabError extends Error {
  status: number;
  outcomeUnknown: boolean;
  constructor(message: string, status=0, outcomeUnknown=false, cause?: unknown) {
    super(message,{cause}); this.name='CollabError'; this.status=status; this.outcomeUnknown=outcomeUnknown;
  }
}
/** Requests are never retried automatically. Reuse both operation ID and body after an uncertain write. */
export class CollabClient {
  baseUrl: string;
  private token: string;
  private timeoutMs: number;
  constructor(baseUrl: string, token: string, options: {timeoutMs?: number}={}) {
    const url=new URL(baseUrl);
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected HTTP(S) service URL without credentials');
    this.baseUrl=url.origin; this.token=token; this.timeoutMs=options.timeoutMs??10000;
    if(!Number.isInteger(this.timeoutMs)||this.timeoutMs<1) throw new Error('Invalid timeout');
  }
  async request(path: string, body?: unknown, operationId: string=randomUUID(), options: {expectedVersion?:number}={}): Promise<any> {
    if(path.startsWith('/')||path.includes('://')||path.includes('#')) throw new Error('Expected a relative v1 API path');
    let response: Response;
    try {
      response=await fetch(new URL('/v1/'+path,this.baseUrl),{
        method:body===undefined?'GET':'POST', redirect:'error', signal:AbortSignal.timeout(this.timeoutMs),
        headers:{authorization:'Bearer '+this.token,...(options.expectedVersion===undefined?{}:{'if-match':`"${options.expectedVersion}"`}),...(body===undefined?{}:{'content-type':'application/json','idempotency-key':operationId})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})
      });
      const result=await response.json() as any;
      if(!response.ok) throw new CollabError(`${response.status}: ${result.error??'Request failed'}`,response.status,false);
      return result;
    } catch(e) {
      if(e instanceof CollabError) throw e;
      throw new CollabError(body===undefined?'Read request failed':'Write outcome unknown; query state or replay the same operation and body',0,body!==undefined,e);
    }
  }
  me() { return this.request('me'); }
  context(id: string) { return this.request(`tasks/${encodeURIComponent(id)}/context`); }
  evidence(task: string, knowledge: string, version: number) { return this.request(`tasks/${encodeURIComponent(task)}/evidence/${encodeURIComponent(knowledge)}/${version}`); }
  tasksPage(limit=20, offset=0) { return this.request(`tasks/page?limit=${limit}&offset=${offset}`); }
  notifications() { return this.request('notifications'); }
  acknowledge(id: string, op: string) { return this.request(`notifications/${encodeURIComponent(id)}/ack`,{},op); }
  inbox() { return this.request('inbox'); }
  task(id: string) { return this.request(`tasks/${encodeURIComponent(id)}`); }
  accept(id: string, op: string) { return this.request(`subtasks/${encodeURIComponent(id)}/accept`,{},op); }
  progress(id: string, text: string, op: string) { return this.request(`subtasks/${encodeURIComponent(id)}/progress`,{text},op); }
  reject(id: string, reason: string, op: string) { return this.request(`subtasks/${encodeURIComponent(id)}/reject`,{reason},op); }
  submit(id: string, result: unknown, op: string) { return this.request(`subtasks/${encodeURIComponent(id)}/submit`,{result},op); }
  knowledge(query = '') { return this.request('knowledge'+(query?'?q='+encodeURIComponent(query):'')); }
}
