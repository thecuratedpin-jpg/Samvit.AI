// SAMVIT V12 — desktop bridge tests.
//
// These are the security-critical tests: path containment, scope escape,
// command restriction, pairing, replay protection, policy outcomes, the
// observation/verification loop, and the stops. The executor tests run
// against a REAL temporary directory, so "refused" means the filesystem was
// genuinely never touched.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {createFakeStore,createFailingStore} from './helpers/fake-store.js';
import {createDeviceHost} from './helpers/device-host.js';
import {promises as fs} from 'node:fs';
const stores=new Map(),store=n=>{if(!stores.has(n))stores.set(n,createFakeStore());return stores.get(n);};
mock.module('@netlify/blobs',{namedExports:{getStore:store}});
const D=await import('../shared/desktop.js');
const R=await import('../netlify/lib/devices/registry.js');
const Q=await import('../netlify/lib/devices/queue.js');
const P=await import('../netlify/lib/devices/policy.js');
const PERM=await import('../netlify/lib/intelligence/permissions.js');
const EX=await import('../agent/executor.js');
const AD=await import('../agent/adapters.js');
const AGENT=await import('../agent/main.js');
const A='usr_00000000-0000-0000-0000-000000000001';

// --------------------------------------------------------------------------
// Phase 3 — path hardening
// --------------------------------------------------------------------------
test('path hardening rejects every way of naming something other than a plain file',()=>{
 for(const bad of [
  '..\\..\\Windows\\System32\\config\\SAM','C:\\Projects\\..\\..\\Windows','\\\\server\\share\\x',
  '\\\\?\\C:\\Projects\\x','\\\\.\\PhysicalDrive0','C:Projects','C:\\Projects\\file.txt:stream',
  'C:\\Projects\\CON','C:\\Projects\\nul.txt','C:\\Projects\\COM1','C:\\Projects\\LPT9.log',
  'C:\\Projects\\trailing.','C:\\Projects\\trailing ','C:\\Projects\\a\u0000b','relative\\path','/unix/style',''
 ]) assert.throws(()=>D.canonicalPath(bad),undefined,JSON.stringify(bad));
 assert.equal(D.canonicalPath('c:/Projects/Samvit/./src/'),'C:\\Projects\\Samvit\\src');
 assert.equal(D.canonicalPath('C:\\Projects'),'C:\\Projects');
 assert.equal(D.canonicalPath('C:\\'),'C:\\');
});

test('scope containment is case- and separator-insensitive and cannot be fooled by prefixes',()=>{
 const root='C:\\Users\\dev\\Projects\\Samvit';
 assert.equal(D.isWithin('C:\\Users\\dev\\Projects\\Samvit\\src\\a.js',root),true);
 assert.equal(D.isWithin('c:/users/dev/projects/samvit/a.js',root),true);
 assert.equal(D.isWithin(root,root),true);
 // A sibling folder sharing a name prefix is NOT inside.
 assert.equal(D.isWithin('C:\\Users\\dev\\Projects\\Samvit-secrets\\a.js',root),false);
 assert.equal(D.isWithin('C:\\Users\\dev\\Projects\\Other\\a.js',root),false);
 assert.equal(D.isWithin('C:\\Windows\\System32',root),false);
});

test('the most specific authorised folder wins, and a read-only scope refuses writes',()=>{
 const scopes=[{path:'C:\\Projects',mode:'read'},{path:'C:\\Projects\\Samvit',mode:'write'}];
 assert.equal(D.checkScopeAccess(scopes,'C:\\Projects\\other\\a.txt','write').reason,'scope_is_read_only');
 const inside=D.checkScopeAccess(scopes,'C:\\Projects\\Samvit\\src\\a.js','write');
 assert.equal(inside.allowed,true);
 assert.equal(inside.root,'C:\\Projects\\Samvit');
 assert.equal(D.checkScopeAccess(scopes,'C:\\Elsewhere\\a.js','read').reason,'outside_approved_scopes');
 assert.equal(D.checkScopeAccess(scopes,'..\\escape','read').reason,'invalid_path');
});

