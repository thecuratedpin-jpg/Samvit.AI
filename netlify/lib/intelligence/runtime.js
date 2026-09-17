import {getStore} from '@netlify/blobs';
import {casUpdate} from '../storage/concurrency.js';
import {JOB_STORE,jobKey,activeAccount,TERMINAL,WAITING,releaseAdmission} from './jobs.js';
import {analyzeAndPlan,classifyTask,readyTasks} from './planning.js';
import {callModel} from './model-call.js';
import {runAgent} from './agent.js';
import {availableTools} from './tools.js';
import {verifyClaims} from './verification.js';
import {checkProject} from './context.js';
import {candidates} from './model-routing.js';
import {chargeToolBudget} from './tool-budget.js';
import {readSafety} from './permissions.js';
import {appendTrace} from './trace.js';
import {recordExperience,worldState} from './world-state.js';
import {snapshot as snapshotEnvironment} from './vfs.js';
import {verifyEnvironment,mergeEnvironmentVerifications} from './environment.js';
export async function runJob(accountId,id,env,{modelCall=callModel,agent=runAgent,now=()=>Date.now()}={}){
 const store=getStore(JOB_STORE),key=jobKey(accountId,id),token=crypto.randomUUID();let job;
 const {value:claimed}=await casUpdate(store,key,r=>{
  if(!r||r.accountId!==accountId||TERMINAL.includes(r.status)||WAITING.includes(r.status)||r.status==='paused'||r.lease?.expiresAt>now())return r;
  if(r.attempts>=3||r.expiresAt<now())return {...r,status:'failed',error:'Mission expired or recovery attempts exhausted',notification:'Mission needs attention'};
  return {...r,status:'running',lease:{token,expiresAt:now()+90000},attempts:r.attempts+1,activeMs:r.activeMs+(r.startedAt?Math.min(90000,Math.max(0,now()-r.startedAt)):0),startedAt:now(),tasks:r.tasks.map(t=>t.status==='running'?{...t,status:t.attempts>=2?'failed':'pending',error:'Previous worker stopped'}:t),revision:r.revision+1};
 });if(claimed?.lease?.token!==token)return {claimed:false};job=claimed;
 const start=now(),controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),Math.max(1,job.limits.maxTimeMs-job.activeMs));
 async function update(fn,{control=false}={}){const {value}=await casUpdate(store,key,r=>{if(r?.lease?.token!==token||r.lease.expiresAt<=now())throw Error('Worker lease lost');if(!control&&r.status!=='running')throw Error('Mission paused or cancelled');return {...fn(r),updatedAt:now(),revision:r.revision+1};});if(value.revision>=job.revision)job=value;return value;}
 const heartbeat=setInterval(()=>update(r=>({...r,lease:{token,expiresAt:now()+90000}})).catch(()=>controller.abort()),15000);
 const ctx={accountId,jobId:id,goal:job.goal,env,projectId:job.projectId,resourceIds:job.resourceIds,grants:job.grants,confirmed:job.confirmed,limits:job.limits,signal:controller.signal,
  // P0/P1: which paired computer this mission acts on, and any answers the
  // user has already given. Read fresh on every (re)start, so a resumed
  // mission sees the decision that paused it.
  deviceId:job.deviceId||null,decisions:job.decisions||{},environment:job.environment||'sandbox',
  assertActive:async()=>{controller.signal.throwIfAborted();
  // Phase 2: the kill switch is checked at every gate, so a running mission
  // stops promptly instead of only refusing new actions.
  const safety=await readSafety(accountId);if(safety.halted)throw Object.assign(Error('Safety kill switch is on: mission halted'),{reason:'kill_switch'});
  await activeAccount(accountId,job.sessionVersion);await checkProject(accountId,job.projectId);const current=await store.get(key,{type:'json',consistency:'strong'});if(current?.status!=='running'||current.lease?.token!==token||current.lease.expiresAt<=now())throw Error('Mission paused, cancelled or replaced');},
  reserveCall:async microUsd=>{await ctx.assertActive();await update(r=>{if(!Number.isSafeInteger(microUsd)||microUsd<0||r.modelCalls>=r.limits.maxCalls||r.spentMicroUsd+microUsd>r.limits.maxMicroUsd)throw Error('Mission model budget reached');return {...r,spentMicroUsd:r.spentMicroUsd+microUsd,modelCalls:r.modelCalls+1};});},
  consumeTool:async usd=>{await ctx.assertActive();const amount=Math.ceil(usd*1e6);await update(r=>{if(!Number.isFinite(amount)||amount<0||r.toolCalls>=r.limits.maxToolCalls||r.spentMicroUsd+amount>r.limits.maxMicroUsd)throw Error('Mission tool budget reached');return {...r,toolCalls:r.toolCalls+1,spentMicroUsd:r.spentMicroUsd+amount};});await chargeToolBudget(accountId,amount,env);},
  // Phase 10: every trace entry is normalised to a fixed field set and
  // scrubbed of anything resembling hidden reasoning before it is stored.
  trace:async entry=>update(r=>({...r,trace:appendTrace(r.trace,entry,now())}))
 };
 try{
  await ctx.assertActive();const first=classifyTask(job.goal);
  // Phase 5 -> 6: pull durable world state and learned experience for this
  // task shape. Best-effort — a cold start with no history must not fail.
  let hints=null;
  try{
   hints=(await worldState(accountId,{projectId:job.projectId,capability:'general',complexity:first.complexity})).hints;
   if(hints?.evidence==='learned-from-experience')await ctx.trace({kind:'experience',status:'applied',reason:`preferred model ${hints.preferredModel||'none'}`,note:(hints.strategies||[]).map(s=>s.strategy).join(',')||null});
  }catch{/* experience is an optimisation, never a prerequisite */}
  if(first.calculation){await update(r=>({...r,status:'completed',output:String(first.calculation.result),verification:{status:'verified',method:'deterministic-arithmetic'},notification:'Mission completed'}));return {claimed:true};}
  const complete=async(system,prompt)=>(await modelCall(ctx,{system,history:[{role:'user',content:prompt}],complexity:'high'})).content;
  if(!job.tasks.length){let planned;for(let attempt=0;attempt<2;attempt++){try{planned=await analyzeAndPlan(job.goal,{complete,toolNames:availableTools(env,job.grants).map(t=>t.name),limits:job.limits,hints});break;}catch(e){if(attempt)throw e;await ctx.trace({kind:'plan',status:'retry',reason:'invalid_or_unavailable_plan'});}}
   await update(r=>({...r,spec:planned.spec,tasks:planned.plan.tasks.map(t=>({...t,status:'pending',attempts:0,createdAt:now()}))}));
  }
  ctx.spec=job.spec;
  // P2: set when a task parks on a user decision. The mission then leaves the
  // wave loop in WAITING_FOR_USER rather than failing.
  let awaiting=null;
  for(let wave=0;wave<12;wave++){
   await ctx.assertActive();
   const repair=job.tasks.find(t=>t.status==='failed'&&t.kind==='work'&&t.attempts<2);
   if(repair&&(job.replans||0)<1){
    await update(r=>({...r,replans:(r.replans||0)+1}));
    try{const revised=await complete('Revise this failed subtask into a narrower achievable approach. Return only the new task instruction, at most 1500 characters. You cannot change dependencies, grants, tools or the goal. Do not claim to execute anything.',JSON.stringify({goal:job.goal,task:repair.description,tools:repair.tools,error:repair.error}));if(revised.trim()&&revised.length<=1500)await update(r=>({...r,tasks:r.tasks.map(t=>t.id===repair.id?{...t,description:revised,status:'pending',error:null}:t)}));}catch{/* preserve partial work when repair budget is exhausted */}
   }
   const ready=readyTasks(job.tasks,job.limits.maxParallel);if(!ready.length)break;
   const snapshot=job.tasks,pool=['consensus','debate','specialists'].includes(job.spec.strategy)?await candidates(accountId,env,{complexity:job.spec.complexity}):[];
   // A model with a proven record on this task shape is promoted, not forced:
   // it still has to be an eligible candidate, and callModel still falls back.
   if(hints?.preferredModel&&pool.length){const at=pool.findIndex(m=>m.target===hints.preferredModel);if(at>0)pool.unshift(pool.splice(at,1)[0]);}
   await Promise.all(ready.map(async (task,position)=>{
    const dependencies=snapshot.filter(t=>task.dependencies.includes(t.id));const evidence=dependencies.flatMap(t=>t.evidence||[]);
    await update(r=>({...r,tasks:r.tasks.map(t=>t.id===task.id?{...t,status:'running',attempts:t.attempts+1,startedAt:now()}:t)}));
    // Phase 9: if this task can change the environment, observe it before and
    // after so the work can be verified against real state, not just claimed.
    const touchesEnvironment=(task.tools||[]).some(name=>['fs_write','fs_mkdir','fs_delete','fs_copy','fs_move','terminal'].includes(name));
    const before=touchesEnvironment?await snapshotEnvironment(accountId).catch(()=>null):null;
    try{
     const used=dependencies.flatMap(t=>t.models||[]);const local={...ctx,avoid:task.kind==='verify'?used:[],preferredTarget:task.kind==='work'?pool[position%Math.max(1,pool.length)]?.target:undefined};
     // Context contains bounded deliverables/evidence, never hidden reasoning or authority.
     const input={dependencies:dependencies.map(d=>({id:d.id,status:d.status,output:(d.output||'').slice(0,7000),verification:d.verification})),evidence,attachedFiles:job.resourceIds};
     const result=await agent(local,task,input,{modelCall});
     const allEvidence=[...evidence,...result.evidence];let verification;
     if(task.kind==='verify')verification=verifyClaims(result.output,allEvidence,{freshness:job.spec.freshness_required});
     let environment=null;
     if(before){
      const after=await snapshotEnvironment(accountId).catch(()=>null);
      if(after)environment=verifyEnvironment({before,after,effects:result.effects||[]});
      if(environment&&environment.status!=='not-applicable')await ctx.trace({kind:'verification',status:environment.status,action:'environment-observation',reason:environment.missing.length?`${environment.missing.length} promised change(s) not observed`:`${environment.checked} change(s) confirmed`});
     }
     await update(r=>({...r,tasks:r.tasks.map(t=>t.id===task.id?{...t,...result,evidence:allEvidence.slice(-20),verification,environment,status:'completed',completedAt:now()}:t)}));
    }catch(e){
     // A decision request is not a failure. The task stays pending so it
     // re-runs after the answer, and the mission parks instead of dying.
     if(e?.reason==='awaiting_user_decision'&&e.decision){
      awaiting=e.decision;
      await update(r=>({...r,tasks:r.tasks.map(t=>t.id===task.id?{...t,status:'pending',error:null,completedAt:null}:t)}));
     }else await update(r=>({...r,tasks:r.tasks.map(t=>t.id===task.id?{...t,status:'failed',
      // P4: keep the REAL reason. A generic "task could not complete" hides
      // which step broke and why, so neither the model nor the user can act
      // on it. The message is the account's own mission detail, bounded.
      error:controller.signal.aborted?'Mission time limit reached':(String(e?.message||'').slice(0,300)||'Task could not complete within its tools, model access or budget'),
      completedAt:now()}:t)}));
    }
   }));
   if(awaiting){
    await update(r=>({...r,status:'waiting_for_user',pendingDecision:awaiting,notification:'Waiting for your decision',startedAt:null,lease:null}));
    break;
   }
  }
  // A parked mission has no result yet — do not compute or claim one.
  if(!awaiting){
  const terminal=job.tasks.find(t=>!job.tasks.some(n=>n.dependencies.includes(t.id))),unresolved=job.tasks.some(t=>t.status!=='completed'),evidence=job.tasks.flatMap(t=>t.evidence||[]);
  const verified=job.tasks.filter(t=>t.verification).map(t=>t.verification);
  const missingFreshness=job.spec.freshness_required&&!evidence.some(e=>e.url||e.sources?.length);
  // Phase 9: aggregate the real-state checks. A promised file change that never
  // happened is not allowed to pass as success.
  const environment=mergeEnvironmentVerifications(job.tasks.map(t=>t.environment).filter(Boolean));
  const environmentUnresolved=environment?.status==='unresolved';
  const final=await update(r=>{const failed=r.tasks.filter(t=>t.status==='failed');const outcome=terminal?.output?(unresolved||missingFreshness||environmentUnresolved?'partial':'completed'):'failed';return {...r,status:outcome,
   // A failure must say why. "failed" with no reason is not actionable, and it
   // hides which step actually broke.
   error:outcome==='failed'?`No deliverable was produced. ${failed.length?`${failed.length} step(s) failed: ${failed.slice(0,3).map(t=>`${t.id} — ${t.error||'no reason recorded'}`).join('; ')}`:'The plan produced no final result.'}`:null,
   output:(missingFreshness?'Current evidence is missing. Treat the following as an unverified draft.\n\n':'')+(terminal?.output||''),verification:{status:missingFreshness?'missing-current-evidence':environmentUnresolved?'unresolved':verified.some(v=>v.status==='unresolved')?'unresolved':verified.length?'reviewed':'unverified',reports:verified,environment,independentlyProven:false},notification:outcome==='failed'?'Mission needs attention':unresolved||missingFreshness||environmentUnresolved?'Mission finished with unresolved work':'Mission completed'};});
  // Phase 5: fold this mission's real outcome into learned experience so
  // future planning and routing can use what actually worked. Deliberately
  // non-fatal — experience is an optimisation, never a blocker.
  try{
   const outcome=final.status==='completed'?'success':final.status==='partial'?'partial':'failure';
   await recordExperience(accountId,{capability:terminal?.capability||'general',complexity:final.spec?.complexity,strategy:final.spec?.strategy,outcome,score:outcome==='success'?1:outcome==='partial'?0.5:0,model:(terminal?.models||[]).at(-1)||null,tools:[...new Set(final.tasks.flatMap(t=>t.tools||[]))].slice(0,8)});
  }catch{/* experience is best-effort */}
  }
 }catch(e){try{await update(r=>({...r,status:'failed',error:controller.signal.aborted?'Mission stopped at its time limit':'Mission could not complete. Check model access, tool configuration and remaining budget.',notification:'Mission needs attention'}));}catch{/* paused/cancelled or another worker owns the state */}}
 finally{clearInterval(heartbeat);clearTimeout(timeout);controller.abort();try{await update(r=>({...r,activeMs:r.activeMs+Math.max(0,now()-start),startedAt:null,lease:null}),{control:true});if(TERMINAL.includes(job.status))await releaseAdmission(accountId,id);}catch{/* a newer owner retains the lease */}}
 return {claimed:true};
}
