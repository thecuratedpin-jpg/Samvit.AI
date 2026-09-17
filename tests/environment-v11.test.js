// SAMVIT V11 — environment verification tests (Phase 9 for computer actions).
// These exercise the real virtual filesystem and the real tool pipeline, so a
// passing run means file operations were genuinely observed and checked
// against what the actions promised — not that a mock agreed with itself.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {createFakeStore} from './helpers/fake-store.js';
const stores=new Map(),store=n=>{if(!stores.has(n))stores.set(n,createFakeStore());return stores.get(n);};
mock.module('@netlify/blobs',{namedExports:{getStore:store}});
const E=await import('../netlify/lib/intelligence/environment.js');
const V=await import('../netlify/lib/intelligence/vfs.js');
const P=await import('../netlify/lib/intelligence/permissions.js');
const {executeTool,COMPUTER_GRANTS}=await import('../netlify/lib/intelligence/tools.js');
const {analyzeAndPlan}=await import('../netlify/lib/intelligence/planning.js');
const {summarizeMission,completionNotification,reasoningSummary}=await import('../netlify/lib/intelligence/trace.js');
const A='usr_00000000-0000-0000-0000-000000000001',env={get:()=>undefined};

test('every environment-changing tool call yields a checkable effect, and read-only calls yield none',()=>{
 assert.deepEqual(E.effectFor({name:'fs_write',arguments:{path:'/a.txt'}}),{action:'write_file',kind:'present',path:'/a.txt',tool:'fs_write'});
 assert.deepEqual(E.effectFor({name:'fs_mkdir',arguments:{path:'/d'}}),{action:'create_folder',kind:'present',path:'/d',tool:'fs_mkdir'});
 assert.deepEqual(E.effectFor({name:'fs_delete',arguments:{path:'/a.txt'}}),{action:'delete_file',kind:'absent',path:'/a.txt',tool:'fs_delete'});
 assert.deepEqual(E.effectFor({name:'fs_copy',arguments:{from:'/a.txt',to:'/b.txt'}}),{action:'copy_file',kind:'present',path:'/b.txt',tool:'fs_copy'});
 assert.deepEqual(E.effectFor({name:'fs_move',arguments:{from:'/a.txt',to:'/b.txt'}}),{action:'move_file',kind:'moved',path:'/b.txt',from:'/a.txt',tool:'fs_move'});
 // Read-only tools promise nothing, so they can never be reported "missing".
 for(const name of ['fs_read','fs_list','fs_stat','fs_search','inspect_environment','web_search','calculate','memory_search'])assert.equal(E.effectFor({name,arguments:{path:'/a.txt'}}),null,name);
});

test('sandboxed terminal verbs map to effects, and unparseable or read-only commands map to none',()=>{
 assert.equal(E.effectFor({name:'terminal',arguments:{command:'write /a.txt hello'}}).action,'write_file');
 assert.equal(E.effectFor({name:'terminal',arguments:{command:'touch /a.txt'}}).kind,'present');
 assert.equal(E.effectFor({name:'terminal',arguments:{command:'mkdir /d'}}).action,'create_folder');
 assert.equal(E.effectFor({name:'terminal',arguments:{command:'rm /a.txt'}}).action,'delete_file');
 assert.equal(E.effectFor({name:'terminal',arguments:{command:'rm /a.txt'}}).kind,'absent');
 assert.deepEqual(E.effectFor({name:'terminal',arguments:{command:'mv /a.txt /b.txt'}}),{action:'move_file',kind:'moved',path:'/b.txt',from:'/a.txt',tool:'terminal'});
 assert.deepEqual(E.effectFor({name:'terminal',arguments:{command:'cp /a.txt /b.txt'}}),{action:'copy_file',kind:'present',path:'/b.txt',tool:'terminal'});
 for(const command of ['ls /','cat /a.txt','grep x /','pwd','help','tree /'])assert.equal(E.effectFor({name:'terminal',arguments:{command}}),null,command);
 // A traversal path cannot be an expectation — the tool will reject it anyway.
 assert.equal(E.effectFor({name:'terminal',arguments:{command:'rm ../escape'}}),null);
 assert.equal(E.effectFor({name:'terminal',arguments:{command:'rm /a | cat'}}),null);
});