test('system directories and whole drives can never be authorised',()=>{
 for(const bad of ['C:\\Windows','C:\\Windows\\System32','C:\\Program Files','C:\\ProgramData','C:\\','D:\\','C:\\Users\\Public'])
  assert.throws(()=>D.validateScopeRoot(bad),undefined,bad);
 assert.equal(D.validateScopeRoot('C:\\Users\\dev\\Projects\\Samvit'),'C:\\Users\\dev\\Projects\\Samvit');
 assert.deepEqual(D.normalizeScopes([{path:'C:\\Work',mode:'write'}]),[{path:'C:\\Work',mode:'write'}]);
 assert.deepEqual(D.normalizeScopes([{path:'C:\\Work',mode:'nonsense'}]),[{path:'C:\\Work',mode:'read'}]);
 assert.throws(()=>D.normalizeScopes([{path:'C:\\Windows'}]),/cannot be authorised/);
});

// --------------------------------------------------------------------------
// Phase 4 — command restrictions
// --------------------------------------------------------------------------
test('the command floor refuses arbitrary execution and package installation',()=>{
 assert.throws(()=>D.validateCommand('powershell',['-Command','Get-Process']),/not an approved executable/);
 assert.throws(()=>D.validateCommand('cmd',['/c','dir']),/not an approved executable/);
 assert.throws(()=>D.validateCommand('npx',['some-package']),/not an approved executable/);
 assert.throws(()=>D.validateCommand('bash',['-c','rm -rf /']),/not an approved executable/);
 assert.throws(()=>D.validateCommand('node',['-e','require("fs").rmSync("C:\\\\",{recursive:true})']),/may not be used with -e/);
 assert.throws(()=>D.validateCommand('node',['--eval','process.exit()']),/may not be used with --eval/);
 assert.throws(()=>D.validateCommand('npm',['publish']),/not an approved subcommand/);
 assert.throws(()=>D.validateCommand('npm',['install']),/not an approved subcommand/);
 assert.throws(()=>D.validateCommand('git',['push','origin','main']),/not an approved subcommand/);
 assert.throws(()=>D.validateCommand('git',['-c','core.pager=evil','status']),/may not be used with -c/);
 assert.deepEqual(D.validateCommand('node',['script.js']),{executable:'node',args:['script.js']});
 assert.deepEqual(D.validateCommand('npm',['test']).args,['test']);
 assert.deepEqual(D.validateCommand('git',['status','--short']).args,['status','--short']);
});

test('a command must be approved for the specific computer, and approval is scoped to the verb',()=>{
 const approved=['npm test','git status'];
 assert.equal(D.checkCommandAccess(approved,'npm',['test']).allowed,true);
 assert.equal(D.checkCommandAccess(approved,'npm',['test','--','--watch']).allowed,true,'extra args keep the same approval');
 assert.equal(D.checkCommandAccess(approved,'npm',['run']).reason,'command_not_approved_for_device');
 assert.equal(D.checkCommandAccess(approved,'npm',['publish']).reason,'command_not_permitted','the floor still applies');
 assert.equal(D.checkCommandAccess(approved,'powershell',['-c','x']).reason,'command_not_permitted');
 assert.equal(D.checkCommandAccess([],'npm',['test']).reason,'command_not_approved_for_device');
 assert.equal(D.commandKey('NPM.CMD',['TEST']),'npm test');
});

// --------------------------------------------------------------------------
// Phase 4 — policy outcomes
// --------------------------------------------------------------------------
const device=(over={})=>({id:'dev-1',revoked:false,scopes:[{path:'C:\\Projects\\Samvit',mode:'write'}],approvedCommands:['npm test'],...over});

