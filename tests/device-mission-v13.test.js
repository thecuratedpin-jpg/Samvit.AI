// SAMVIT V13 — end-to-end mission ↔ device execution tests.
//
// Where desktop-e2e-v11.test.js proves components, this suite proves the
// COMPOSITE the whole system exists for:
//
//   GOAL → PLAN → mission runtime → device policy → queue → agent
//   → REAL filesystem effect → real observation → verification
//   → mission outcome that reflects what actually happened
//
// including the failure shapes the brief demands: offline device parking and
// resume, missing authorisations named exactly, unobserved effects ending in
// 'partial' (never rounded up to success), and an attributable trace.
//
// PLATFORM: device work runs through createDeviceHost() — the native path on
// Windows, the POSIX bridge elsewhere. No security rule is weakened either
// way; the agent's containment pipeline runs fully on both.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {createFakeStore} from './helpers/fake-store.js';
import {createDeviceHost} from './helpers/device-host.js';
const stores=new Map(),store=n=>{if(!stores.has(n))stores.set(n,createFakeStore());return stores.get(n);};
mock.module('@netlify/blobs',{namedExports:{getStore:store}});
const D=await import('../shared/desktop.js');
const R=await import('../netlify/lib/devices/registry.js');
const Q=await import('../netlify/lib/devices/queue.js');
const DISP=await import('../netlify/lib/devices/dispatch.js');
const T=await import('../netlify/lib/intelligence/tools.js');
const JOBS=await import('../netlify/lib/intelligence/jobs.js');
const RT=await import('../netlify/lib/intelligence/runtime.js');
const PLAN=await import('../netlify/lib/intelligence/planning.js');
const ENV=await import('../netlify/lib/intelligence/environment.js');
const EX=await import('../agent/executor.js');
const deviceAgent=await import('../netlify/functions/device-agent.mjs');
const {createTransport}=await import('../agent/transport.js');
const {runOnce}=await import('../agent/main.js');
const A='usr_00000000-0000-0000-0000-000000000001',env={get:()=>undefined};

const seedAccount=async()=>{
 stores.clear();
 await store('samvit-accounts').setJSON('account:'+A,{id:A,emailVerified:true,sessionVersion:1});
 await store('samvit-subscription').setJSON('sub:'+A,{planId:'pro',status:'active'});
};

const pairDevice=async(name='Main PC',{scopes=[],approvedCommands=[],online=false}={})=>{
 const {code}=await R.beginPairing(A);
 const result=await R.completePairing({code,deviceName:name,platform:'win32',arch:'x64'});
 await R.setDevicePolicy(A,result.deviceId,{scopes,approvedCommands});
 if(online){
  const device=await R.getDevice(A,result.deviceId);
  await store('samvit-devices').setJSON(`accounts/${A}/device:${result.deviceId}`,{...device,lastSeenAt:Date.now()});
 }
 return result.deviceId;
};

const spec={intent:'action',complexity:'moderate',freshness_required:false,needs_tools:true,needs_verification:false,verification_level:'basic',risk:'low',output_type:'answer',strategy:'single'};
const plan={tasks:[{id:'a',phase:'p',sub_mission:'s',description:'Do the device work',dependencies:[],kind:'work',capability:'general',tools:[]}]};
const modelCall=()=>{let stage=0;return async()=>({content:JSON.stringify(++stage===1?spec:plan)});};

// A tool context good enough for the REAL executeTool under a REAL runJob ctx.
const toolCtx=ctx=>({...ctx,env,allowedUrls:new Set(),effectId:'test-effect'});

