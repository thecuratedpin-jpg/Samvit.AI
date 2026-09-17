import {accountStore} from '../storage/accounts.js';
import {casUpdate} from '../storage/concurrency.js';
export const RESOURCE_STORE='samvit-resources';
export const safeId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
export async function checkProject(accountId,projectId){if(projectId===null||projectId===undefined||projectId==='')return null;if(!safeId(projectId))throw Error('Invalid project');const p=await accountStore('samvit-projects',accountId).get('proj:'+projectId,{type:'json',consistency:'strong'});if(!p||p.status==='archived')throw Error('Project unavailable');return projectId;}
export async function resources(accountId,projectId=null){const r=await accountStore(RESOURCE_STORE,accountId).get('workspace',{type:'json',consistency:'strong'});return (r?.items||[]).filter(x=>(x.projectId||null)===projectId);}
export async function saveResource(accountId,{id,name,content,format='text',projectId=null}){
 await checkProject(accountId,projectId);
 if(!safeId(id)||typeof name!=='string'||!name.trim()||name.length>100||/[\/\\\u0000-\u001f]/.test(name)||typeof content!=='string'||content.length>20000||!['text','markdown','csv','slides'].includes(format))throw Error('Invalid text resource');
 const item={id,name,content,format,projectId,createdAt:Date.now()};
 const {value}=await casUpdate(accountStore(RESOURCE_STORE,accountId),'workspace',r=>{const items=r?.items||[];const old=items.find(x=>x.id===id);if(old){if(old.projectId!==projectId)throw Error('Resource scope mismatch');return r;}if(items.length>=50)throw Error('Resource limit reached');return {items:[...items,item]};});return value.items.find(x=>x.id===id);
}
const words=s=>new Set(String(s).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]);
export function rankContext(records,query,{projectId=null,now=Date.now(),vectors=null,queryVector=null}={}){
 const q=words(query);return records.filter(r=>!r.archived&&(r.projectId||null)===projectId).map(r=>{
  const w=words(r.content||r.summary),overlap=[...q].filter(t=>w.has(t)).length/Math.max(1,q.size);let similarity=0;
  const v=vectors?.[r.id];if(v&&queryVector&&v.length===queryVector.length){const dot=v.reduce((n,x,i)=>n+x*queryVector[i],0),norm=Math.hypot(...v)*Math.hypot(...queryVector);if(Number.isFinite(dot)&&norm>0)similarity=Math.max(0,dot/norm);}
  const age=Math.max(0,now-(Date.parse(r.updatedAt||r.timestamp)||0))/86400000;
  return {...r,score:overlap*.6+similarity*.3+(r.pinned?.08:0)+.02/(1+age),retrieval:queryVector?'hybrid-semantic':'lexical'};
 }).filter(r=>r.score>.02).sort((a,b)=>b.score-a.score).slice(0,6);
}
export async function memoryContext(accountId,projectId,query,{embed}={}){
 const store=accountStore('samvit-memories',accountId),index=await store.get('index',{type:'json',consistency:'strong'})||[];
 const selected=index.filter(r=>!r.archived&&(r.projectId||null)===projectId).slice(0,100);
 const records=(await Promise.all(selected.map(r=>store.get('mem:'+r.id,{type:'json',consistency:'strong'})))).filter(Boolean);
 let vectors,queryVector;if(embed){const all=await embed([query,...records.map(r=>r.content.slice(0,3000))]);queryVector=all[0];vectors=Object.fromEntries(records.map((r,i)=>[r.id,all[i+1]]));}
 return rankContext(records,query,{projectId,vectors,queryVector}).map(r=>({id:r.id,content:r.content.slice(0,1500),score:r.score,retrieval:r.retrieval,untrusted:true}));
}