test('the policy engine returns exactly ALLOW, DENY or ASK_USER — never a silent pass',()=>{
 const inScope='C:\\Projects\\Samvit\\src\\a.js';
 assert.equal(P.decideLocalAction({capability:'fs.read',args:{path:inScope},device:device()}).outcome,'ALLOW');
 assert.equal(P.decideLocalAction({capability:'fs.read',args:{path:'C:\\Windows\\win.ini'},device:device()}).outcome,'DENY');
 assert.equal(P.decideLocalAction({capability:'fs.read',args:{path:'C:\\Windows\\win.ini'},device:device()}).reason,'outside_approved_scopes');
 assert.equal(P.decideLocalAction({capability:'fs.delete',args:{path:inScope},device:device()}).outcome,'ASK_USER');
 assert.equal(P.decideLocalAction({capability:'fs.delete',args:{path:inScope},device:device(),confirmed:['fs.delete']}).outcome,'ALLOW');
 assert.equal(P.decideLocalAction({capability:'unknown.thing',args:{},device:device()}).outcome,'DENY');
 assert.equal(P.decideLocalAction({capability:'request_user_decision',args:{question:'x'},device:device()}).reason,'not_a_device_capability');
 assert.equal(P.decideLocalAction({capability:'fs.read',args:{path:inScope},device:null}).reason,'no_paired_computer');
 assert.equal(P.decideLocalAction({capability:'fs.read',args:{path:inScope},device:device({revoked:true})}).reason,'device_revoked');
 assert.equal(P.decideLocalAction({capability:'fs.read',args:{path:inScope},device:device(),halted:true}).reason,'kill_switch');
 assert.equal(P.decideLocalAction({capability:'fs.read',args:{path:123},device:device()}).reason,'invalid_arguments');
});

test('running a command is an ASK until the user approves that exact command',()=>{
 const unapproved=P.decideLocalAction({capability:'dev.run',args:{executable:'npm',args:['run','build']},device:device()});
 assert.equal(unapproved.outcome,'ASK_USER');
 assert.equal(unapproved.command,'npm run');
 const approved=P.decideLocalAction({capability:'dev.run',args:{executable:'npm',args:['test']},device:device()});
 assert.equal(approved.outcome,'ASK_USER','dev.run is SENSITIVE and still needs the mission confirmation');
 const both=P.decideLocalAction({capability:'dev.run',args:{executable:'npm',args:['test']},device:device(),confirmed:['dev.run']});
 assert.equal(both.outcome,'ALLOW');
 assert.equal(both.args.command,'npm test');
 // The hard floor is a DENY, not an ASK — the user cannot approve powershell.
 const floor=P.decideLocalAction({capability:'dev.run',args:{executable:'powershell',args:['-c','x']},device:device(),confirmed:['dev.run']});
 assert.equal(floor.outcome,'DENY');
 assert.equal(floor.reason,'command_not_permitted');
});

test('every path a move touches is scope-checked, not just the source',()=>{
 const base='C:\\Projects\\Samvit\\a.txt';
 assert.equal(P.decideLocalAction({capability:'fs.move',args:{from:base,to:'C:\\Projects\\Samvit\\b.txt'},device:device()}).outcome,'ALLOW');
 assert.equal(P.decideLocalAction({capability:'fs.move',args:{from:base,to:'C:\\Elsewhere\\b.txt'},device:device()}).outcome,'DENY');
 assert.equal(P.decideLocalAction({capability:'fs.copy',args:{from:base,to:'C:\\Windows\\b.txt'},device:device()}).outcome,'DENY');
 assert.deepEqual(P.pathsFor('fs.move',{from:'a',to:'b'}),['a','b']);
});

// --------------------------------------------------------------------------
// Phase 5 — observation vs expectation
// --------------------------------------------------------------------------
test('verification compares what was promised with what was actually observed',()=>{
 assert.equal(D.verifyObservation({kind:'present',path:'/a'},{exists:true}).status,'verified');
 assert.equal(D.verifyObservation({kind:'present',path:'/a'},{exists:false}).status,'unresolved');
 assert.equal(D.verifyObservation({kind:'absent',path:'/a'},{exists:false}).status,'verified');
 assert.equal(D.verifyObservation({kind:'absent',path:'/a'},{exists:true}).status,'unresolved');
 assert.equal(D.verifyObservation({kind:'moved',path:'/b',from:'/a'},{exists:true,fromExists:false}).status,'verified');
 assert.equal(D.verifyObservation({kind:'moved',path:'/b',from:'/a'},{exists:true,fromExists:true}).status,'unresolved');
 assert.equal(D.verifyObservation({kind:'exit',code:0},{exitCode:0}).status,'verified');
 assert.equal(D.verifyObservation({kind:'exit',code:0},{exitCode:1}).status,'unresolved');
 assert.equal(D.verifyObservation({kind:'exit',code:0},{exitCode:1}).reason,'exit_code_mismatch');
 assert.equal(D.verifyObservation({kind:'content',path:'/a',contains:'ok'},{content:'all ok'}).status,'verified');
 assert.equal(D.verifyObservation({kind:'content',path:'/a',contains:'ok'},{content:'nope'}).status,'unresolved');
 assert.equal(D.verifyObservation({kind:'present',path:'/a'},null).status,'unresolved','a missing observation is never a pass');
 assert.equal(D.verifyObservation(null,{exists:true}).status,'unverifiable');
 assert.equal(D.expectationFor('fs.write',{path:'/a'}).kind,'present');
 assert.equal(D.expectationFor('fs.delete',{path:'/a'}).kind,'absent');
 assert.equal(D.expectationFor('fs.read',{path:'/a'}),null);
});