// Run computer_* calls through the REAL tool layer and assemble the device
// observations the same way intelligence/agent.js does, so a stub agent can
// stand in for runAgent without losing the P4 verification flow.
const runDeviceCalls=async(ctx,calls)=>{
 const device=[];
 for(const [name,args] of calls){
  const started=Date.now(),result=await T.executeTool({name,arguments:args},toolCtx(ctx));
  let observation=null;
  try{
   const parsed=JSON.parse(result.text);
   if(parsed?.environment==='local_pc')observation=parsed;
  }catch{/* observation collection must never fail the step */}
  if(observation?.actionId)device.push({capability:observation.capability||name,actionId:observation.actionId,status:observation.status||'unknown',expected:observation.expected||null,verification:observation.verification||null});
  // Mirror the trace agent.js emits for computer_* calls (P8 attribution).
  if(observation)await ctx.trace({kind:'tool',tool:name,status:observation.status==='completed'?'completed':'failed',latencyMs:Date.now()-started,actionId:observation.actionId||null,deviceId:ctx.deviceId||null,capability:observation.capability||null});
 }
 return device;
};

// A scripted agent that services the REAL queue with the REAL executor on the
// test computer. Returns a stop function; any refusal is reported, never lost.
const startQueuePump=(deviceId,pc,{intervalMs=120,log=[]}={})=>{
 let stopped=false;
 const tick=async()=>{
  if(stopped)return;
  try{
   const device=await R.getDevice(A,deviceId);
   const claimed=await Q.claimActions(A,deviceId);
   for(const action of claimed){
    try{
     const {observation,result}=await EX.executeAction({capability:action.capability,args:action.args,scopes:device?.scopes||[],approvedCommands:device?.approvedCommands||[],host:pc.host});
     await Q.completeAction(A,deviceId,action.id,{observation,report:result});
     log.push({id:action.id,ok:true});
    }catch(error){
     await Q.completeAction(A,deviceId,action.id,{error:error.message});
     log.push({id:action.id,ok:false,error:error.message});
    }
   }
  }catch{/* the next tick retries */}
  if(!stopped)setTimeout(tick,intervalMs);
 };
 const timer=setTimeout(tick,intervalMs);
 return()=>{stopped=true;clearTimeout(timer);};
};

// --------------------------------------------------------------------------
// P1 — requirements are named exactly, before anything runs
// --------------------------------------------------------------------------
test('missingRequirements names the precise authorisation gap for each capability',()=>{
 assert.deepEqual(DISP.missingRequirements({revoked:false,scopes:[],approvedCommands:[]},['fs.read']),['"fs.read" needs a folder authorised for reading']);
 assert.deepEqual(DISP.missingRequirements({revoked:false,scopes:[],approvedCommands:[]},['fs.write']),['"fs.write" needs a folder authorised for reading AND writing']);
 assert.deepEqual(DISP.missingRequirements({revoked:false,scopes:[{path:'C:\\Work',mode:'read'}],approvedCommands:[]},['fs.read']),[],'a read scope satisfies read capabilities');
 assert.deepEqual(DISP.missingRequirements({revoked:false,scopes:[{path:'C:\\Work',mode:'read'}],approvedCommands:[]},['fs.write']),['"fs.write" needs a folder authorised for reading AND writing'],'read-only is not enough');
 assert.deepEqual(DISP.missingRequirements({revoked:false,scopes:[{path:'C:\\Work',mode:'write'}],approvedCommands:[]},['dev.run']),['"dev.run" needs an approved development command (Computers page → Approved commands)']);
 assert.deepEqual(DISP.missingRequirements({revoked:false,scopes:[],approvedCommands:[]},['env.inspect']),[],'env.inspect needs nothing');
 assert.deepEqual(DISP.missingRequirements({revoked:true,scopes:[{path:'C:\\Work',mode:'write'}],approvedCommands:['node --version']},['fs.read']),['the computer has been disconnected — pair it again']);
 assert.deepEqual(DISP.missingRequirements(null,['fs.read']),['pair a computer first']);
});

