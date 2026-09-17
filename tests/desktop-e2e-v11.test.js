// SAMVIT V12 — end-to-end computer-execution tests (P7).
//
// These cover the full path: cloud tool → policy → queue → local agent →
// observation → verification → mission state. Where the executor is exercised
// it runs against a REAL temporary directory, so "refused" means the
// filesystem was genuinely untouched.
//
// PLATFORM NOTE: the Windows path hardening in shared/desktop.js is
// deliberately Windows-specific and is tested as such. The executor tests that
// touch a real filesystem use the OS temp directory and therefore pass on any
// platform; the junction-escape test skips itself where symlinks cannot be
// created. Nothing here weakens the Windows rules to make another platform pass.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {createFakeStore} from './helpers/fake-store.js';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const stores=new Map(),store=n=>{if(!stores.has(n))stores.set(n,createFakeStore());return stores.get(n);};
mock.module('@netlify/blobs',{namedExports:{getStore:store}});
const D=await import('../shared/desktop.js');
const R=await import('../netlify/lib/devices/registry.js');
const Q=await import('../netlify/lib/devices/queue.js');
const DISP=await import('../netlify/lib/devices/dispatch.js');
const P=await import('../netlify/lib/devices/policy.js');
const PERM=await import('../netlify/lib/intelligence/permissions.js');
const T=await import('../netlify/lib/intelligence/tools.js');
const JOBS=await import('../netlify/lib/intelligence/jobs.js');
const RT=await import('../netlify/lib/intelligence/runtime.js');
const EX=await import('../agent/executor.js');
const AGENT=await import('../agent/main.js');
const RECEIPTS=await import('../agent/receipts.js');
const A='usr_00000000-0000-0000-0000-000000000001',B='usr_00000000-0000-0000-0000-000000000002',env={get:()=>undefined};

const ROOT='C:\\Projects\\Samvit';
const inScope=p=>`${ROOT}\\${p}`;

/** Pair a computer with a writable scope, returning its id. */
async function pairDevice(name='Main PC',scopes=[{path:ROOT,mode:'write'}],approvedCommands=[]){
 const {code}=await R.beginPairing(A);
 const result=await R.completePairing({code,deviceName:name,platform:'win32',arch:'x64'});
 await R.setDevicePolicy(A,result.deviceId,{scopes,approvedCommands});
 return result.deviceId;
}
const seedAccount=async()=>{
 stores.clear();
 for(const id of [A,B]){await store('samvit-accounts').setJSON('account:'+id,{id,emailVerified:true,sessionVersion:1});await store('samvit-subscription').setJSON('sub:'+id,{planId:'pro',status:'active'});}
};

// --------------------------------------------------------------------------
// P0 — sandbox vs local_pc separation
// --------------------------------------------------------------------------
test('the sandbox and the local computer are separate tool surfaces that cannot be confused',()=>{
 const local=T.availableTools(env,[...T.COMPUTER_DEVICE_GRANTS]);
 const names=local.map(t=>t.name);
 for(const name of ['computer_inspect','computer_list','computer_read','computer_search','computer_write','computer_mkdir','computer_move','computer_copy'])assert.ok(names.includes(name),name);
 // The local-PC grants must NOT unlock the sandbox tools, or vice versa.
 assert.ok(!names.includes('fs_write')&&!names.includes('terminal')&&!names.includes('fs_list'));
 const sandbox=T.availableTools(env,[...T.COMPUTER_GRANTS]);
 assert.ok(sandbox.map(t=>t.name).includes('fs_write'));
 assert.ok(!sandbox.map(t=>t.name).includes('computer_write'),'sandbox grants must not unlock a real computer');
 // Every local tool says which environment it acts on.
 for(const tool of local)assert.match(tool.description,/PAIRED LOCAL COMPUTER/);
 assert.match(T.availableTools(env,[...T.COMPUTER_GRANTS]).find(t=>t.name==='fs_write').description,/mission sandbox/);
});