// --------------------------------------------------------------------------
// Phase 2 — pairing, authentication, revocation
// --------------------------------------------------------------------------
test('pairing issues a device token once, burns the code, and never stores the token',async()=>{
 stores.clear();
 const {code}=await R.beginPairing(A);
 assert.match(code,/^[A-Z2-9]{8}$/);
 const result=await R.completePairing({code,deviceName:'Test PC',platform:'win32',arch:'x64'});
 assert.match(result.deviceId,/^[0-9a-f-]{36}$/);
 assert.ok(result.deviceToken.length>=32);
 // The plaintext token must not be recoverable from storage.
 const auth=await store('samvit-device-auth').get('auth:'+result.deviceId,{type:'json'});
 assert.ok(auth.tokenHash);assert.equal(JSON.stringify(auth).includes(result.deviceToken),false);
 const stored=await store('samvit-devices').get(`accounts/${A}/device:${result.deviceId}`,{type:'json'});
 assert.equal(JSON.stringify(stored).includes(result.deviceToken),false);
 assert.equal(stored.revoked,false);assert.deepEqual(stored.scopes,[]);
 // The code is single use.
 await assert.rejects(R.completePairing({code,deviceName:'Again'}),/already been used/);
 await assert.rejects(R.completePairing({code:'ZZZZZZZZ'}),/not valid/);
 await assert.rejects(R.completePairing({code:'short'}),/8-character/);
});

test('an expired pairing code is refused',async()=>{
 stores.clear();
 const {code}=await R.beginPairing(A);
 await assert.rejects(R.completePairing({code},{now:Date.now()+R.PAIRING_TTL_MS+1}),/expired/);
});

test('device authentication accepts only the right token and refuses revoked devices',async()=>{
 stores.clear();
 const {deviceId,deviceToken}=await R.completePairing({code:(await R.beginPairing(A)).code,deviceName:'PC'});
 const req=(token,extra={})=>new Request('https://samvit.test/api/device-agent',{method:'POST',headers:{'x-samvit-device':deviceId,authorization:`Bearer ${token}`,...extra}});
 assert.equal((await R.authenticateDevice(req(deviceToken))).deviceId,deviceId);
 await assert.rejects(R.authenticateDevice(req('wrong-token-wrong-token')),/authentication failed/);
 await assert.rejects(R.authenticateDevice(req('')),/authentication required/);
 await assert.rejects(R.authenticateDevice(new Request('https://samvit.test/api/device-agent',{method:'POST',headers:{'x-samvit-device':'not-a-uuid',authorization:`Bearer ${deviceToken}`}})),/authentication required/);
 await R.revokeDevice(A,deviceId);
 await assert.rejects(R.authenticateDevice(req(deviceToken)),/not connected to Samvit/);
});