test('a mission naming requiredCapabilities is refused up front with the exact gap, and stored when satisfiable',async()=>{
 await seedAccount();
 const deviceId=await pairDevice('Bare PC');
 await assert.rejects(
  JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Write project notes into my project folder on my computer',deviceId,allowLocalComputer:true,requiredCapabilities:['fs.write']},env),
  /cannot run this mission yet.*fs\.write.*folder authorised/s
 );
 await assert.rejects(
  JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Run the test suite on my computer and report back',deviceId,allowLocalComputer:true,requiredCapabilities:['dev.run']},env),
  /cannot run this mission yet.*approved development command/s
 );
 await assert.rejects(
  JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Organise files on my computer please',deviceId,allowLocalComputer:true,requiredCapabilities:['fs.teleport']},env),
  /requiredCapabilities/
 );
 const capable=await pairDevice('Ready PC',{scopes:[{path:'C:\\Projects\\Samvit',mode:'write'}]});
 const job=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Create a folder and write project notes on my computer',deviceId:capable,allowLocalComputer:true,requiredCapabilities:['fs.write','fs.read']},env);
 assert.deepEqual(job.requiredCapabilities,['fs.write','fs.read']);
 assert.equal(job.environment,'local_pc');
});

test('the planner is told what the target computer can actually do',async()=>{
 const systems=[];
 await PLAN.analyzeAndPlan('Create a folder called reports and put a summary file inside it on my computer',{
  complete:async(system,prompt)=>{systems.push(system);return JSON.stringify(systems.length===1?spec:plan);},
  toolNames:['computer_mkdir','computer_write','computer_read'],
  limits:{maxTasks:8,maxParallel:1},
  deviceNote:'Target computer: Main PC (win32/x64), online now. Environment: local_pc. Authorised folders: C:\\Projects\\Samvit (write). Approved commands: none.'
 });
 assert.match(systems.at(-1),/Target computer: Main PC/);
 assert.match(systems.at(-1),/Authorised folders: C:\\Projects\\Samvit/);
 assert.match(systems.at(-1),/Environment: local_pc/);
 const bare=await PLAN.analyzeAndPlan('Explain the difference between a file and a folder in computing terms',{
  complete:async()=>JSON.stringify(spec),
  toolNames:['calculate'],
  limits:{maxTasks:8,maxParallel:1},
  deviceNote:'   '
 });
 assert.ok(bare.plan,'a blank device note must not break planning');
});

// --------------------------------------------------------------------------
// P6 — offline devices: fast fail, honest parking, clean resume
// --------------------------------------------------------------------------
test('requireOnline fails fast against a dark computer and queues nothing',async()=>{
 await seedAccount();
 const deviceId=await pairDevice('Offline PC',{scopes:[{path:'C:\\Projects\\Samvit',mode:'write'}]});
 const result=await DISP.requestDeviceAction(A,{deviceId,capability:'fs.write',args:{path:'C:\\Projects\\Samvit\\a.txt',content:'x'},requireOnline:true});
 assert.equal(result.status,'offline');
 assert.equal(result.neverConnected,true);
 assert.match(result.detail,/node agent\/main\.js/);
 assert.equal((await Q.pendingActions(A,deviceId)).length,0,'nothing was queued to spin against a dark computer');
 // Without the flag the low-level pipe keeps its old behaviour (the queue IS
 // the retry mechanism there); and a recently-seen computer passes the gate.
 const online=await pairDevice('Online PC',{scopes:[{path:'C:\\Projects\\Samvit',mode:'write'}],online:true});
 let clock=Date.now();
 const gated=await DISP.requestDeviceAction(A,{deviceId:online,capability:'fs.write',args:{path:'C:\\Projects\\Samvit\\a.txt',content:'x'},requireOnline:true,now:()=>clock+=4000,sleepFn:async()=>{}});
 assert.equal(gated.status,'timeout','an online-but-unanswering computer times out honestly instead');
 assert.equal((await Q.pendingActions(A,online)).length,1,'the action was queued because the computer was provably alive');
});