test('effect derivation is defensive: malformed calls produce no expectation rather than a guess',()=>{
 assert.equal(E.effectFor(null),null);
 assert.equal(E.effectFor({}),null);
 assert.equal(E.effectFor({name:'fs_write'}),null);
 assert.equal(E.effectFor({name:'fs_write',arguments:{}}),null);
 assert.equal(E.effectFor({name:'fs_write',arguments:{path:''}}),null);
 assert.equal(E.effectFor({name:'fs_write',arguments:{path:123}}),null);
 assert.equal(E.effectFor({name:'fs_move',arguments:{from:'/a.txt'}}),null);
 assert.equal(E.effectFor({name:'terminal',arguments:{command:42}}),null);
 assert.equal(E.effectFor({name:'unknown_tool',arguments:{path:'/a'}}),null);
 assert.equal(E.effectsFor([{name:'fs_write',arguments:{path:'/a'}},{name:'fs_read',arguments:{path:'/b'}}]).length,1);
 assert.equal(E.effectsFor(Array.from({length:60},()=>({name:'fs_write',arguments:{path:'/a'}}))).length,40,'effect collection is bounded');
});

test('snapshot diffing classifies added, modified, removed and unchanged',()=>{
 const before={entries:{'/keep.txt':{type:'file',bytes:1,hash:'h1'},'/gone.txt':{type:'file',bytes:1,hash:'h2'},'/edit.txt':{type:'file',bytes:1,hash:'h3'}}};
 const after={entries:{'/keep.txt':{type:'file',bytes:1,hash:'h1'},'/edit.txt':{type:'file',bytes:9,hash:'h9'},'/new.txt':{type:'file',bytes:1,hash:'h4'}}};
 const diff=E.diffSnapshots(before,after);
 assert.deepEqual(diff.added,['/new.txt']);
 assert.deepEqual(diff.removed,['/gone.txt']);
 assert.deepEqual(diff.modified,['/edit.txt']);
 assert.equal(diff.unchanged,1);
 assert.equal(E.describeDiff(diff),'+1 added, ~1 modified, -1 removed');
 assert.deepEqual(E.diffSnapshots(undefined,undefined),{added:[],removed:[],modified:[],unchanged:0});
});

test('verification passes only when the promised change is actually present in real state',async()=>{
 stores.clear();
 const call={name:'fs_write',arguments:{path:'/note.txt',content:'hello'}};
 const before=await V.snapshot(A);
 const ctx={accountId:A,env,grants:[...COMPUTER_GRANTS],confirmed:[],signal:new AbortController().signal,assertActive:async()=>{},consumeTool:async()=>{},effectId:'e1',projectId:null,resourceIds:[]};
 await executeTool(call,ctx);
 const after=await V.snapshot(A);
 const report=E.verifyEnvironment({before,after,effects:[E.effectFor(call)]});
 assert.equal(report.status,'verified');
 assert.equal(report.checked,1);assert.equal(report.matched,1);
 assert.deepEqual(report.missing,[]);
 assert.deepEqual(report.unexpected,[],'the file we asked for is explained, so nothing is unexpected');
 assert.equal(report.independentlyProven,true,'a real-state check is independent of anything the model said');
 assert.equal(report.diff.added,1);
});

test('a promised change that never happened is reported unresolved, never as success',async()=>{
 stores.clear();
 const call={name:'fs_write',arguments:{path:'/never-written.txt',content:'x'}};
 const before=await V.snapshot(A);
 const after=await V.snapshot(A); // nothing was actually done
 const report=E.verifyEnvironment({before,after,effects:[E.effectFor(call)]});
 assert.equal(report.status,'unresolved');
 assert.equal(report.matched,0);
 assert.equal(report.missing.length,1);
 assert.equal(report.missing[0].path,'/never-written.txt');
 assert.match(report.missing[0].note,/not present/);
 assert.equal(report.independentlyProven,false);
});