test('a captured request cannot be replayed, and a skewed clock is refused',async()=>{
 stores.clear();
 const {deviceId,deviceToken}=await R.completePairing({code:(await R.beginPairing(A)).code,deviceName:'PC'});
 const headers=extra=>({method:'POST',headers:{'x-samvit-device':deviceId,authorization:`Bearer ${deviceToken}`,...extra}});
 const nonce='nonce-abcdefgh',timestamp=String(Date.now());
 const request=()=>new Request('https://samvit.test/api/device-agent',headers({'x-samvit-nonce':nonce,'x-samvit-timestamp':timestamp}));
 await R.authenticateDevice(request());
 await assert.rejects(R.authenticateDevice(request()),/already used/,'the same nonce must not work twice');
 const fresh=new Request('https://samvit.test/api/device-agent',headers({'x-samvit-nonce':'other-nonce-123','x-samvit-timestamp':String(Date.now()+R.MAX_CLOCK_SKEW_MS+5000)}));
 await assert.rejects(R.authenticateDevice(fresh),/clock is too far/);
});

test('session tokens are short-lived, are the credential actually used, and die on revocation',async()=>{
 stores.clear();
 const {deviceId,deviceToken}=await R.completePairing({code:(await R.beginPairing(A)).code,deviceName:'PC'});
 const {sessionToken,expiresAt}=await R.issueSession(A,deviceId);
 assert.ok(expiresAt-Date.now()<=R.SESSION_TTL_MS+1000);
 assert.equal((await R.verifySession(deviceId,sessionToken)).accountId,A);
 await assert.rejects(R.verifySession(deviceId,'not-the-session-token'),/rejected/);
 await assert.rejects(R.verifySession(deviceId,sessionToken,{now:expiresAt+1}),/expired/);
 await R.revokeDevice(A,deviceId);
 await assert.rejects(R.verifySession(deviceId,sessionToken),/not connected to Samvit/,'revocation kills live sessions');
});

// --------------------------------------------------------------------------
// Phases 5 + 7 — the queue and its leases
// --------------------------------------------------------------------------
test('actions are claimed under a lease, verified on report, and never double-executed',async()=>{
 stores.clear();
 const {deviceId}=await R.completePairing({code:(await R.beginPairing(A)).code,deviceName:'PC'});
 const action=await Q.enqueueAction(A,{deviceId,capability:'fs.write',args:{path:'C:\\Projects\\Samvit\\a.txt',content:'x'},expected:{kind:'present',path:'C:\\Projects\\Samvit\\a.txt'}});
 const claimed=await Q.claimActions(A,deviceId);
 assert.equal(claimed.length,1);
 assert.equal(claimed[0].status,'dispatched');
 assert.equal((await Q.claimActions(A,deviceId)).length,0,'a live lease cannot be claimed twice');
 // The report is verified against the expectation.
 const done=await Q.completeAction(A,deviceId,action.id,{observation:{exists:true}});
 assert.equal(done.verification.status,'verified');
 assert.equal(done.status,'completed');
 // A second report must not overwrite the first outcome.
 const again=await Q.completeAction(A,deviceId,action.id,{observation:{exists:false}});
 assert.equal(again.verification.status,'verified');
 await assert.rejects(Q.completeAction(A,'usr_00000000-0000-0000-0000-000000000002',action.id,{observation:{exists:true}}),/not queued for this computer/);
});

test('a promise the computer did not keep is recorded as unresolved, not success',async()=>{
 stores.clear();
 const {deviceId}=await R.completePairing({code:(await R.beginPairing(A)).code,deviceName:'PC'});
 const action=await Q.enqueueAction(A,{deviceId,capability:'fs.write',args:{path:'C:\\Projects\\Samvit\\a.txt',content:'x'},expected:{kind:'present',path:'C:\\Projects\\Samvit\\a.txt'}});
 await Q.claimActions(A,deviceId);
 const done=await Q.completeAction(A,deviceId,action.id,{observation:{exists:false}});
 assert.equal(done.verification.status,'unresolved');
 assert.equal(done.status,'completed','the action ran; verification is what failed');
 const failed=await Q.completeAction(A,deviceId,(await Q.enqueueAction(A,{deviceId,capability:'fs.read',args:{path:'C:\\Projects\\Samvit\\b.txt'}})).id,{error:'outside authorised folders'});
 assert.equal(failed.status,'failed');
 assert.equal(failed.verification.status,'unresolved');
});

