// SAMVIT V14 — P14 proactive foundation tests.
//
// The promises being verified:
//   * Opt-in only, and scope-limited: a watch cannot cover a folder the user
//     has not already authorised for THAT machine (cloud AND agent check).
//   * Capped (3/device), expiring (30d), rate-limited (20 signals/day).
//   * Cancellable — one click and it is off, and the agent stops watching.
//   * Auditable — every enable, disable and signal is an audit row.
//   * Advisory only — a signal writes to an inbox + audit log, never to a
//     mission, a model call, or a computer action.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createFakeStore} from './helpers/fake-store.js';
const stores=new Map(),store=n=>{if(!stores.has(n))stores.set(n,createFakeStore());return stores.get(n);};
mock.module('@netlify/blobs',{namedExports:{getStore:store}});
const P=await import('../shared/proactive.js');
const PRO=await import('../netlify/lib/devices/proactive.js');
const REG=await import('../netlify/lib/devices/registry.js');
const PERM=await import('../netlify/lib/intelligence/permissions.js');
const AG=await import('../agent/proactive.js');
const A='usr_00000000-0000-0000-0000-000000000001';

const seedDevice=async({scopes=[{path:'C:\\Users\\you\\Projects',mode:'write'}]}={})=>{
 stores.clear();
 await store('samvit-accounts').setJSON('account:'+A,{id:A,emailVerified:true,sessionVersion:1});
 const {code}=await REG.beginPairing(A);
 const {deviceId}=await REG.completePairing({code,deviceName:'Office PC',platform:'win32',arch:'x64'});
 await REG.setDevicePolicy(A,deviceId,{scopes,approvedCommands:[]});
 return deviceId;
};

test('P14: a watch cannot authorise itself — unauthorised folders refuse, inside-scope folders pass',()=>{
 const device={revoked:false,scopes:[{path:'C:\\Users\\you\\Projects',mode:'write'}],monitors:[]};
 assert.throws(()=>P.validateMonitor({device,kind:'watch.folder',path:'C:\\Windows\\System32'}),/authorised/);
 assert.throws(()=>P.validateMonitor({device,kind:'watch.folder',path:'C:\\Users\\you\\ProjectsX'}),/authorised/,'prefix-of-scope is not inside the scope');
 const ok=P.validateMonitor({device,kind:'watch.folder',path:'C:\\Users\\you\\Projects\\src',now:1000});
 assert.equal(ok.expiresAt,1000+P.MONITOR_TTL_MS,'watches expire — consent is time-boxed, not forever');
 assert.equal(ok.enabled,true);
 assert.throws(()=>P.validateMonitor({device:{...device,revoked:true},kind:'watch.folder',path:'C:\\Users\\you\\Projects'}),/not connected/);
 assert.throws(()=>P.validateMonitor({device,kind:'watch.everything',path:'C:\\Users\\you\\Projects'}),/Unknown monitor kind/,'whole-PC surveillance is not a kind');
 const capped={...device,monitors:[1,2,3].map(i=>({id:String(i),kind:'watch.folder',path:`C:\\Users\\you\\Projects\\${i}`,enabled:true,expiresAt:Date.now()+1000}))};
 assert.throws(()=>P.validateMonitor({device:capped,kind:'watch.folder',path:'C:\\Users\\you\\Projects\\9'}),new RegExp(String(P.MAX_MONITORS_PER_DEVICE)),'the per-device cap holds');
});

