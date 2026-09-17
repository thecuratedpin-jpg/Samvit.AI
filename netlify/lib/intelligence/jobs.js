import {getStore} from '@netlify/blobs';
import {casUpdate} from '../storage/concurrency.js';
import {validAccountId} from '../storage/accounts.js';
import {getSubscription,isSubscriptionServiceUnavailable} from '../subscriptions.js';
import {checkProject,resources} from './context.js';
import {availableTools,COMPUTER_GRANTS,COMPUTER_DESTRUCTIVE_GRANTS,COMPUTER_DEVICE_GRANTS,COMPUTER_DEVICE_DESTRUCTIVE,COMPUTER_DEVICE_COMMANDS} from './tools.js';
import {getDevice} from '../devices/registry.js';
import {missingRequirements} from '../devices/dispatch.js';
import {DEVICE_CAPABILITIES} from '../../../shared/desktop.js';
import {classifyTask} from './planning.js';
export const JOB_STORE='samvit-orchestration';
export const jobKey=(accountId,id)=>{if(!validAccountId(accountId)||!/^[-a-f0-9]{36}$/.test(id||''))throw Error('Invalid job identity');return `accounts/${accountId}/job:${id}`;};
export const TERMINAL=['completed','partial','failed','cancelled'];
// Not terminal: a mission parked on a user decision is still alive, holds its
// admission slot, and resumes from its checkpoint when answered.
export const WAITING=['waiting_for_user'];
export function planLimits(planId){return {maxTasks:planId==='free'?4:8,maxParallel:{free:1,pro:2,ultra:3,ultimate:4}[planId]||1,maxCalls:{free:6,pro:16,ultra:24,ultimate:30}[planId]||6,maxToolCalls:planId==='free'?8:24,maxAgentSteps:4,maxTimeMs:180000,maxMicroUsd:{free:30000,pro:500000,ultra:1000000,ultimate:2000000}[planId]||30000};}
export async function activeAccount(accountId,version){const a=await getStore('samvit-accounts').get('account:'+accountId,{type:'json',consistency:'strong'});if(!a?.emailVerified||a.disabled||a.deleting||version!==undefined&&a.sessionVersion!==version)throw Error('Account changed or is unavailable');return a;}
export async function createJob(accountId,body,env){
 const account=await activeAccount(accountId),first=classifyTask(body.goal),id=body.requestId;const key=jobKey(accountId,id),store=getStore(JOB_STORE);
 const existing=await store.get(key,{type:'json',consistency:'strong'});if(existing){if(existing.goal!==body.goal)throw Error('Request ID already used for a different goal');return existing;}
 const projectId=await checkProject(accountId,body.projectId||null),sub=await getSubscription(getStore('samvit-subscription'),accountId,env);if(isSubscriptionServiceUnavailable(sub)||sub.status!=='active')throw Error('Workspace allowance unavailable');
 // P1: a mission may target a specific paired computer, and may declare the
 // device capabilities it intends to use (requiredCapabilities). Resolve and
 // verify BOTH now: pairing, revocation, and — stated exactly — every
 // authorisation the computer does not yet have. A mission whose target
 // cannot satisfy its requirements is refused up front with the precise
 // missing requirement, instead of pretending the task can be completed.
 let deviceId=null,requiredCapabilities=[];
 if(body.requiredCapabilities!==undefined){
  if(!Array.isArray(body.requiredCapabilities)||body.requiredCapabilities.length>8||body.requiredCapabilities.some(c=>typeof c!=='string'||!DEVICE_CAPABILITIES.includes(c)))throw Error('requiredCapabilities must be up to 8 device capabilities (fs.list, fs.read, fs.write, dev.run, ...)');
  requiredCapabilities=[...new Set(body.requiredCapabilities)];
 }
 if(body.deviceId){const device=await getDevice(accountId,body.deviceId);if(!device)throw Error('That computer is not paired with this workspace');if(device.revoked)throw Error('That computer has been disconnected');deviceId=device.id;
  if(requiredCapabilities.length){const gaps=missingRequirements(device,requiredCapabilities);if(gaps.length)throw Error(`This computer cannot run this mission yet: ${[...new Set(gaps)].join('; ')}.`);}
 }
 const local=body.allowLocalComputer===true&&Boolean(deviceId);
 const grants=['calculate',...(body.allowWeb===true?['web_search','fetch_url']:[]),...(body.allowMemory===true?['memory_search',...(body.allowSemantic===true?['semantic_memory']:[])]:[]),...(body.allowDocuments===true?['create_document']:[]),...(body.resourceIds?.length?['file_read','file_search']:[]),...(body.allowComputer===true?COMPUTER_GRANTS:[]),...(body.allowComputer===true&&body.allowDelete===true?COMPUTER_DESTRUCTIVE_GRANTS:[]),...(local?COMPUTER_DEVICE_GRANTS:[]),...(local&&body.allowLocalDelete===true?COMPUTER_DEVICE_DESTRUCTIVE:[]),...(local&&body.allowLocalCommands===true?COMPUTER_DEVICE_COMMANDS:[])];
 // Sensitive actions are pre-confirmed here, at mission creation, by the
 // account holder. A model can never add itself to this list.
 const confirmed=[...(body.allowDocuments===true?['create_document']:[]),...(body.allowComputer===true&&body.allowDelete===true?COMPUTER_DESTRUCTIVE_GRANTS:[]),...(local&&body.allowLocalDelete===true?COMPUTER_DEVICE_DESTRUCTIVE:[]),...(local&&body.allowLocalCommands===true?COMPUTER_DEVICE_COMMANDS:[])];
 const ids=body.resourceIds||[];if(!Array.isArray(ids)||ids.length>8||ids.some(id=>typeof id!=='string'))throw Error('Attach up to eight text resources');
 const attached=await resources(accountId,projectId);if(ids.some(id=>!attached.some(r=>r.id===id)))throw Error('An attached file is outside this project');
 const limits=planLimits(sub.planId);if(body.maxCostUsd!==undefined){if(!Number.isFinite(body.maxCostUsd)||body.maxCostUsd<=0)throw Error('Invalid mission budget');limits.maxMicroUsd=Math.min(limits.maxMicroUsd,Math.floor(body.maxCostUsd*1e6));}
 if(first.freshness_required&&!availableTools(env,grants).some(t=>t.name==='web_search'||t.name==='fetch_url'&&/https:\/\//.test(body.goal)))throw Error('Enable configured web search, or provide an HTTPS source URL and allow web access');
 // Per-account admission ledger bounds queued work; stale entries expire rather than locking forever.
 await casUpdate(store,`accounts/${accountId}/admission`,r=>{const rows=(r?.rows||[]).filter(x=>x.expiresAt>Date.now());if(rows.some(x=>x.id===id))return r;if(rows.length>=3)throw Error('Finish or cancel an existing mission first');return {rows:[...rows,{id,expiresAt:Date.now()+86400000}]};});
 return (await casUpdate(store,key,r=>r||{id,accountId,sessionVersion:account.sessionVersion,projectId,goal:body.goal,resourceIds:ids,grants,confirmed,status:'queued',environment:local?'local_pc':'sandbox',deviceId,requiredCapabilities,decisions:{},pendingDecision:null,createdAt:Date.now(),updatedAt:Date.now(),expiresAt:Date.now()+86400000,limits,activeMs:0,spentMicroUsd:0,modelCalls:0,toolCalls:0,tasks:[],trace:[],revision:0,attempts:0,notification:null})).value;
}
export async function getJob(accountId,id){return getStore(JOB_STORE).get(jobKey(accountId,id),{type:'json',consistency:'strong'});}
export async function commandJob(accountId,id,action,payload={}){
 const account=await activeAccount(accountId);if(!['pause','resume','cancel','decide'].includes(action))throw Error('Unknown job action');
 const {value}=await casUpdate(getStore(JOB_STORE),jobKey(accountId,id),r=>{if(!r||r.accountId!==accountId)throw Error('Job not found');
  // P2: answering a decision records it and re-queues the mission. The task
  // that parked is left 'pending', so it re-runs and its tool now finds the
  // recorded answer — that is the checkpoint/resume, not a restart.
  if(action==='decide'){
   const {decisionId,answer}=payload;
   if(typeof decisionId!=='string'||!decisionId)throw Error('A decision id is required');
   if(typeof answer!=='string'||!answer.trim()||answer.length>2000)throw Error('An answer is required');
   if(r.pendingDecision?.id!==decisionId)throw Error('That decision is no longer waiting');
   if(r.lease?.expiresAt>Date.now())throw Error('Wait for the current worker to stop');
   // Answering is a user-sanctioned restart, not a crash recovery: the worker
   // attempt counter (which exists to stop crash-loops) is reset, while time
   // and cost budgets are deliberately preserved.
   return {...r,decisions:{...(r.decisions||{}),[decisionId]:answer.trim()},pendingDecision:null,status:'queued',attempts:0,sessionVersion:account.sessionVersion,error:null,notification:null,updatedAt:Date.now()};
  }
  if(TERMINAL.includes(r.status)&&action!=='resume')return r;
  if(action==='resume'){if(!['paused','partial','failed','waiting_for_user'].includes(r.status))throw Error('This job cannot resume');if(r.lease?.expiresAt>Date.now())throw Error('Wait for the current worker to stop');if(r.attempts>=3||r.activeMs>=r.limits.maxTimeMs||r.modelCalls>=r.limits.maxCalls||r.spentMicroUsd>=r.limits.maxMicroUsd)throw Error('Mission limits exhausted. Start a smaller task.');const reset=new Set(r.tasks.filter(t=>['failed','running'].includes(t.status)&&t.attempts<2).map(t=>t.id));for(let i=0;i<r.tasks.length;i++)for(const t of r.tasks)if(t.dependencies.some(d=>reset.has(d)))reset.add(t.id);return {...r,status:'queued',sessionVersion:account.sessionVersion,tasks:r.tasks.map(t=>reset.has(t.id)?{...t,status:'pending',output:null,evidence:[],verification:null}:t),error:null,notification:null,updatedAt:Date.now()};}
  return {...r,status:action==='cancel'?'cancelled':'paused',notification:action==='cancel'?'Mission cancelled':null,updatedAt:Date.now()};
 });if(value.status==='cancelled')await releaseAdmission(accountId,id);return value;
}
export async function releaseAdmission(accountId,id){await casUpdate(getStore(JOB_STORE),`accounts/${accountId}/admission`,r=>({rows:(r?.rows||[]).filter(x=>x.id!==id)}));}
export function publicJob(job){if(!job)return null;const {lease,sessionVersion,confirmed,...safe}=job;return safe;}