test('a local-computer tool refuses to act when the mission selected no computer',async()=>{
 const context={accountId:A,env,grants:[...T.COMPUTER_DEVICE_GRANTS],confirmed:[],deviceId:null,signal:new AbortController().signal,assertActive:async()=>{},consumeTool:async()=>{},effectId:'e'};
 await assert.rejects(T.executeTool({name:'computer_write',arguments:{path:inScope('a.txt'),content:'x'}},context),/no computer selected/);
});

// --------------------------------------------------------------------------
// P1/P6 — device discovery and selection
// --------------------------------------------------------------------------
test('device availability reports online state and never scans more than it needs',async()=>{
 stores.clear();
 const deviceId=await pairDevice();
 const fresh=await DISP.deviceAvailability(A,deviceId);
 assert.equal(fresh.available,true);assert.equal(fresh.environment,'local_pc');
 assert.equal(fresh.online,false,'a computer that has never polled is not online');
 assert.equal(fresh.neverConnected,true);
 assert.deepEqual(fresh.authorisedFolders,[{path:ROOT,mode:'write'}]);
 assert.ok(fresh.capabilities.includes('fs.write'));
 // Once the agent has polled, the device reads as online.
 const device=await R.getDevice(A,deviceId);
 await store('samvit-devices').setJSON(`accounts/${A}/device:${deviceId}`,{...device,lastSeenAt:Date.now()});
 assert.equal((await DISP.deviceAvailability(A,deviceId)).online,true);
 // A device that has not polled within the staleness window is reported offline.
 const stale=await DISP.deviceAvailability(A,deviceId,{now:Date.now()+DISP.STALE_AFTER_MS+1});
 assert.equal(stale.online,false);assert.equal(stale.stale,true);
 assert.equal((await DISP.deviceAvailability(A,'00000000-0000-0000-0000-000000000000')).reason,'unknown_device');
});

test('device selection is explicit, refuses to guess between several computers, and explains a missing one',async()=>{
 stores.clear();
 assert.equal((await DISP.resolveTargetDevice(A,null)).reason,'no_device');
 const first=await pairDevice('Main PC');
 const single=await DISP.resolveTargetDevice(A,null);
 assert.equal(single.ok,true);assert.equal(single.deviceId,first);
 await pairDevice('Laptop');
 const ambiguous=await DISP.resolveTargetDevice(A,null);
 assert.equal(ambiguous.ok,false);assert.equal(ambiguous.reason,'ambiguous_device');
 assert.match(ambiguous.detail,/Main PC/);assert.match(ambiguous.detail,/Laptop/);
 const explicit=await DISP.resolveTargetDevice(A,first);
 assert.equal(explicit.ok,true);assert.equal(explicit.device.name,'Main PC');
 assert.equal((await DISP.resolveTargetDevice(A,'00000000-0000-0000-0000-000000000000')).reason,'unknown_device');
});

test('a revoked computer is refused at dispatch and at availability',async()=>{
 stores.clear();
 const deviceId=await pairDevice();
 await R.revokeDevice(A,deviceId);
 assert.equal((await DISP.deviceAvailability(A,deviceId)).reason,'device_revoked');
 await assert.rejects(DISP.requestDeviceAction(A,{deviceId,capability:'fs.read',args:{path:inScope('a.txt')}}),/disconnected/);
});

// --------------------------------------------------------------------------
// P0/P5 — policy, scopes, stops, approval
// --------------------------------------------------------------------------
test('an action outside the authorised folders is refused before anything is queued',async()=>{
 stores.clear();
 const deviceId=await pairDevice();
 await assert.rejects(
  DISP.requestDeviceAction(A,{deviceId,capability:'fs.write',args:{path:'C:\\Windows\\evil.dll',content:'x'}}),
  /authorised folders/
 );
 assert.equal((await Q.pendingActions(A,deviceId)).length,0,'a refused action must not be queued');
 await assert.rejects(
  DISP.requestDeviceAction(A,{deviceId,capability:'fs.write',args:{path:inScope('..\\..\\escape.txt'),content:'x'}}),
  /authorised|traversal/
 );
});