test('a mission parks in WAITING_FOR_USER while its computer is offline and completes once it reconnects',async t=>{
 await seedAccount();
 const pc=await createDeviceHost();
 t.after(pc.cleanup);
 const deviceId=await pairDevice('Laptop',{scopes:[{path:pc.scopePath,mode:'write'}]});
 const job=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Create a folder and write notes.txt on my computer',deviceId,allowLocalComputer:true},env);

 const agent=async ctx=>{
  const device=await runDeviceCalls(ctx,[
   ['computer_mkdir',{path:pc.winPath('notes')}],
   ['computer_write',{path:pc.winPath('notes','notes.txt'),content:'back online'}]
  ]);
  return {output:'Folder and file created on your computer',evidence:[],models:['stub'],effects:[],device};
 };
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 const parked=await JOBS.getJob(A,job.id);
 assert.equal(parked.status,'waiting_for_user','an offline computer parks the mission instead of failing it');
 assert.match(parked.pendingDecision.question,/offline|never connected/i);
 assert.equal((await Q.pendingActions(A,deviceId)).length,0,'nothing was queued while the computer was dark');

 // Bring the computer online, answer "keep waiting" — the mission resumes
 // from its checkpoint and the work happens for real.
 const device=await R.getDevice(A,deviceId);
 await store('samvit-devices').setJSON(`accounts/${A}/device:${deviceId}`,{...device,lastSeenAt:Date.now()});
 await JOBS.commandJob(A,job.id,'decide',{decisionId:parked.pendingDecision.id,answer:'wait'});
 const stop=startQueuePump(deviceId,pc);
 t.after(stop);
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 const done=await JOBS.getJob(A,job.id);
 assert.equal(done.status,'completed');
 assert.equal(await fs.readFile(pc.hostPath(pc.winPath('notes','notes.txt')),'utf8'),'back online');
 assert.equal(done.verification.environment.status,'verified');
 assert.equal(done.verification.environment.method,'device-observation');
 assert.ok(done.verification.environment.independentlyProven,'every promised effect was confirmed by the computer');
});

test('choosing to stop while the computer is offline ends the mission honestly',async t=>{
 await seedAccount();
 const pc=await createDeviceHost();
 t.after(pc.cleanup);
 const deviceId=await pairDevice('Dark PC',{scopes:[{path:pc.scopePath,mode:'write'}]});
 const job=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Reorganise the whole project folder on my computer',deviceId,allowLocalComputer:true},env);
 const agent=async ctx=>{await T.executeTool({name:'computer_list',arguments:{path:pc.scopePath}},toolCtx(ctx));return {output:'listed',evidence:[],models:['stub'],effects:[],device:[]};};
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 const parked=await JOBS.getJob(A,job.id);
 assert.equal(parked.status,'waiting_for_user');
 await JOBS.commandJob(A,job.id,'decide',{decisionId:parked.pendingDecision.id,answer:'stop'});
 // No agent pump: the computer stays dark, so the user-chosen stop is what
 // ends the mission — with the reason recorded, never a silent success.
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 const done=await JOBS.getJob(A,job.id);
 assert.equal(done.status,'failed');
 assert.match(done.error,/stopped/i);
 assert.equal(done.output,'','no result is fabricated for a stopped mission');
});

