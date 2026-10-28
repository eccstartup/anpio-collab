export type KnowledgeCandidate={id:string;task_id:string;content:string;conditions:string;version:number;reviewer:string;expires_at:string};
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value),'utf8');
const normalize=(s:string)=>s.normalize('NFKC').toLowerCase();
/** Deterministic lexical baseline. No embeddings or model calls are used. */
export function rankKnowledge(rows:KnowledgeCandidate[],query:string,limit:number,budget:number,candidatesTruncated=false) {
 const q=normalize(query.trim());
 const words=q.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
 const terms=new Set(words);
 for(const run of q.match(/[\p{Script=Han}]{2,}/gu)??[]) for(let i=0;i<run.length-1;i++) terms.add(run.slice(i,i+2));
 const ranked=rows.map(row=>{
  const content=normalize(row.content),conditions=normalize(row.conditions);
  const hits=[...terms].reduce((sum,term)=>sum+(content.includes(term)?1:0)+(conditions.includes(term)?2:0),0);
  const score=q?(hits+(content.includes(q)?3:0)+(conditions.includes(q)?6:0)):1;
  return {row,score};
 }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id));
 const items:any[]=[];let used=0,truncated=candidatesTruncated||ranked.length>limit;
 for(const {row,score} of ranked.slice(0,limit)) {
  const item={...row,score,reference:`knowledge:${row.id}:${row.version}`,contentTruncated:false};
  const remaining=budget-used;
  if(bytes(item)>remaining) {
   const characters=[...row.content];
   let low=0,high=characters.length;
   item.contentTruncated=true;
   while(low<high) {const mid=Math.ceil((low+high)/2);item.content=characters.slice(0,mid).join('');if(bytes(item)<=remaining)low=mid;else high=mid-1;}
   item.content=characters.slice(0,low).join('');truncated=true;
   if(!item.content||bytes(item)>remaining) continue;
  }
  used+=bytes(item);items.push(item);
 }
 return {items,truncated,estimatedTokens:used,tokenBudget:budget,budgetMethod:'UTF-8 bytes of serialized items; model tokenizer overhead excluded',retrieval:'lexical',candidatesTruncated};
}