test('a read-only authorised folder permits reads but refuses writes',async()=>{
 stores.clear();
 const deviceId=await pairDevice('Read only',[{path:ROOT,mode:'read'}]);
 await assert.rejects(DISP.requestDeviceAction(A,{deviceId,capability:'fs.write',args:{path:inScope('a.txt'),content:'x'},sleepFn:async()=>{}}),/reading only|Refused/i);
});

test('the emergency stop halts device actions, and an unreadable stop state fails closed',async()=>{
 stores.clear();
 const deviceId=await pairDevice();
 await PERM.setGlobalStop({halted:true,reason:'operator'});
 await assert.rejects(DISP.requestDeviceAction(A,{deviceId,capability:'fs.read',args:{path:inScope('a.txt')}}),/Refused|kill switch/i);
 await PERM.setGlobalStop({halted:false});
 stores.set('samvit-global-safety',{get:async()=>{throw Error('offline');}});
 assert.equal((await PERM.readGlobalStop()).halted,true);
 await assert.rejects(DISP.requestDeviceAction(A,{deviceId,capability:'fs.read',args:{path:inScope('a.txt')}}),/Refused/i);
 stores.delete('samvit-global-safety');
});

test('an unapproved command parks the action for approval instead of running it',async()=>{
 stores.clear();
 const deviceId=await pairDevice('PC',[{path:ROOT,mode:'write'}],[]);
 const result=await DISP.requestDeviceAction(A,{deviceId,capability:'dev.run',args:{executable:'npm',args:['run','build']},confirmed:['computer_run'],sleepFn:async()=>{}});
 assert.equal(result.status,'awaiting_decision');
 assert.match(result.detail,/npm run/);
 const parked=await Q.pendingActions(A,deviceId);
 assert.equal(parked.length,1);
 assert.equal(parked[0].decision.outcome,'ASK_USER');
});

// --------------------------------------------------------------------------
// P0/P4 — enqueue → observe → verify
// --------------------------------------------------------------------------
/** Stand-in for the local agent: claims everything and reports `outcome`. */
const agentSleep=(deviceId,outcome,report={})=>async()=>{
 const claimed=await Q.claimActions(A,deviceId);
 for(const action of claimed)await Q.completeAction(A,deviceId,action.id,{observation:outcome,report});
};

test('a local action is queued, executed by the agent, observed and verified',async()=>{
 stores.clear();
 const deviceId=await pairDevice();
 const result=await DISP.requestDeviceAction(A,{deviceId,capability:'fs.write',args:{path:inScope('notes.txt'),content:'hello'},sleepFn:agentSleep(deviceId,{exists:true},{path:inScope('notes.txt'),bytes:5})});
 assert.equal(result.status,'completed');
 assert.equal(result.verification.status,'verified');
 assert.equal(result.report.bytes,5);
 assert.equal(result.expected.kind,'present');
});

test('a device that reports a different reality than promised is not treated as success',async()=>{
 stores.clear();
 const deviceId=await pairDevice();
 const result=await DISP.requestDeviceAction(A,{deviceId,capability:'fs.write',args:{path:inScope('notes.txt'),content:'hello'},sleepFn:agentSleep(deviceId,{exists:false})});
 assert.equal(result.status,'completed','the action ran');
 assert.equal(result.verification.status,'unresolved','but the effect was never observed');
 assert.equal(result.verification.reason,'not_present');
});

test('a device that never reports back is reported as a timeout, never as success',async()=>{
 stores.clear();
 const deviceId=await pairDevice();
 let clock=0;const now=()=>clock+=100000;
 const result=await DISP.requestDeviceAction(A,{deviceId,capability:'fs.read',args:{path:inScope('a.txt')},now,sleepFn:async()=>{}});
 assert.equal(result.status,'timeout');
 assert.match(result.detail,/has not reported back/);
 assert.equal(result.observation,undefined,'no observation means no success claim');
});