// --------------------------------------------------------------------------
// P4 — every promised effect is verified against the real device report
// --------------------------------------------------------------------------
test('a computer effect the device never confirmed ends the mission partial, never completed',async t=>{
 await seedAccount();
 const pc=await createDeviceHost();
 t.after(pc.cleanup);
 const deviceId=await pairDevice('Fibber PC',{scopes:[{path:pc.scopePath,mode:'write'}],online:true});
 const job=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Write deliverable.txt on my computer and confirm it exists',deviceId,allowLocalComputer:true},env);

 // A scripted agent that CLAIMS completion but reports an observation in
 // which the promised file simply does not exist.
 const agent=async ctx=>{
  await T.executeTool({name:'computer_write',arguments:{path:pc.winPath('deliverable.txt'),content:'draft'}},toolCtx(ctx));
  return {output:'Wrote deliverable.txt',evidence:[],models:['stub'],effects:[],device:[{capability:'fs.write',actionId:'x',status:'completed',expected:D.expectationFor('fs.write',{path:pc.winPath('deliverable.txt')}),verification:{status:'unresolved',reason:'not_present'}}]};
 };
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 const done=await JOBS.getJob(A,job.id);
 assert.equal(done.status,'partial','an unobserved effect must not be reported as full success');
 assert.equal(done.verification.environment.status,'unresolved');
 assert.match(done.notification,/unresolved/i);
 const entry=done.trace.find(e=>e.kind==='verification'&&e.action==='environment-observation');
 assert.equal(entry.status,'unresolved');
});

test('verifyDeviceObservations ignores read-only actions and holds promised effects to account',()=>{
 assert.equal(ENV.verifyDeviceObservations([{capability:'fs.read',status:'completed',expected:null,verification:{status:'unverifiable'}}]),null,'read-only actions promise nothing');
 assert.equal(ENV.verifyDeviceObservations([]),null);
 const good=ENV.verifyDeviceObservations([{capability:'fs.write',actionId:'a1',status:'completed',expected:{kind:'present',path:'C:\\a'},verification:{status:'verified',reason:'present'}}],{deviceId:'d'});
 assert.equal(good.status,'verified');assert.equal(good.method,'device-observation');assert.equal(good.independentlyProven,true);assert.equal(good.checked,1);
 const timedOut=ENV.verifyDeviceObservations([{capability:'fs.write',actionId:'a2',status:'timeout',expected:{kind:'present',path:'C:\\a'},verification:null}]);
 assert.equal(timedOut.status,'unresolved');
 assert.match(timedOut.missing[0].note,/never reported back/);
 const merged=ENV.mergeEnvironmentVerifications([good,timedOut]);
 assert.equal(merged.status,'unresolved');
 assert.equal(merged.method,'device-observation','records are checked, not blended into ambiguity');
 assert.deepEqual(merged.deviceIds,['d']);
 // Mixed with a sandbox record the label says so honestly.
 const sandbox={status:'verified',method:'environment-observation',checked:1,matched:1,missing:[],unexpected:[],independentlyProven:true};
 assert.equal(ENV.mergeEnvironmentVerifications([good,sandbox]).method,'mixed-observation');
});

// --------------------------------------------------------------------------
// P6 — per-device queue depth is bounded
// --------------------------------------------------------------------------
test('outstanding work for one computer is capped without touching its history',async()=>{
 await seedAccount();
 const deviceId=await pairDevice();
 const other=await pairDevice('Other PC');
 for(let i=0;i<Q.MAX_OUTSTANDING_PER_DEVICE;i++)await Q.enqueueAction(A,{deviceId,capability:'fs.read',args:{path:'C:\\Projects\\Samvit\\a.txt'}});
 await assert.rejects(
  Q.enqueueAction(A,{deviceId,capability:'fs.read',args:{path:'C:\\Projects\\Samvit\\a.txt'}}),
  /outstanding/
 );
 // Completed history does not count against the cap, and another computer
 // has its own budget.
 const rows=await Q.readActions(A);
 const pending=rows.filter(r=>r.deviceId===deviceId&&!['completed','failed','denied','expired'].includes(r.status));
 for(const row of pending.slice(0,3))await Q.markActionDecision(A,row.id,{approved:false});
 for(let i=0;i<3;i++)await Q.enqueueAction(A,{deviceId,capability:'fs.read',args:{path:'C:\\Projects\\Samvit\\b.txt'}});
 await Q.enqueueAction(A,{deviceId:other,capability:'fs.read',args:{path:'C:\\Projects\\Samvit\\a.txt'}});
});

