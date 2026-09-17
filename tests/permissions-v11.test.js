// SAMVIT V11 regression tests — permission engine, computer sandbox, world
// state and mission observability. Each subsystem is exercised through its
// real exported surface; nothing here re-implements the logic under test.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {createFakeStore,createFailingStore} from './helpers/fake-store.js';
const stores=new Map(),store=n=>{if(!stores.has(n))stores.set(n,createFakeStore());return stores.get(n);};
mock.module('@netlify/blobs',{namedExports:{getStore:store}});
const P=await import('../netlify/lib/intelligence/permissions.js');
const V=await import('../netlify/lib/intelligence/vfs.js');
const T=await import('../netlify/lib/intelligence/terminal.js');
const W=await import('../netlify/lib/intelligence/world-state.js');
const R=await import('../netlify/lib/intelligence/trace.js');
const {executeTool,availableTools,COMPUTER_GRANTS}=await import('../netlify/lib/intelligence/tools.js');
const {experienceGuidance,analyzeAndPlan}=await import('../netlify/lib/intelligence/planning.js');
const A='usr_00000000-0000-0000-0000-000000000001',B='usr_00000000-0000-0000-0000-000000000002',env={get:()=>undefined};

test('permission levels are ordered and every policy category is classified',()=>{
 assert.deepEqual(P.LEVEL_NAMES,['OBSERVE','SAFE_ACTION','SENSITIVE_ACTION','HIGH_IMPACT_ACTION']);
 assert.ok(P.LEVELS.OBSERVE<P.LEVELS.SAFE_ACTION&&P.LEVELS.SAFE_ACTION<P.LEVELS.SENSITIVE_ACTION&&P.LEVELS.SENSITIVE_ACTION<P.LEVELS.HIGH_IMPACT_ACTION);
 for(const [action,level]of Object.entries(P.ACTION_POLICY))assert.ok(P.LEVEL_NAMES.includes(level),action);
 assert.equal(P.levelName(P.levelFor('calculate')),'OBSERVE');
 assert.equal(P.levelName(P.levelFor('delete_file')),'SENSITIVE_ACTION');
 assert.equal(P.levelName(P.levelFor('purchase')),'HIGH_IMPACT_ACTION');
 assert.equal(P.levelName(P.levelFor('unlisted_action','low')),'SAFE_ACTION');
 assert.equal(P.levelName(P.levelFor('unlisted_action')),'SENSITIVE_ACTION','unknown and undeclared must default to the stricter level');
});

test('decideAction gates on grant, kill switch and confirmation, and a declaration can only raise a level',()=>{
 assert.equal(P.decideAction({action:'read_file',grants:['read_file']}).allowed,true);
 assert.equal(P.decideAction({action:'read_file',grants:[]}).reason,'not_granted');
 assert.equal(P.decideAction({action:'write_file',grants:['write_file'],halted:true}).reason,'kill_switch');
 assert.equal(P.decideAction({action:'read_file',grants:['read_file'],halted:true}).allowed,true,'observation must survive the kill switch');
 assert.equal(P.decideAction({action:'delete_file',grants:['delete_file']}).reason,'confirmation_required');
 assert.equal(P.decideAction({action:'delete_file',grants:['delete_file'],confirmed:['delete_file']}).allowed,true);
 assert.equal(P.decideAction({action:'create_document',risk:'low',grants:['create_document'],declaredConfirmation:true}).levelName,'SENSITIVE_ACTION');
 assert.throws(()=>P.decideAction({action:''}));
 assert.throws(()=>P.decideAction({action:'x',grants:'nope'}));
 assert.match(P.describeDecision(P.decideAction({action:'write_file',grants:['write_file'],halted:true})),/kill switch/);
});