test('a failed action carries the failure back to the model',async()=>{
 stores.clear();
 const deviceId=await pairDevice();
 const result=await DISP.requestDeviceAction(A,{deviceId,capability:'fs.read',args:{path:inScope('missing.txt')},sleepFn:async()=>{
  const claimed=await Q.claimActions(A,deviceId);
  for(const action of claimed)await Q.completeAction(A,deviceId,action.id,{error:'Not found: C:\\Projects\\Samvit\\missing.txt'});
 }});
 assert.equal(result.status,'failed');
 assert.match(result.error,/Not found/);
 assert.equal(result.verification.status,'unresolved');
});

test('an abandoned action is reclaimed after its lease, and a stopped device does not spin forever',async()=>{
 stores.clear();
 const deviceId=await pairDevice();
 const action=await Q.enqueueAction(A,{deviceId,capability:'fs.read',args:{path:inScope('a.txt')}});
 const now=Date.now();
 assert.equal((await Q.claimActions(A,deviceId,{now})).length,1);
 assert.equal((await Q.claimActions(A,deviceId,{now})).length,0,'a live lease is respected');
 const reclaimed=await Q.claimActions(A,deviceId,{now:now+Q.DEFAULT_LEASE_MS+1});
 assert.equal(reclaimed.length,1,'an offline device recovers via lease expiry');
 // Repeatedly undelivered, the action eventually stops being retried.
 await Q.claimActions(A,deviceId,{now:now+Q.DEFAULT_LEASE_MS*3});
 const expired=await Q.claimActions(A,deviceId,{now:now+Q.DEFAULT_LEASE_MS*6});
 assert.equal(expired[0].status,'expired');
 assert.equal((await Q.claimActions(A,deviceId,{now:now+Q.DEFAULT_LEASE_MS*9})).length,0);
 assert.equal((await Q.readAction(A,action.id)).status,'expired');
});

// --------------------------------------------------------------------------
// P3 — durable receipts / idempotency
// --------------------------------------------------------------------------
test('a redelivered action is replayed from its receipt instead of being run twice',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'samvit-receipts-'));
 const receiptPath=join(root,'receipts.json');
 const receipts=RECEIPTS.createReceiptStore(receiptPath);
 const performed=[];
 const transport={
  policy:{scopes:[{path:root,mode:'write'}],approvedCommands:[]},
  async poll(){return {actions:[{id:'action-1',capability:'fs.write',args:{path:join(root,'a.txt')},expected:{kind:'present',path:join(root,'a.txt')}}],halted:false};},
  async complete(){}
 };
 const execute=async()=>{performed.push(1);return {observation:{exists:true},result:{ok:true}};};

 const first=await AGENT.runOnce(transport,{execute,receipts});
 assert.equal(first.executed,1);assert.equal(first.replayed,0);
 assert.ok(receipts.get('action-1'),'a completed state-changing action is recorded');
 // The same action id arrives again — the classic crash-before-report case.
 const second=await AGENT.runOnce(transport,{execute,receipts});
 assert.equal(second.executed,0);assert.equal(second.replayed,1);
 assert.equal(performed.length,1,'the operation must not run twice');
 await fs.rm(root,{recursive:true,force:true});
});