test('deletion is verified by absence and moves by source-gone plus destination-present',async()=>{
 stores.clear();
 await V.writeFile(A,'/a.txt','content');
 const ctx={accountId:A,env,grants:[...COMPUTER_GRANTS,'delete_file'],confirmed:['delete_file'],signal:new AbortController().signal,assertActive:async()=>{},consumeTool:async()=>{},effectId:'e1',projectId:null,resourceIds:[]};

 const beforeDelete=await V.snapshot(A);
 await executeTool({name:'fs_delete',arguments:{path:'/a.txt'}},ctx);
 const deleteReport=E.verifyEnvironment({before:beforeDelete,after:await V.snapshot(A),effects:[E.effectFor({name:'fs_delete',arguments:{path:'/a.txt'}})]});
 assert.equal(deleteReport.status,'verified');

 await V.writeFile(A,'/src.txt','content');
 const beforeMove=await V.snapshot(A);
 await executeTool({name:'fs_move',arguments:{from:'/src.txt',to:'/dst.txt'}},ctx);
 const moveReport=E.verifyEnvironment({before:beforeMove,after:await V.snapshot(A),effects:[E.effectFor({name:'fs_move',arguments:{from:'/src.txt',to:'/dst.txt'}})]});
 assert.equal(moveReport.status,'verified');
 assert.equal(moveReport.observations[0].note,'moved as expected');

 // A move where the destination never appeared is unresolved.
 const broken=E.verifyEnvironment({before:beforeMove,after:beforeMove,effects:[E.effectFor({name:'fs_move',arguments:{from:'/src.txt',to:'/dst.txt'}})]});
 assert.equal(broken.status,'unresolved');
});

test('changes no action asked for are surfaced as unexpected rather than silently accepted',async()=>{
 stores.clear();
 const before=await V.snapshot(A);
 await V.writeFile(A,'/requested.txt','ok');
 await V.writeFile(A,'/surprise.txt','not requested');
 const report=E.verifyEnvironment({before,after:await V.snapshot(A),effects:[E.effectFor({name:'fs_write',arguments:{path:'/requested.txt'}})]});
 assert.equal(report.status,'verified','the requested change did happen');
 assert.deepEqual(report.unexpected,['/surprise.txt'],'but the unexplained change is still reported');
});

test('a task that touched nothing observable is not-applicable, not a failure',async()=>{
 stores.clear();
 const before=await V.snapshot(A);
 const report=E.verifyEnvironment({before,after:before,effects:[]});
 assert.equal(report.status,'not-applicable');
 assert.equal(report.checked,0);
 assert.equal(report.independentlyProven,false);
});

test('per-task environment reports merge into one honest mission-level verdict',()=>{
 assert.equal(E.mergeEnvironmentVerifications([]),null);
 assert.equal(E.mergeEnvironmentVerifications([{status:'not-applicable'}]),null);
 const ok=E.mergeEnvironmentVerifications([{status:'verified',checked:2,matched:2,missing:[],unexpected:[],diff:{added:2,removed:0,modified:0}}]);
 assert.equal(ok.status,'verified');assert.equal(ok.tasks,1);assert.equal(ok.checked,2);assert.equal(ok.independentlyProven,true);
 const mixed=E.mergeEnvironmentVerifications([{status:'verified',checked:1,matched:1,missing:[],unexpected:[],diff:{added:1,removed:0,modified:0}},{status:'unresolved',checked:1,matched:0,missing:[{path:'/x'}],unexpected:['/y'],diff:{added:1,removed:0,modified:0}}]);
 assert.equal(mixed.status,'unresolved');
 assert.equal(mixed.checked,2);assert.equal(mixed.matched,1);
 assert.equal(mixed.missing.length,1);assert.deepEqual(mixed.unexpected,['/y']);
 assert.equal(mixed.independentlyProven,false,'one unverified change makes the whole verdict unproven');
});