test('kill switch persists per account, is isolated between accounts, and every decision is audited',async()=>{
 stores.clear();
 assert.equal((await P.readSafety(A)).halted,false);
 await P.setKillSwitch(A,{halted:true,reason:'operator stop'});
 assert.equal((await P.readSafety(A)).halted,true);
 assert.equal((await P.readSafety(B)).halted,false,'safety state must not leak between accounts');
 const denied=await P.authorizeAction(A,{action:'write_file',risk:'low',grants:['write_file']});
 assert.equal(denied.allowed,false);assert.equal(denied.reason,'kill_switch');
 const audit=await P.readAudit(A);
 assert.equal(audit.at(-1).action,'write_file');assert.equal(audit.at(-1).outcome,'denied');assert.equal(audit.at(-1).levelName,'SAFE_ACTION');
 await P.setKillSwitch(A,{halted:false});
 assert.equal((await P.authorizeAction(A,{action:'write_file',risk:'low',grants:['write_file']})).allowed,true);
 await assert.rejects(P.setKillSwitch(A,{}),/boolean/);
});

test('an unreadable safety state denies state-changing actions instead of failing open',async()=>{
 stores.clear();
 stores.set('samvit-safety',createFailingStore());
 const denied=await P.authorizeAction(A,{action:'write_file',risk:'low',grants:['write_file']});
 assert.equal(denied.allowed,false);assert.equal(denied.reason,'safety_unavailable');
 assert.equal((await P.authorizeAction(A,{action:'read_file',risk:'low',grants:['read_file']})).allowed,true,'observation stays available during a storage outage');
 stores.delete('samvit-safety');
});

test('virtual filesystem rejects traversal, host paths and control characters',()=>{
 for(const bad of ['../../etc/passwd','/a/../../b','a\\b','a\u0000b','a\u001fb'])assert.throws(()=>V.splitPath(bad),undefined,String(bad));
 assert.throws(()=>V.splitPath('x'.repeat(V.VFS_LIMITS.maxSegmentLength+1)));
 assert.throws(()=>V.splitPath(Array.from({length:V.VFS_LIMITS.maxDepth+2},()=>'d').join('/')));
 assert.equal(V.normalizePath('/a/./b/'),'/a/b');
 assert.equal(V.normalizePath(''),'/');
 assert.equal(V.resolvePath('/work','notes.txt'),'/work/notes.txt');
 assert.equal(V.resolvePath('/work','/abs'),'/abs');
 assert.throws(()=>V.resolvePath('/work','./deep/../deep/x'),/traversal/,'every ".." is rejected, including one that would normalise away');
 assert.throws(()=>V.resolvePath('/work','../escape'));
});

test('sandbox filesystem performs real operations, isolates accounts and enforces quotas',async()=>{
 stores.clear();
 await V.makeDir(A,'/work');
 await V.makeDir(A,'/work');
 await V.writeFile(A,'/work/notes.txt','hello world');
 assert.equal((await V.readFile(A,'/work/notes.txt')).content,'hello world');
 assert.deepEqual((await V.listDir(A,'/work')).entries.map(e=>e.name),['notes.txt']);
 await V.copyEntry(A,'/work/notes.txt','/work/copy.txt');
 await V.moveEntry(A,'/work/copy.txt','/work/moved.txt');
 assert.deepEqual((await V.listDir(A,'/work')).entries.map(e=>e.name),['moved.txt','notes.txt']);
 assert.equal((await V.statEntry(A,'/work/moved.txt')).type,'file');
 assert.equal((await V.searchFiles(A,'world')).matches[0].path,'/work/notes.txt');
 assert.equal((await V.walk(A,'/')).length,3);
 assert.equal((await V.usage(A)).files,2);
 assert.equal((await V.listDir(B,'/')).entries.length,0,'another account must not see this workspace');
 assert.equal(await store('samvit-vfs').get('tree'),null,'the tree is stored per account, not globally');
 await V.deleteEntry(A,'/work');
 assert.equal((await V.listDir(A,'/')).entries.length,0);
 await assert.rejects(V.writeFile(A,'/work/nope.txt','x'),/Directory not found/);
 await assert.rejects(V.writeFile(A,'/big.txt','x'.repeat(V.VFS_LIMITS.maxFileBytes+1)),/exceeds/);
 await assert.rejects(V.deleteEntry(A,'/'),/root/);
 await assert.rejects(V.moveEntry(A,'/','/x'),/root/);
 await assert.rejects(V.moveEntry(A,'/missing','/x'),/Not found/);
 await assert.rejects(V.readFile(A,'/work'),/Not found/);
});