test('read-only actions are not receipted and a failure leaves no receipt',async()=>{
 assert.equal(RECEIPTS.shouldRecord('fs.write'),true);
 assert.equal(RECEIPTS.shouldRecord('dev.run'),true);
 assert.equal(RECEIPTS.shouldRecord('fs.read'),false);
 assert.equal(RECEIPTS.shouldRecord('fs.list'),false);
 const root=await fs.mkdtemp(join(tmpdir(),'samvit-receipts2-'));
 const receipts=RECEIPTS.createReceiptStore(join(root,'r.json'));
 receipts.put('x',{capability:'fs.write',observation:{exists:true}});
 assert.ok(receipts.get('x'));assert.equal(receipts.get('nope'),null);assert.equal(receipts.get(''),null);
 // A refusing agent records nothing, so a genuine retry still happens.
 const transport={policy:{scopes:[],approvedCommands:[]},async poll(){return {actions:[{id:'y',capability:'fs.write',args:{}}],halted:false};},async complete(){}};
 await AGENT.runOnce(transport,{execute:async()=>{throw Error('outside authorised folders');},receipts});
 assert.equal(receipts.get('y'),null);
 await fs.rm(root,{recursive:true,force:true});
});

// --------------------------------------------------------------------------
// P2 — mission state machine: WAITING_FOR_USER, resume, cancel
// --------------------------------------------------------------------------
const spec={intent:'action',complexity:'moderate',freshness_required:false,needs_tools:false,needs_verification:false,verification_level:'none',risk:'low',output_type:'answer',strategy:'single'};
const plan={tasks:[{id:'a',phase:'p',sub_mission:'s',description:'Do the thing',dependencies:[],kind:'work',capability:'general',tools:[]}]};
const modelCall=()=>{let stage=0;return async()=>({content:JSON.stringify(++stage===1?spec:plan)});};

test('a mission parks in WAITING_FOR_USER on a decision, then resumes from its checkpoint',async()=>{
 await seedAccount();
 const deviceId=await pairDevice();
 const job=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Create a folder and write a file',deviceId,allowLocalComputer:true},env);
 assert.equal(job.environment,'local_pc');assert.equal(job.deviceId,deviceId);

 let answered=false;
 const agent=async()=>{
  if(!answered)throw Object.assign(Error('Waiting for your decision'),{reason:'awaiting_user_decision',decision:{id:'d1',question:'Write into your project folder?',why:'It needs your approval.',options:[{id:'approve',label:'Approve'}]}});
  return {output:'Wrote the file',evidence:[],models:['fixture'],steps:1};
 };
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 const parked=await JOBS.getJob(A,job.id);
 assert.equal(parked.status,'waiting_for_user','a decision must not fail the mission');
 assert.equal(parked.pendingDecision.id,'d1');
 assert.equal(parked.tasks.find(t=>t.id==='a').status,'pending','the task stays pending so it can resume');
 assert.ok(!parked.output,'no result is claimed while waiting');

 // Resuming without an answer parks it again — idempotent, never a silent run.
 await JOBS.commandJob(A,job.id,'resume');
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 assert.equal((await JOBS.getJob(A,job.id)).status,'waiting_for_user');

 // Answering records it and re-queues; the re-run finds the answer.
 const queued=await JOBS.commandJob(A,job.id,'decide',{decisionId:'d1',answer:'approve'});
 assert.equal(queued.status,'queued');assert.equal(queued.pendingDecision,null);assert.equal(queued.decisions.d1,'approve');
 answered=true;
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 const done=await JOBS.getJob(A,job.id);
 assert.equal(done.status,'completed');
 assert.equal(done.output,'Wrote the file');
 assert.equal(done.decisions.d1,'approve','the answer survives the checkpoint');
});

test('a decision cannot be answered twice, forged, or answered for another mission',async()=>{
 await seedAccount();
 const deviceId=await pairDevice();
 const job=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Create a folder for the project',deviceId,allowLocalComputer:true},env);
 const agent=async()=>{throw Object.assign(Error('waiting'),{reason:'awaiting_user_decision',decision:{id:'d1',question:'Proceed?',options:[]}});};
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 await assert.rejects(JOBS.commandJob(A,job.id,'decide',{decisionId:'wrong-id',answer:'approve'}),/no longer waiting/);
 await assert.rejects(JOBS.commandJob(A,job.id,'decide',{decisionId:'d1',answer:''}),/answer is required/);
 await assert.rejects(JOBS.commandJob(B,job.id,'decide',{decisionId:'d1',answer:'approve'}),/not found/);
 await JOBS.commandJob(A,job.id,'decide',{decisionId:'d1',answer:'approve'});
 await assert.rejects(JOBS.commandJob(A,job.id,'decide',{decisionId:'d1',answer:'approve'}),/no longer waiting/);
});