test('an abandoned action is reclaimed after its lease expires, then expires for good',async()=>{
 stores.clear();
 const {deviceId}=await R.completePairing({code:(await R.beginPairing(A)).code,deviceName:'PC'});
 const action=await Q.enqueueAction(A,{deviceId,capability:'fs.read',args:{path:'C:\\Projects\\Samvit\\a.txt'}});
 const now=Date.now();
 assert.equal((await Q.claimActions(A,deviceId,{now})).length,1);
 const reclaimed=await Q.claimActions(A,deviceId,{now:now+Q.DEFAULT_LEASE_MS+1});
 assert.equal(reclaimed.length,1,'an expired lease is reclaimable');
 assert.equal(reclaimed[0].attempts,2);
 await Q.claimActions(A,deviceId,{now:now+Q.DEFAULT_LEASE_MS*3});
 const final=await Q.claimActions(A,deviceId,{now:now+Q.DEFAULT_LEASE_MS*6});
 assert.equal(final[0].status,'expired');
 assert.equal((await Q.claimActions(A,deviceId,{now:now+Q.DEFAULT_LEASE_MS*9})).length,0,'an expired action is never retried');
});

test('declining an action marks it denied and never dispatches it',async()=>{
 stores.clear();
 const {deviceId}=await R.completePairing({code:(await R.beginPairing(A)).code,deviceName:'PC'});
 const action=await Q.enqueueAction(A,{deviceId,capability:'dev.run',args:{executable:'npm',args:['run','build']},decision:{outcome:'ASK_USER'}});
 const denied=await Q.markActionDecision(A,action.id,{approved:false});
 assert.equal(denied.status,'denied');
 assert.equal((await Q.claimActions(A,deviceId)).length,0);
});

// --------------------------------------------------------------------------
// Phase 1/3 — the executor against a real filesystem
// --------------------------------------------------------------------------
// PLATFORM NOTE: these use createDeviceHost() — the NATIVE path end-to-end
// on Windows, and the POSIX bridge elsewhere, with the full containment
// pipeline (canonicalise → scope → realpath → re-check) exercised on both.
test('the executor performs real file operations inside an authorised folder',async t=>{
 const pc=await createDeviceHost();
 t.after(pc.cleanup);
 const ctx={scopes:[{path:pc.scopePath,mode:'write'}],approvedCommands:[],host:pc.host};
 const file=pc.winPath('note.txt');

 const write=await EX.executeAction({...ctx,capability:'fs.write',args:{path:file,content:'hello'}});
 assert.equal(write.observation.exists,true);
 const read=await EX.executeAction({...ctx,capability:'fs.read',args:{path:file}});
 assert.equal(read.result.content,'hello');
 const list=await EX.executeAction({...ctx,capability:'fs.list',args:{path:pc.scopePath}});
 assert.deepEqual(list.result.entries.map(e=>e.name),['note.txt']);
 await EX.executeAction({...ctx,capability:'fs.mkdir',args:{path:pc.winPath('sub')}});
 const copy=await EX.executeAction({...ctx,capability:'fs.copy',args:{from:file,to:pc.winPath('sub','copy.txt')}});
 assert.equal(copy.observation.exists,true);
 const move=await EX.executeAction({...ctx,capability:'fs.move',args:{from:pc.winPath('sub','copy.txt'),to:pc.winPath('moved.txt')}});
 assert.equal(move.observation.exists,true);assert.equal(move.observation.fromExists,false);
 const search=await EX.executeAction({...ctx,capability:'fs.search',args:{path:pc.scopePath,query:'hello'}});
 assert.equal(search.result.matches.length,2,'note.txt and the moved copy both contain the term');
 const del=await EX.executeAction({...ctx,capability:'fs.delete',args:{path:pc.winPath('moved.txt')}});
 assert.equal(del.observation.exists,false);
 assert.equal(await fs.stat(pc.hostPath(pc.winPath('moved.txt'))).then(()=>true).catch(()=>false),false);
});