test('mission summaries and notifications carry environment verification without inflating the claim',()=>{
 const job={
  goal:'Organize the workspace',status:'completed',spec:{strategy:'single',complexity:'simple',success_criteria:['A summary file exists']},
  tasks:[{id:'a',kind:'work',status:'completed',attempts:1}],trace:[{kind:'model',model:'m1',status:'completed'}],
  verification:{status:'reviewed',reports:[],independentlyProven:false,environment:{status:'verified',checked:2,matched:2,missing:[],unexpected:[],independentlyProven:true}},
  modelCalls:1,toolCalls:2,spentMicroUsd:10
 };
 const summary=summarizeMission(job);
 assert.deepEqual(summary.plan.successCriteria,['A summary file exists']);
 assert.equal(summary.environment.status,'verified');
 assert.equal(summary.evidence.environmentIndependentlyProven,true);
 assert.equal(summary.evidence.independentlyProven,false,'file checks must not be rounded up into a general proof claim');
 const note=completionNotification(job);
 assert.equal(note.environment.checked,2);
 assert.match(note.honestCaveat,/File operations were verified against real state/);
 assert.match(note.honestCaveat,/not independently proven/);
 assert.match(reasoningSummary(job),/Environment: 2 change\(s\) checked against real state, 2 confirmed \(independently proven\)/);

 const unresolved=completionNotification({...job,status:'partial',verification:{...job.verification,environment:{status:'unresolved',checked:2,matched:1,missing:[{path:'/x'}],unexpected:[],independentlyProven:false}}});
 assert.ok(unresolved.warnings.some(w=>/promised file change\(s\) were not observed/.test(w)));
 assert.equal(unresolved.environment.independentlyProven,false);
});

test('success criteria are normalised onto the mission spec and reach the planner',async()=>{
 const spec={intent:'action',complexity:'moderate',freshness_required:false,needs_tools:false,needs_verification:false,verification_level:'none',risk:'low',output_type:'answer',strategy:'single'};
 const plan={tasks:[{id:'a',phase:'p',sub_mission:'s',description:'Do it',dependencies:[],kind:'work',capability:'general',tools:[]}]};
 const prompts=[];
 const complete=async system=>{prompts.push(system);return JSON.stringify(system.includes('Classify the user task')?{...spec,success_criteria:['A file exists','Tests pass']}:plan);};
 const {spec:out}=await analyzeAndPlan('Organize the workspace files',{complete,toolNames:[],limits:{maxTasks:8,maxParallel:2}});
 assert.deepEqual(out.success_criteria,['A file exists','Tests pass']);
 assert.match(prompts.at(-1),/success criteria are: A file exists; Tests pass/);

 // Absent, oversized and malformed criteria all normalise to a bounded clean list.
 const absent=await analyzeAndPlan('Organize the workspace files',{complete:async s=>JSON.stringify(s.includes('Classify')?spec:plan),toolNames:[],limits:{maxTasks:8,maxParallel:2}});
 assert.deepEqual(absent.spec.success_criteria,[]);
 const messy=await analyzeAndPlan('Organize the workspace files',{complete:async s=>JSON.stringify(s.includes('Classify')?{...spec,success_criteria:['ok','','   ',null,7,'two','three','four','five']}:plan),toolNames:[],limits:{maxTasks:8,maxParallel:2}});
 assert.deepEqual(messy.spec.success_criteria,['ok','two','three','four','five'],'a malformed advisory field is filtered and capped, never fatal');
 // A non-array, or a model that omits the field entirely, must still produce a valid mission.
 for(const value of [undefined,'not an array',42,{},null]){
  const coerced=await analyzeAndPlan('Organize the workspace files',{complete:async s=>JSON.stringify(s.includes('Classify')?{...spec,success_criteria:value}:plan),toolNames:[],limits:{maxTasks:8,maxParallel:2}});
  assert.deepEqual(coerced.spec.success_criteria,[],String(value));
 }
});