test('a parked mission is not claimable by a worker until it is answered',async()=>{
 await seedAccount();
 const deviceId=await pairDevice();
 const job=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Create a folder for the project',deviceId,allowLocalComputer:true},env);
 const agent=async()=>{throw Object.assign(Error('waiting'),{reason:'awaiting_user_decision',decision:{id:'d1',question:'Proceed?',options:[]}});};
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 const second=await RT.runJob(A,job.id,env,{modelCall:async()=>assert.fail('must not run while waiting'),agent});
 assert.equal(second.claimed,false);
});

test('a mission can be cancelled, and a cancelled mission is terminal',async()=>{
 await seedAccount();
 const deviceId=await pairDevice();
 const job=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Create a folder for the project',deviceId,allowLocalComputer:true},env);
 const cancelled=await JOBS.commandJob(A,job.id,'cancel');
 assert.equal(cancelled.status,'cancelled');
 assert.equal((await RT.runJob(A,job.id,env,{modelCall:async()=>assert.fail('cancelled missions must not run')})).claimed,false);
 await assert.rejects(JOBS.commandJob(A,job.id,'resume'),/cannot resume/);
});

test('a mission targeting a computer that was revoked mid-flight fails honestly',async()=>{
 await seedAccount();
 const deviceId=await pairDevice();
 const job=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Create a folder for the project',deviceId,allowLocalComputer:true},env);
 await R.revokeDevice(A,deviceId);
 const agent=async(context,task,input,{modelCall:callModel})=>{
  const {requestDeviceAction}=DISP;
  await requestDeviceAction(A,{deviceId,capability:'fs.read',args:{path:inScope('a.txt')}});
  return {output:'unreachable',evidence:[],models:['m'],steps:1};
 };
 await RT.runJob(A,job.id,env,{modelCall:modelCall(),agent});
 const done=await JOBS.getJob(A,job.id);
 assert.equal(done.status,'failed');
 assert.match(done.error,/No deliverable|failed/i,'a failure must explain itself');
 assert.match(done.error,/disconnected|revoked|not paired/i);
 assert.equal(done.output,'','no result is fabricated for an unreachable computer');
});

test('mission grants are least-privilege: a computer alone does not authorise deletion or commands',async()=>{
 await seedAccount();
 const deviceId=await pairDevice();
 const plain=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Organise the project folder',deviceId,allowLocalComputer:true},env);
 assert.ok(plain.grants.includes('computer_write')&&plain.grants.includes('computer_read'));
 assert.ok(!plain.grants.includes('computer_delete'));
 assert.ok(!plain.grants.includes('computer_run'));
 assert.deepEqual(plain.confirmed,[]);
 const full=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Clean and rebuild the project folder',deviceId,allowLocalComputer:true,allowLocalDelete:true,allowLocalCommands:true},env);
 assert.ok(full.grants.includes('computer_delete')&&full.grants.includes('computer_run'));
 assert.deepEqual(full.confirmed.sort(),['computer_delete','computer_run']);
 // Requesting local access with no computer selected grants nothing local.
 const none=await JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Explain how gravity works',allowLocalComputer:true},env);
 assert.equal(none.deviceId,null);assert.ok(!none.grants.includes('computer_write'));
});