test('the executor refuses anything outside the authorised folder, touching nothing',async t=>{
 const pc=await createDeviceHost();
 t.after(pc.cleanup);
 const ctx={scopes:[{path:pc.scopePath,mode:'write'}],approvedCommands:[],host:pc.host};
 const escape=pc.outsidePath('escape-attempt.txt');
 for(const args of [
  {path:escape},
  {path:`${pc.scopePath}\\..\\..\\Windows\\win.ini`},
  {path:'C:\\Windows\\System32\\drivers\\etc\\hosts'},
  {path:`${pc.scopePath}\\..\\sibling.txt`}
 ]) await assert.rejects(EX.executeAction({...ctx,capability:'fs.write',args:{...args,content:'x'}}),/authorised|traversal|Refused/);
 assert.equal(await fs.stat(pc.hostPath(escape)).then(()=>true).catch(()=>false),false,'nothing was written outside the scope');
 // A read-only scope refuses writes but allows reads.
 await EX.executeAction({...ctx,capability:'fs.write',args:{path:pc.winPath('ok.txt'),content:'ok'}});
 const readOnly={scopes:[{path:pc.scopePath,mode:'read'}],approvedCommands:[],host:pc.host};
 assert.equal((await EX.executeAction({...readOnly,capability:'fs.read',args:{path:pc.winPath('ok.txt')}})).result.content,'ok');
 await assert.rejects(EX.executeAction({...readOnly,capability:'fs.write',args:{path:pc.winPath('no.txt'),content:'x'}}),/reading only|Refused/);
});

test('a symlink or junction inside an authorised folder cannot be used to escape it',async t=>{
 const pc=await createDeviceHost();
 t.after(pc.cleanup);
 await fs.writeFile(pc.hostPath(pc.outsidePath('secret.txt')),'secret');
 const link=pc.winPath('link');
 try {
  await fs.symlink(pc.hostPath(pc.outsideRoot),pc.hostPath(link),'junction');
 } catch {
  t.skip('this environment does not permit creating junctions');
  return;
 }
 // The literal path is inside the scope, but it RESOLVES outside it.
 await assert.rejects(
  EX.executeAction({scopes:[{path:pc.scopePath,mode:'read'}],approvedCommands:[],host:pc.host,capability:'fs.read',args:{path:pc.winPath('link','secret.txt')}}),
  /outside the authorised folders/
 );
});

test('the executor runs only approved commands and never through a shell',async t=>{
 const pc=await createDeviceHost();
 t.after(pc.cleanup);
 const base={scopes:[{path:pc.scopePath,mode:'write'}],host:pc.host};
 await assert.rejects(EX.executeAction({...base,approvedCommands:[],capability:'dev.run',args:{executable:'node',args:['--version']}}),/not approved/);
 await assert.rejects(EX.executeAction({...base,approvedCommands:['node --version'],capability:'dev.run',args:{executable:'powershell',args:['-c','x']}}),/approved|permitted/);
 await assert.rejects(EX.executeAction({...base,approvedCommands:['node --version'],capability:'dev.run',args:{executable:'node',args:['-e','console.log(1)']}}),/may not be used with -e/);
 const run=await EX.executeAction({...base,approvedCommands:['node --version'],capability:'dev.run',args:{executable:'node',args:['--version'],cwd:pc.scopePath}});
 assert.equal(run.observation.exitCode,0);
 assert.match(run.result.stdout,/^v\d+/);
 assert.equal(run.result.command,'node --version');
});

test('the executor refuses an unknown capability and malformed arguments',async t=>{
 const pc=await createDeviceHost();
 t.after(pc.cleanup);
 const ctx={scopes:[{path:pc.scopePath,mode:'write'}],approvedCommands:[],host:pc.host};
 await assert.rejects(EX.executeAction({...ctx,capability:'fs.chmod',args:{path:pc.winPath('a')}}),/Unknown capability/);
 await assert.rejects(EX.executeAction({...ctx,capability:'fs.write',args:{path:pc.winPath('a')}}),/content is required/);
 await assert.rejects(EX.executeAction({...ctx,capability:'fs.read',args:{}}),/path is required/);
 await assert.rejects(EX.executeAction({...ctx,capability:'dev.run',args:{executable:'npm',args:[]}}),/not approved/);
 await assert.rejects(EX.executeAction({...ctx,host:{toHostPath:'not-a-function'},capability:'fs.read',args:{path:pc.winPath('a')}}),/invalid host bridge/);
});