test('sandboxed terminal runs allow-listed commands and exposes no shell surface',async()=>{
 stores.clear();
 const allow=action=>P.decideAction({action,grants:['run_command','list_files','read_file','search_files','inspect_environment','write_file','create_folder','copy_file','move_file'],confirmed:[]});
 await T.runCommand(A,'mkdir /work',{authorize:allow});
 assert.equal((await T.runCommand(A,'write /work/a.txt hello there',{authorize:allow})).exitCode,0);
 assert.match((await T.runCommand(A,'cat /work/a.txt',{authorize:allow})).output,/hello there/);
 assert.match((await T.runCommand(A,'ls /work',{authorize:allow})).output,/a\.txt/);
 assert.match((await T.runCommand(A,'grep hello /work',{authorize:allow})).output,/a\.txt/);
 assert.match((await T.runCommand(A,'wc /work/a.txt',{authorize:allow})).output,/bytes/);
 assert.match((await T.runCommand(A,'head /work/a.txt 1',{authorize:allow})).output,/hello there/);
 assert.match((await T.runCommand(A,'tree /work',{authorize:allow})).output,/\/work\/a\.txt/);
 assert.match((await T.runCommand(A,'pwd',{authorize:allow})).output,/^\//);
 assert.match((await T.runCommand(A,'help',{authorize:allow})).output,/rm/);
 for(const line of ['cat /a | grep x','ls > out.txt','rm /a && ls','echo $(whoami)','ls /a*','cat `id`','ls /a; ls /b','cat /a < in.txt','echo ${HOME}'])assert.throws(()=>T.parseCommand(line),undefined,line);
 assert.throws(()=>T.parseCommand('sudo rm -rf /'),/Unknown command/);
 assert.throws(()=>T.parseCommand('cat'),/Usage/);
 assert.throws(()=>T.parseCommand(''),/Enter a command/);
 assert.throws(()=>T.parseCommand('cat "unterminated'),/Unterminated quote/);
 assert.throws(()=>T.parseCommand('ls '+'x'.repeat(600)),/exceeds/);
 await assert.rejects(T.runCommand(A,'rm /work/a.txt',{authorize:allow}),/Command denied/,'deletion is refused without explicit confirmation');
 const confirm=action=>P.decideAction({action,grants:['run_command','delete_file'],confirmed:['delete_file']});
 assert.equal((await T.runCommand(A,'rm /work/a.txt',{authorize:confirm})).exitCode,0);
 assert.equal((await T.runCommand(A,'cat /missing.txt',{authorize:allow})).exitCode,1,'a command-level failure is a non-zero exit, not a crash');
 await assert.rejects(T.runCommand(A,'ls /'),/denied/,'the default authorization grants nothing');
 assert.equal(T.parseCommand('mv /a /b').action,'move_file');
 assert.equal(T.parseCommand('rm /a').action,'delete_file');
});

test('computer tools are gated by the permission engine and by the kill switch',async()=>{
 stores.clear();
 const base={accountId:A,env,grants:[...COMPUTER_GRANTS],confirmed:[],signal:new AbortController().signal,assertActive:async()=>{},consumeTool:async()=>{},effectId:'e1',projectId:null,resourceIds:[]};
 assert.equal(JSON.parse((await executeTool({name:'fs_write',arguments:{path:'/note.txt',content:'hi'}},base)).text).path,'/note.txt');
 assert.match(JSON.parse((await executeTool({name:'terminal',arguments:{command:'cat /note.txt'}},base)).text).output,/hi/);
 assert.equal(JSON.parse((await executeTool({name:'inspect_environment',arguments:{}},base)).text).sandbox,true);
 await assert.rejects(executeTool({name:'fs_delete',arguments:{path:'/note.txt'}},base),/permission/,'the safe grant set excludes deletion');
 const destructive={...base,grants:[...COMPUTER_GRANTS,'delete_file'],confirmed:['delete_file']};
 assert.equal(JSON.parse((await executeTool({name:'fs_delete',arguments:{path:'/note.txt'}},destructive)).text).removedFiles,1);
 await P.setKillSwitch(A,{halted:true});
 await assert.rejects(executeTool({name:'fs_write',arguments:{path:'/x.txt',content:'x'}},base),/permission/);
 assert.equal(JSON.parse((await executeTool({name:'fs_list',arguments:{path:'/'}},base)).text).path,'/','inspection still works under the kill switch');
 await P.setKillSwitch(A,{halted:false});
});

test('tool surface exposes permission levels and withholds computer tools until granted',()=>{
 assert.deepEqual(availableTools(env,[]).map(t=>t.name),[]);
 const full=availableTools(env,['calculate',...COMPUTER_GRANTS]);
 assert.equal(full.find(t=>t.name==='terminal').levelName,'SAFE_ACTION');
 assert.equal(full.find(t=>t.name==='fs_read').levelName,'OBSERVE');
 assert.equal(full.find(t=>t.name==='fs_delete'),undefined,'deletion needs its own grant');
 assert.equal(full.find(t=>t.name==='create_document'),undefined);
 assert.equal(availableTools(env,[...COMPUTER_GRANTS,'delete_file']).find(t=>t.name==='fs_delete').levelName,'SENSITIVE_ACTION');
});

test('mission creation grants computer access least-privilege and pre-confirms deletion only when asked',async()=>{
 stores.clear();
 for(const id of [A,B]){await store('samvit-accounts').setJSON('account:'+id,{id,emailVerified:true,sessionVersion:1});await store('samvit-subscription').setJSON('sub:'+id,{planId:'pro',status:'active'});}
 const {createJob}=await import('../netlify/lib/intelligence/jobs.js');
 const safe=await createJob(A,{requestId:crypto.randomUUID(),goal:'Organize the workspace files',allowComputer:true},env);
 assert.ok(safe.grants.includes('run_command')&&safe.grants.includes('write_file')&&safe.grants.includes('read_file'));
 assert.ok(!safe.grants.includes('delete_file'));
 assert.deepEqual(safe.confirmed,[]);
 const destructive=await createJob(A,{requestId:crypto.randomUUID(),goal:'Clean up the workspace files',allowComputer:true,allowDelete:true},env);
 assert.ok(destructive.grants.includes('delete_file'));
 assert.deepEqual(destructive.confirmed,['delete_file']);
 const plain=await createJob(A,{requestId:crypto.randomUUID(),goal:'Explain how gravity works'},env);
 assert.ok(!plain.grants.includes('run_command')&&!plain.grants.includes('write_file'));
 assert.deepEqual(plain.confirmed,[]);
});

test('experience aggregates outcomes by signature instead of storing every run blindly',()=>{
 let doc={rows:[]};
 for(let i=0;i<4;i++)doc=W.mergeExperience(doc,{capability:'coding',complexity:'complex',strategy:'specialist_delegation',outcome:'success',score:1,model:'model:x'});
 doc=W.mergeExperience(doc,{capability:'coding',complexity:'complex',strategy:'specialist_delegation',outcome:'failure',score:0,model:'model:y'});
 assert.equal(doc.rows.length,1,'identical signatures collapse into one row');
 assert.equal(doc.rows[0].attempts,5);assert.equal(doc.rows[0].successes,4);assert.equal(doc.rows[0].failures,1);
 assert.equal(doc.rows[0].models['model:x'],4,'only the model that carried a success is credited');
 assert.equal(doc.rows[0].models['model:y'],0);
 const hints=W.planningHints(doc.rows,{capability:'coding',complexity:'complex'});
 assert.equal(hints.strategies[0].strategy,'specialist_delegation');
 assert.equal(hints.preferredModel,'model:x');
 assert.equal(hints.evidence,'learned-from-experience');
 const thin=W.mergeExperience({rows:[]},{capability:'coding',complexity:'complex',strategy:'single',outcome:'failure'});
 assert.equal(W.planningHints(thin.rows,{capability:'coding',complexity:'complex'}).avoidStrategies.length,0,'one bad run is noise, not a verdict');
 let big={rows:[]};
 for(let i=0;i<W.EXPERIENCE_LIMIT+30;i++)big=W.mergeExperience(big,{capability:'general',complexity:'simple',strategy:'s'+i,outcome:'success'});
 assert.ok(big.rows.length<=W.EXPERIENCE_LIMIT,'experience is bounded');
});

test('durable facts are corrected in place and world state separates constraints from experience',async()=>{
 stores.clear();
 await W.rememberFact(A,{kind:'constraint',key:'no-publish',value:'Never publish without approval'});
 await W.rememberFact(A,{kind:'constraint',key:'no-publish',value:'Never publish or email without approval'});
 const facts=await W.readFacts(A,{kind:'constraint'});
 assert.equal(facts.length,1,'a corrected fact replaces the old one rather than duplicating it');
 assert.match(facts[0].value,/or email/);
 assert.equal((await W.readFacts(B)).length,0,'facts are account scoped');
 await assert.rejects(W.rememberFact(A,{kind:'nonsense',key:'x',value:'y'}),/Unknown fact kind/);
 await assert.rejects(W.rememberFact(A,{kind:'goal',key:'',value:'y'}),/needs a key/);
 await W.recordExperience(A,{capability:'research',complexity:'moderate',strategy:'consensus',outcome:'success',model:'m1'});
 await W.recordExperience(A,{capability:'research',complexity:'moderate',strategy:'consensus',outcome:'success',model:'m1'});
 const world=await W.worldState(A,{capability:'research',complexity:'moderate'});
 assert.equal(world.constraints.length,1);
 assert.equal(world.experience.length,1);
 assert.equal(world.hints.preferredModel,'m1');
 assert.equal(world.facts.filter(f=>f.kind==='constraint').length,1);
});

test('learned experience reaches the planner as advisory evidence, and is absent when there is no history',async()=>{
 assert.equal(experienceGuidance(null),'');
 assert.equal(experienceGuidance({strategies:[],avoidStrategies:[],evidence:'no-comparable-history'}),'');
 const guidance=experienceGuidance({strategies:[{strategy:'critique',successRate:0.8,attempts:5}],avoidStrategies:[{strategy:'debate',successRate:0.2,attempts:4}]});
 assert.match(guidance,/critique succeeded 80% of 5 attempt\(s\)/);
 assert.match(guidance,/debate succeeded only 20% of 4 attempt\(s\)/);
 assert.match(guidance,/evidence, not instruction/);
 // The guidance must reach the planning prompt without changing the schema contract.
 const prompts=[];
 const spec={intent:'analyze',complexity:'complex',freshness_required:false,needs_tools:false,needs_verification:true,verification_level:'standard',risk:'low',output_type:'report',strategy:'critique'};
 const plan={tasks:[{id:'research',phase:'work',sub_mission:'study',description:'Study it',dependencies:[],kind:'work',capability:'general',tools:[]},{id:'check',phase:'verify',sub_mission:'review',description:'Check it',dependencies:['research'],kind:'verify',capability:'reasoning',tools:[]},{id:'final',phase:'synthesis',sub_mission:'deliver',description:'Deliver it',dependencies:['check'],kind:'synthesis',capability:'writing',tools:[]}]};
 const complete=async(system,goal)=>{prompts.push(system);return JSON.stringify(system.includes('Classify the user task')?spec:plan);};
 await analyzeAndPlan('Compare alternative engineering designs',{complete,toolNames:[],limits:{maxTasks:8,maxParallel:2},hints:{strategies:[{strategy:'critique',successRate:0.8,attempts:5}],avoidStrategies:[]}});
 assert.match(prompts.at(-1),/critique succeeded 80%/);
 assert.match(prompts.at(-1),/Do not invent tools or actions/);
 // Omitting hints entirely is still valid (no comparable history) and adds no guidance text.
 prompts.length=0;
 await analyzeAndPlan('Compare alternative engineering designs',{complete,toolNames:[],limits:{maxTasks:8,maxParallel:1}});
 assert.equal(/Observed outcomes/.test(prompts.at(-1)),false);
});

test('a task naming a computer tool is actually offered it, even though its grant is an action category',async()=>{
 stores.clear();
 const {runAgent}=await import('../netlify/lib/intelligence/agent.js');
 const ctx={accountId:A,env,grants:[...COMPUTER_GRANTS],confirmed:[],resourceIds:[],projectId:null,goal:'Write a note file',jobId:crypto.randomUUID(),limits:{maxAgentSteps:3},signal:new AbortController().signal,assertActive:async()=>{},consumeTool:async()=>{},reserveCall:async()=>{},trace:async()=>{}};
 const task={id:'t1',description:'Write /note.txt',dependencies:[],kind:'work',capability:'general',tools:['fs_write']};
 let offered=null;
 const out=await runAgent(ctx,task,{},{modelCall:async(_c,args)=>{offered=args.tools.map(t=>t.name);return {content:'done',calls:[],target:'fixture'};}});
 assert.ok(offered.includes('fs_write'),'a task that names fs_write must be offered it; got '+JSON.stringify(offered));
 assert.equal(out.output,'done');
 // The pre-existing tools still behave identically (name === grant).
 let legacy=null;
 await runAgent({...ctx,grants:['calculate']},{...task,tools:['calculate']},{},{modelCall:async(_c,args)=>{legacy=args.tools.map(t=>t.name);return {content:'x',calls:[],target:'fixture'};}});
 assert.deepEqual(legacy,['calculate']);
 // Without the grant the tool is still withheld.
 let ungranted=null;
 await runAgent({...ctx,grants:['calculate']},task,{},{modelCall:async(_c,args)=>{ungranted=args.tools.map(t=>t.name);return {content:'x',calls:[],target:'fixture'};}});
 assert.deepEqual(ungranted,[],'a task cannot reach a tool the mission was not granted');
});

test('mission trace never exposes hidden reasoning and reports verification honestly',()=>{
 const entry=R.traceEntry({kind:'model',model:'m',reasoning:'secret chain of thought',chain_of_thought:'x',thinking:'y',nested:{thought:'hidden',keep:'ok'}});
 assert.equal(JSON.stringify(entry).includes('secret'),false);
 assert.equal(JSON.stringify(entry).includes('hidden'),false);
 assert.equal(entry.kind,'model');
 assert.equal(R.scrub({a:1,thinking:'x',b:{cot:'y',keep:2}}).b.cot,undefined);
 assert.equal(R.scrub({a:1,thinking:'x',b:{cot:'y',keep:2}}).b.keep,2);
 assert.equal(R.traceEntry({kind:'not_a_kind'}).kind,'action');
 assert.equal(R.appendTrace([],{kind:'tool',tool:'web_search'}).length,1);
 assert.equal(R.appendTrace(Array.from({length:R.TRACE_LIMIT+20},()=>({kind:'action'})),{kind:'action'}).length,R.TRACE_LIMIT);
 const job={goal:'Ship a report',status:'partial',spec:{strategy:'critique',complexity:'complex',phases:['research']},tasks:[{id:'a',kind:'work',status:'completed',attempts:1},{id:'b',kind:'verify',status:'failed',error:'no evidence'}],trace:[{kind:'model',model:'m1',status:'completed'},{kind:'tool',tool:'web_search',status:'completed'},{kind:'retry',status:'retry',reason:'invalid_or_unavailable_plan'}],verification:{status:'unresolved',reports:[]},modelCalls:3,toolCalls:2,spentMicroUsd:1500,replans:1};
 const summary=R.summarizeMission(job);
 assert.equal(summary.progress.completed,1);assert.equal(summary.progress.failed,1);
 assert.deepEqual(summary.models,['m1']);assert.deepEqual(summary.tools,['web_search']);
 assert.equal(summary.evidence.independentlyProven,false);
 assert.equal(summary.budget.spentUsd,0.0015);
 assert.ok(summary.warnings.length>=2);
 assert.equal(summary.retries.length,1);
 const note=R.completionNotification(job);
 assert.equal(note.headline,'Mission finished with unresolved work');
 assert.equal(note.verified,false);
 assert.match(note.honestCaveat,/not independently proven/);
 assert.match(R.reasoningSummary(job),/Verification: unresolved/);
 assert.equal(R.completionNotification({status:'completed',tasks:[],trace:[],verification:{status:'reviewed',independentlyProven:true}}).honestCaveat,null);
 assert.equal(R.completionNotification({status:'completed',tasks:[],trace:[],verification:{status:'reviewed',independentlyProven:true}}).headline,'Mission completed');
});