test('a mission cannot target a computer that is not paired or has been disconnected',async()=>{
 await seedAccount();
 await assert.rejects(JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Organise the project folder',deviceId:'00000000-0000-0000-0000-000000000000',allowLocalComputer:true},env),/not paired/);
 const deviceId=await pairDevice();
 await R.revokeDevice(A,deviceId);
 await assert.rejects(JOBS.createJob(A,{requestId:crypto.randomUUID(),goal:'Organise the project folder',deviceId,allowLocalComputer:true},env),/disconnected/);
});

test('two computers stay isolated: an action queued for one is never claimed by the other',async()=>{
 stores.clear();
 const main=await pairDevice('Main PC');
 const laptop=await pairDevice('Laptop');
 const action=await Q.enqueueAction(A,{deviceId:main,capability:'fs.read',args:{path:inScope('a.txt')}});
 assert.equal((await Q.claimActions(A,laptop)).length,0,'the laptop must not claim the desktop\'s work');
 const claimed=await Q.claimActions(A,main);
 assert.equal(claimed.length,1);assert.equal(claimed[0].id,action.id);
 // And a report from the wrong computer is refused.
 await assert.rejects(Q.completeAction(A,laptop,action.id,{observation:{exists:true}}),/not queued for this computer/);
});

// --------------------------------------------------------------------------
// P4/P5 — executor behaviour on a real filesystem
// --------------------------------------------------------------------------
test('the executor performs and verifies a real write, then a real delete',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'samvit-e2e-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const scopes=[{path:root,mode:'write'}];
 const file=join(root,'note.txt');
 const write=await EX.executeAction({scopes,approvedCommands:[],capability:'fs.write',args:{path:file,content:'hello'}});
 assert.equal(D.verifyObservation(D.expectationFor('fs.write',{path:file}),write.observation).status,'verified');
 assert.equal((await EX.executeAction({scopes,approvedCommands:[],capability:'fs.read',args:{path:file}})).result.content,'hello');
 const del=await EX.executeAction({scopes,approvedCommands:[],capability:'fs.delete',args:{path:file}});
 assert.equal(D.verifyObservation(D.expectationFor('fs.delete',{path:file}),del.observation).status,'verified');
});

test('the executor refuses a path outside the authorised folder without touching disk',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'samvit-e2e-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const outside=join(tmpdir(),'samvit-should-not-exist.txt');
 await assert.rejects(EX.executeAction({scopes:[{path:root,mode:'write'}],approvedCommands:[],capability:'fs.write',args:{path:outside,content:'x'}}),/authorised|Refused/);
 assert.equal(await fs.stat(outside).then(()=>true).catch(()=>false),false);
});

test('a junction inside an authorised folder cannot be used to escape it',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'samvit-e2e-'));
 const outside=await fs.mkdtemp(join(tmpdir(),'samvit-out-'));
 t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(outside,{recursive:true,force:true})]));
 await fs.writeFile(join(outside,'secret.txt'),'secret');
 try { await fs.symlink(outside,join(root,'link'),'junction'); }
 catch { t.skip('this platform does not permit creating junctions without elevation'); return; }
 await assert.rejects(EX.executeAction({scopes:[{path:root,mode:'read'}],approvedCommands:[],capability:'fs.read',args:{path:join(root,'link','secret.txt')}}),/outside the authorised folders/);
});

test('only approved commands run, and never through a shell',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'samvit-e2e-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const base={scopes:[{path:root,mode:'write'}]};
 await assert.rejects(EX.executeAction({...base,approvedCommands:[],capability:'dev.run',args:{executable:'node',args:['--version']}}),/not approved/);
 await assert.rejects(EX.executeAction({...base,approvedCommands:['node --version'],capability:'dev.run',args:{executable:'powershell',args:['-c','Get-Process']}}),/not an approved executable/);
 await assert.rejects(EX.executeAction({...base,approvedCommands:['node --version'],capability:'dev.run',args:{executable:'node',args:['-e','process.exit(0)']}}),/may not be used with -e/);
 const run=await EX.executeAction({...base,approvedCommands:['node --version'],capability:'dev.run',args:{executable:'node',args:['--version'],cwd:root}});
 assert.equal(run.observation.exitCode,0);
 assert.match(run.result.stdout,/^v\d+/);
});