// --------------------------------------------------------------------------
// The flagship proof: GOAL → PLAN → REAL agent over HTTP → verified effect
// --------------------------------------------------------------------------
function startServer(){
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const request=new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:Buffer.concat(chunks).toString('utf8')});
  try{const response=await deviceAgent.default(request,{});res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());}
  catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
 });
 return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server)));
}

test('LIVE MISSION: goal → plan → policy → queue → real agent over HTTP → real files → verified completion',async t=>{
 await seedAccount();
 const pc=await createDeviceHost({prefix:'samvit-mission-'});
 t.after(pc.cleanup);
 const server=await startServer();
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const cloudUrl=`http://127.0.0.1:${server.address().port}`;

 // Pair over real HTTP, authorise the scope, and mark the agent online.
 const {code}=await R.beginPairing(A);
 const pairing=await createTransport({cloudUrl,deviceId:null,deviceToken:null}).pair({code,deviceName:'Mission PC',platform:process.platform,arch:process.arch});
 await R.setDevicePolicy(A,pairing.deviceId,{scopes:[{path:pc.scopePath,mode:'write'}],approvedCommands:[]});
 const device=await R.getDevice(A,pairing.deviceId);
 await store('samvit-devices').setJSON(`accounts/${A}/device:${pairing.deviceId}`,{...device,lastSeenAt:Date.now()});

 // The mission: exactly the brief's shape — make a folder, put a file in it,
 // read it back, report truthfully.
 const job=await JOBS.createJob(A,{
  requestId:crypto.randomUUID(),
  goal:'Create a project-scratch folder on my computer, write a README.txt in it that says hello, then read it back to be sure',
  deviceId:pairing.deviceId,
  allowLocalComputer:true,
  requiredCapabilities:['fs.mkdir','fs.write','fs.read']
 },env);

 // The REAL agent daemon loop: poll → execute → report, over real HTTP,
 // with durable receipts, against the real executor.
 const transport=createTransport({cloudUrl,deviceId:pairing.deviceId,deviceToken:pairing.deviceToken,pollMs:100});
 const {createReceiptStore}=await import('../agent/receipts.js');
 const receipts=createReceiptStore(join(pc.receiptsDir,'receipts.json'));
 let halted=false;
 const pump=(async()=>{while(!halted){try{await runOnce(transport,{execute:EX.executeAction,receipts,host:pc.host});}catch{/* keep polling */}await new Promise(r=>setTimeout(r,80));}})();
 t.after(()=>{halted=true;});
 // Keep the heartbeat fresh the way a real agent would.
 const heartbeat=setInterval(()=>{R.getDevice(A,pairing.deviceId).then(d=>d&&store('samvit-devices').setJSON(`accounts/${A}/device:${pairing.deviceId}`,{...d,lastSeenAt:Date.now()})).catch(()=>{});},2000);
 t.after(()=>clearInterval(heartbeat));

 const agent=async ctx=>{
  const device=await runDeviceCalls(ctx,[
   ['computer_mkdir',{path:pc.winPath('project-scratch')}],
   ['computer_write',{path:pc.winPath('project-scratch','README.txt'),content:'hello from samvit'}],
   ['computer_read',{path:pc.winPath('project-scratch','README.txt')}]
  ]);
  return {output:'Done — folder created, file written and read back on your computer',evidence:[],models:['stub'],effects:[],device};
 };
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 halted=true;

 const done=await JOBS.getJob(A,job.id);
 assert.equal(done.status,'completed',JSON.stringify({status:done.status,error:done.error}));
 assert.match(done.output,/read back on your computer/);

 // The files genuinely exist on the computer with the right content.
 assert.equal(await fs.readFile(pc.hostPath(pc.winPath('project-scratch','README.txt')),'utf8'),'hello from samvit');

 // Every action was verified against a REAL observation by the queue, is
 // attributable to this mission, and the environment verdict is proof.
 const rows=(await Q.readActions(A)).filter(row=>row.missionId===job.id);
 assert.equal(rows.length,3,'the two writes AND the read-back all travelled the queue');
 for(const row of rows){assert.equal(row.status,'completed');assert.equal(row.deviceId,pairing.deviceId);}
 const effectful=rows.filter(row=>row.expected);
 assert.equal(effectful.length,2,'exactly the two state-changing actions promised an effect');
 for(const row of effectful)assert.equal(row.verification.status,'verified');
 assert.equal(rows.find(row=>row.capability==='fs.read').verification.status,'unverifiable','a read promises no effect and is labelled as such');
 assert.equal(done.verification.environment?.status,'verified');
 assert.ok(done.verification.environment.independentlyProven);

 // P8: the trace answers "Samvit did WHAT on WHICH computer for WHICH action".
 const toolEntries=done.trace.filter(e=>e.kind==='tool'&&e.actionId);
 assert.equal(toolEntries.length,3);
 for(const entry of toolEntries){assert.equal(entry.deviceId,pairing.deviceId,'deviceId on the entry');assert.ok(entry.capability,'capability on the entry');}
 const targeting=done.trace.find(e=>e.kind==='status'&&e.deviceId===pairing.deviceId);
 assert.ok(targeting,'the mission records which computer it targeted');
 assert.equal(targeting.status,'device-online');
});