test('P14: store-backed enable/disable/archive, signals land in inbox + audit, rate limit enforces',async()=>{
 const deviceId=await seedDevice();
 const monitor=await PRO.enableMonitor(A,deviceId,{kind:'watch.folder',path:'C:\\Users\\you\\Projects'});
 assert.equal((await PRO.monitorsForDevice(A,deviceId)).length,1);
 // Same path re-enabled: replaces (fresh id), not duplicates.
 await PRO.enableMonitor(A,deviceId,{kind:'watch.folder',path:'C:\\Users\\you\\Projects'});
 assert.equal((await PRO.monitorsForDevice(A,deviceId)).length,1);
 const liveId=(await PRO.monitorsForDevice(A,deviceId))[0].id;
 // Unauthorised folder refuses at the store layer too (defence in depth).
 await assert.rejects(PRO.enableMonitor(A,deviceId,{kind:'watch.folder',path:'C:\\'}),/authorised|too short|not allowed|cannot/i);
 // Signals are validated against the ACTIVE monitor list.
 const recorded=await PRO.recordSignal(A,deviceId,{monitorId:liveId,path:'C:\\Users\\you\\Projects\\notes.txt',event:'changed'});
 assert.equal(recorded.recorded,true);
 assert.deepEqual(await PRO.recordSignal(A,deviceId,{monitorId:'nope',path:'C:\\Users\\you\\Projects\\x.txt'}).then(()=>null).catch(e=>/No active watch/.test(e.message)),true,'a signal for an unknown watch is rejected');
 const inbox=await PRO.readSignals(A);
 assert.equal(inbox.length,1);
 assert.equal(inbox[0].deviceId,deviceId);
 const audit=(await PERM.readAudit(A));
 assert.ok(audit.some(row=>row.action==='proactive signal watch.folder'));
 // Rate limit: 20 recent signals today — the 21st is dropped, not credited.
 const device=await REG.getDevice(A,deviceId);
 await store('samvit-devices').setJSON(`accounts/${A}/device:${deviceId}`,{...device,signalHistory:Array.from({length:P.MAX_SIGNALS_PER_DAY},()=>Date.now())});
 const dropped=await PRO.recordSignal(A,deviceId,{monitorId:liveId,path:'C:\\Users\\you\\Projects\\more.txt'});
 assert.equal(dropped.recorded,false);
 assert.equal(dropped.reason,'rate_limited');
 // Cancel: off the active list, and the record survives as history.
 await PRO.disableMonitor(A,deviceId,liveId);
 assert.equal((await PRO.monitorsForDevice(A,deviceId)).length,0);
 assert.ok((await PERM.readAudit(A)).some(row=>row.action==='proactive disable'));
});

test('P14: the agent watcher respects local containment and debounces a burst into one signal',async t=>{
 const dir=await fs.mkdtemp(join(tmpdir(),'samvit-watch-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const host={name:'test',toHostPath:()=>dir,fromHostPath:p=>p};
 const scopes=[{path:'C:\\Watched',mode:'write'}];
 const events=[];
 let watchers=new Map();
 const reconcile=(monitors)=>{watchers=AG.reconcileWatchers(watchers,monitors,scopes,{host,log:()=>{},debounceMs:20,onEvent:async s=>events.push(s)});return watchers;};
 // Inside-scope monitor starts watching; outside-folder monitor never gets a watcher (local refusal).
 const map=reconcile([{id:'m1',kind:'watch.folder',path:'C:\\Watched'},{id:'m2',kind:'watch.folder',path:'C:\\Else'}]);
 assert.equal(map.size,1,'only the contained watch is running');
 // A burst of file activity → exactly ONE debounced signal.
 await fs.writeFile(join(dir,'a.txt'),'one');
 await fs.writeFile(join(dir,'b.txt'),'two');
 await fs.writeFile(join(dir,'a.txt'),'three');
 await new Promise(r=>setTimeout(r,200));
 assert.equal(events.length,1);
 assert.equal(events[0].monitorId,'m1');
 // Cloud says stop: reconcile with no monitors kills the watcher — immediately and for real.
 reconcile([]);
 assert.equal(watchers.size,0);
 await fs.writeFile(join(dir,'c.txt'),'four');
 await new Promise(r=>setTimeout(r,200));
 assert.equal(events.length,1,'no signals after the watch is cancelled');
 AG.closeWatchers(watchers);
});
