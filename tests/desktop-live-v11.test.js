// SAMVIT V12 — LIVE end-to-end proof of the computer-execution pipeline.
//
// The other suites test components. This one boots a REAL HTTP server that
// serves the REAL /api/device-agent handler, points the REAL agent transport at
// it, and runs the REAL executor against a REAL temporary directory.
//
// If this passes, the whole path genuinely works:
//
//   pair over HTTP → session over HTTP → poll over HTTP
//   → agent executes on the filesystem → report over HTTP
//   → cloud verifies against the expected effect
//
// No part of the chain is simulated except the blob store, which stands in for
// Netlify Blobs.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFakeStore} from './helpers/fake-store.js';
const stores=new Map(),store=n=>{if(!stores.has(n))stores.set(n,createFakeStore());return stores.get(n);};
mock.module('@netlify/blobs',{namedExports:{getStore:store}});

const R=await import('../netlify/lib/devices/registry.js');
const Q=await import('../netlify/lib/devices/queue.js');
const deviceAgent=await import('../netlify/functions/device-agent.mjs');
const {createTransport}=await import('../agent/transport.js');
const {runOnce}=await import('../agent/main.js');
const EX=await import('../agent/executor.js');
const {createReceiptStore}=await import('../agent/receipts.js');
const A='usr_00000000-0000-0000-0000-000000000001';

/** Serve the real Netlify function over real HTTP. */
function startServer() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' ? undefined : body
    });
    try {
      const response = await deviceAgent.default(request, {});
      const text = await response.text();
      res.writeHead(response.status, {'content-type': 'application/json'});
      res.end(text);
    } catch (error) {
      res.writeHead(500, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: error.message}));
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const seedAccount = async () => {
  stores.clear();
  await store('samvit-accounts').setJSON('account:'+A,{id:A,emailVerified:true,sessionVersion:1});
  await store('samvit-subscription').setJSON('sub:'+A,{planId:'pro',status:'active'});
};

test('LIVE: a mission action travels cloud → agent → real filesystem → verified observation',async t=>{
 await seedAccount();
 const root=await fs.mkdtemp(join(tmpdir(),'samvit-live-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const server=await startServer();
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const cloudUrl=`http://127.0.0.1:${server.address().port}`;

 // 1. Pair a real device over HTTP using the real pairing flow.
 const {code}=await R.beginPairing(A);
 const pairing=await createTransport({cloudUrl,deviceId:null,deviceToken:null})
  .pair({code,deviceName:'Live Test PC',platform:process.platform,arch:process.arch});
 assert.match(pairing.deviceId,/^[0-9a-f-]{36}$/);
 assert.ok(pairing.deviceToken.length>=32);

 // 2. The user authorises exactly one folder.
 await R.setDevicePolicy(A,pairing.deviceId,{scopes:[{path:root,mode:'write'}],approvedCommands:[]});

 // 3. The cloud queues one structured action.
 const target=join(root,'live.txt');
 const queued=await Q.enqueueAction(A,{
  deviceId:pairing.deviceId,
  capability:'fs.write',
  args:{path:target,content:'written by the real agent'},
  expected:{kind:'present',path:target},
  missionId:'live-mission'
 });

 // 4. The REAL agent polls over HTTP, executes with the REAL executor, reports.
 const transport=createTransport({cloudUrl,deviceId:pairing.deviceId,deviceToken:pairing.deviceToken});
 const receipts=createReceiptStore(join(root,'receipts.json'));
 const summary=await runOnce(transport,{execute:EX.executeAction,receipts});
 assert.equal(summary.executed,1,`agent should have executed the action: ${JSON.stringify(summary)}`);
 assert.equal(summary.refused,0);

 // 5. The file genuinely exists on disk with the expected content.
 assert.equal(await fs.readFile(target,'utf8'),'written by the real agent');

 // 6. The cloud verified the observation against the promised effect.
 const record=await Q.readAction(A,queued.id);
 assert.equal(record.status,'completed');
 assert.equal(record.verification.status,'verified');
 assert.equal(record.observation.exists,true);
 assert.equal(record.report.bytes,25);

 // 7. The agent recorded a durable receipt for the state-changing action.
 assert.ok(receipts.get(queued.id));
});

test('LIVE: the agent refuses an out-of-scope path over the real wire and writes nothing',async t=>{
 await seedAccount();
 const root=await fs.mkdtemp(join(tmpdir(),'samvit-live2-'));
 const escape=join(tmpdir(),'samvit-live-escape.txt');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const server=await startServer();
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const cloudUrl=`http://127.0.0.1:${server.address().port}`;

 const {code}=await R.beginPairing(A);
 const pairing=await createTransport({cloudUrl,deviceId:null,deviceToken:null})
  .pair({code,deviceName:'Scoped PC',platform:process.platform,arch:process.arch});
 await R.setDevicePolicy(A,pairing.deviceId,{scopes:[{path:root,mode:'write'}],approvedCommands:[]});

 // The queue is asked for something outside the authorised folder. The cloud
 // policy would normally stop this first; the agent must ALSO refuse, because
 // a compromised or buggy cloud must not be able to widen what a PC will do.
 const queued=await Q.enqueueAction(A,{
  deviceId:pairing.deviceId,
  capability:'fs.write',
  args:{path:escape,content:'should never be written'},
  expected:{kind:'present',path:escape}
 });

 const transport=createTransport({cloudUrl,deviceId:pairing.deviceId,deviceToken:pairing.deviceToken});
 const summary=await runOnce(transport,{execute:EX.executeAction,receipts:null});
 assert.equal(summary.refused,1,'the agent must refuse it locally');
 assert.equal(await fs.stat(escape).then(()=>true).catch(()=>false),false,'nothing may be written outside the scope');
 const record=await Q.readAction(A,queued.id);
 assert.equal(record.status,'failed');
 assert.match(record.error,/authorised folders/);
 assert.equal(record.verification.status,'unresolved','a refused action is never verified');
});

test('LIVE: an unapproved command never runs, and an approved one reports its real exit code',async t=>{
 await seedAccount();
 const root=await fs.mkdtemp(join(tmpdir(),'samvit-live3-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const server=await startServer();
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const cloudUrl=`http://127.0.0.1:${server.address().port}`;

 const {code}=await R.beginPairing(A);
 const pairing=await createTransport({cloudUrl,deviceId:null,deviceToken:null})
  .pair({code,deviceName:'Runner PC',platform:process.platform,arch:process.arch});
 await R.setDevicePolicy(A,pairing.deviceId,{scopes:[{path:root,mode:'write'}],approvedCommands:['node --version']});
 const transport=createTransport({cloudUrl,deviceId:pairing.deviceId,deviceToken:pairing.deviceToken});

 const denied=await Q.enqueueAction(A,{deviceId:pairing.deviceId,capability:'dev.run',args:{executable:'npm',args:['run','build']},expected:{kind:'exit',code:0}});
 const allowed=await Q.enqueueAction(A,{deviceId:pairing.deviceId,capability:'dev.run',args:{executable:'node',args:['--version'],cwd:root},expected:{kind:'exit',code:0}});

 const summary=await runOnce(transport,{execute:EX.executeAction,receipts:null});
 assert.equal(summary.refused,1);assert.equal(summary.executed,1);

 const refused=await Q.readAction(A,denied.id);
 assert.equal(refused.status,'failed');
 assert.match(refused.error,/not approved/);
 const ran=await Q.readAction(A,allowed.id);
 assert.equal(ran.status,'completed');
 assert.equal(ran.verification.status,'verified');
 assert.match(ran.report.stdout,/^v\d+/, 'the real node version came back through the pipeline');
});