// --------------------------------------------------------------------------
// Phase 12 — declared-but-unimplemented adapters
// --------------------------------------------------------------------------
test('browser, screen and application adapters are declared but refuse to execute',async()=>{
 const registry=AD.adapterRegistry();
 const kinds=registry.list().map(a=>a.kind).sort();
 assert.deepEqual(kinds,['application','browser','filesystem','screen']);
 assert.equal(registry.get('filesystem').available,true);
 for(const kind of ['browser','screen','application']){
  const adapter=registry.get(kind);
  assert.equal(adapter.available,false,kind);
  assert.ok(adapter.actions.length>0);
  assert.equal(adapter.requirements().implemented,false);
  await assert.rejects(registry.execute({adapter:kind,capability:'x'}),/not implemented/);
 }
 assert.throws(()=>AD.computerAction({capability:'x',adapter:'telepathy'}),/Unknown adapter/);
 assert.equal(AD.computerAction({capability:'fs.read',args:{}}).adapter,'filesystem');
});

// --------------------------------------------------------------------------
// Phase 6 + 15 — user decisions, stops, and the agent loop
// --------------------------------------------------------------------------
test('the emergency stop is consulted by the policy engine and fails closed when unreadable',async()=>{
 stores.clear();
 const scopes=[{path:'C:\\Projects\\Samvit',mode:'write'}];
 const read={capability:'fs.read',args:{path:'C:\\Projects\\Samvit\\a.txt'},device:{id:'d',revoked:false,scopes,approvedCommands:[]}};
 assert.equal((await P.authorizeLocalAction(A,read)).outcome,'ALLOW');
 await PERM.setGlobalStop({halted:true,reason:'operator stop'});
 assert.equal((await P.authorizeLocalAction(A,read)).outcome,'DENY');
 assert.equal((await P.authorizeLocalAction(A,read)).reason,'kill_switch');
 assert.equal((await P.authorizeLocalAction(A,{...read,capability:'fs.write',args:{path:'C:\\Projects\\Samvit\\a.txt',content:'x'}})).outcome,'DENY');
 await PERM.setGlobalStop({halted:false});
 assert.equal((await P.authorizeLocalAction(A,read)).outcome,'ALLOW');
 await assert.rejects(PERM.setGlobalStop({}),/boolean/);
 // An unreadable stop state is treated as ENGAGED, not as permission.
 stores.set('samvit-global-safety',createFailingStore());
 assert.equal((await PERM.readGlobalStop()).halted,true);
 assert.equal((await P.authorizeLocalAction(A,read)).reason,'kill_switch');
 stores.delete('samvit-global-safety');
});

test('the agent executes claimed work, reports observations, and stops taking work when halted',async()=>{
 const performed=[],reported=[];
 const transport={
  policy:{scopes:[{path:'C:\\Projects\\Samvit',mode:'write'}],approvedCommands:[]},
  async poll(){return {actions:[{id:'a1',capability:'fs.write',args:{path:'C:\\Projects\\Samvit\\a.txt'},expected:{kind:'present',path:'C:\\Projects\\Samvit\\a.txt'}}],halted:false};},
  async complete(id,payload){reported.push({id,...payload});}
 };
 const execute=async ({capability,args})=>{performed.push(capability);return {observation:{exists:true},result:{path:args.path}};};
 const summary=await AGENT.runOnce(transport,{execute});
 assert.equal(summary.executed,1);assert.equal(summary.refused,0);
 assert.deepEqual(performed,['fs.write']);
 assert.equal(reported[0].observation.exists,true);

 // A refusal is reported rather than swallowed.
 const refusing=await AGENT.runOnce({...transport,async poll(){return {actions:[{id:'a2',capability:'fs.delete',args:{}}],halted:false};},async complete(id,payload){reported.push({id,...payload});}},{execute:async()=>{throw Error('outside authorised folders');}});
 assert.equal(refusing.refused,1);
 assert.match(reported.at(-1).error,/outside authorised folders/);

 // Halted: the agent takes no new work at all.
 const halted=await AGENT.runOnce({...transport,async poll(){return {actions:[{id:'a3',capability:'fs.write',args:{}}],halted:true};}},{execute:async()=>assert.fail('must not execute while halted')});
 assert.equal(halted.halted,true);assert.equal(halted.executed,0);
});