// --------------------------------------------------------------------------
// P3 + P2 — a crash between effect and report is survived exactly once
// --------------------------------------------------------------------------
test('an action redelivered after a crash replays its receipt — and the mission still sees one real effect',async t=>{
 await seedAccount();
 const pc=await createDeviceHost();
 t.after(pc.cleanup);
 const deviceId=await pairDevice('Crashy PC',{scopes:[{path:pc.scopePath,mode:'write'}]});
 const {createReceiptStore}=await import('../agent/receipts.js');
 const {runOnce:runAgentOnce}=await import('../agent/main.js');
 const receipts=createReceiptStore(join(pc.receiptsDir,'r.json'));
 const file=pc.winPath('counter.txt');
 const action=await Q.enqueueAction(A,{deviceId,capability:'fs.write',args:{path:file,content:'v1'},expected:D.expectationFor('fs.write',{path:file}),missionId:'m'});

 // First delivery: the agent executes but "crashes" before the report lands
 // (no completeAction call), leaving the lease to expire.
 const row={crash:true,empty:false};
 const transport={
  policy:{scopes:[{path:pc.scopePath,mode:'write'}],approvedCommands:[]},
  async poll(){return row.empty?{actions:[],halted:false}:{actions:[{id:action.id,capability:action.capability,args:action.args,expected:action.expected}],halted:false};},
  async complete(id,payload){if(row.crash)throw Error('simulated crash before report');await Q.completeAction(A,deviceId,id,payload);}
 };
 let executed=0;
 const execute=async input=>{executed++;return EX.executeAction(input);};
 await runAgentOnce(transport,{execute,receipts,host:pc.host});
 assert.equal(executed,1);assert.ok(receipts.get(action.id),'the effect is receipted even though the report crashed');
 assert.equal(await fs.readFile(pc.hostPath(file),'utf8'),'v1','the effect happened once');
 assert.equal((await Q.readAction(A,action.id)).status,'pending','the crashed report never reached the queue');

 // The cloud redelivers the SAME action id after the lease; the receipt
 // replays instead of writing a second time, and the queue finally gets its
 // (single, truthful) completion.
 row.crash=false;
 const replay=await runAgentOnce(transport,{execute,receipts,host:pc.host});
 assert.equal(replay.replayed,1);assert.equal(executed,1,'the state-changing effect ran exactly once');
 const record=await Q.readAction(A,action.id);
 assert.equal(record.status,'completed');
 assert.equal(record.verification?.status,'verified');
});
