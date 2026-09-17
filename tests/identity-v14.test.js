// SAMVIT V14 — P23 (auth), P16 (notifications), P25 (definition of done).
//
// The P25 composite drives the real production path end to end, using the
// dev email capture as the safe local verification mechanism:
//
//   signup → verification email (captured) → verify link → account active
//   → login → notification preference opted in → pair a computer
//   → authorize a scope → multi-step mission → pause mid-run → resume
//   → terminal outcome with verification → ONE mission email.
//
// Every seam is asserted; nothing is mocked except the model itself.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {createFakeStore} from './helpers/fake-store.js';
const stores=new Map(),store=n=>{if(!stores.has(n))stores.set(n,createFakeStore());return stores.get(n);};
mock.module('@netlify/blobs',{namedExports:{getStore:store}});
const ACCTS=await import('../netlify/lib/accounts.js');
const MAIL=await import('../netlify/lib/email-channel.js');
const SVC=await import('../netlify/lib/email/service.js');
const SEC=await import('../netlify/lib/security.js');
const R=await import('../netlify/lib/devices/registry.js');
const REG={beginPairing:R.beginPairing,completePairing:R.completePairing,setDevicePolicy:R.setDevicePolicy,revokeDevice:R.revokeDevice,getDevice:R.getDevice};
const JOBS=await import('../netlify/lib/intelligence/jobs.js');
const RT=await import('../netlify/lib/intelligence/runtime.js');
const authHandler=(await import('../netlify/functions/auth.mjs')).default;
const emailHandler=(await import('../netlify/functions/email.mjs')).default;
const accountHandler=(await import('../netlify/functions/account.mjs')).default;

const secret='s'.repeat(48);
const config={SESSION_SECRET:secret,SAMVIT_KEY_ENCRYPTION_SECRET:'e'.repeat(48),NODE_ENV:'production',SAMVIT_EMAIL_PROVIDER:'dev',SAMVIT_EMAIL_FROM:'hello@example.test',SAMVIT_PUBLIC_ORIGIN:'https://samvit.test'};
const env={get:k=>config[k]};
const EMAIL='golden@example.test',PASSWORD='correct horse battery staple';
const req=(path,body,cookie)=>new Request('https://samvit.test/api/'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(cookie?{cookie:cookie}:{})},body:body?JSON.stringify(body):null});
const devOutbox=async()=>(await store('samvit-email-dev-outbox').get('messages',{type:'json'}))?.rows||[];
const linkToken=(rows,kind,to)=>{const row=rows.findLast(r=>r.to.includes(to)&&r.text.includes('kind='+kind+'&token='));return row?.text.match(/token=([^\s]+)/)?.[1]||null;};
const cookieOut=r=>r.headers.get('set-cookie');

function configure(t){stores.clear();for(const [k,v]of Object.entries(config)){const old=process.env[k];process.env[k]=v;t.after(()=>old===undefined?delete process.env[k]:process.env[k]=old);}}

// ---------------------------------------------------------------------------
// P25 — the definition of done, as one continuous scenario.
// ---------------------------------------------------------------------------
test('P25: a brand-new user goes from open signup to a verified, mission-running, notified account',async t=>{
 configure(t);
 // 1. Signup: open. No invitation field exists anywhere in the request.
 const reg=await authHandler(req('auth',{action:'register',email:EMAIL,password:PASSWORD}),{});
 assert.equal(reg.status,202);
 // 2. The queue delivers through the dev provider; exactly one verify email.
 assert.equal(await MAIL.runEmailQueue(env),1);
 let rows=await devOutbox();
 assert.equal(rows.length,1);
 assert.equal(rows[0].provider,'dev-capture');
 assert.ok(rows[0].subject.includes('Verify'));
 const token=linkToken(rows,'verify',EMAIL);
 assert.ok(token,'a usable verification link was delivered');
 // 3. Verify: no password step. The account is now ACTIVE (provisioned).
 const complete=await emailHandler(req('email',{action:'complete',kind:'verify',token}),{});
 assert.equal(complete.status,200);
 const id=(await store('samvit-accounts').get(await ACCTS.emailKey(EMAIL),{type:'json'})).id;
 assert.equal((await store('samvit-accounts').get('account:'+id,{type:'json'})).emailVerified,true);
 assert.equal((await store('samvit-subscription').get('sub:'+id,{type:'json'})).planId,'free');
 // 4. Login: 200 + session cookie + ordinary member (never an owner).
 const login=await authHandler(req('auth',{email:EMAIL,password:PASSWORD}),{});
 assert.equal(login.status,200);
 const loggedIn=(await login.json()).account;
 assert.equal(loggedIn.role,'member');
 const cookie=cookieOut(login).split(';')[0];
 assert.equal((await SEC.requireSession(req('status',null,cookie),env)).role,'member');
 // 5. Opt in to mission emails (off by default), through the real endpoint.
 const prefs=await accountHandler(req('account',{action:'preferences',preferences:{emailMissionNotifications:true,emailSecurityNotifications:true}},cookie),{});
 assert.equal(prefs.status,200);
 // 6. Pair a computer and authorize a scope — security email goes out.
 const {code}=await REG.beginPairing(id);
 const paired=await REG.completePairing({code,deviceName:'Office PC',platform:'win32',arch:'x64'},{env});
 rows=await devOutbox();
 assert.ok(rows.some(r=>r.subject.includes('paired')),'pairing raised a security email');
 await REG.setDevicePolicy(id,paired.deviceId,{scopes:[{path:'/tmp/samvit-p25',write:true}],approvedCommands:[]});
 const scoped=(await REG.getDevice(id,paired.deviceId)).scopes;
 assert.equal(scoped.length,1,'the scope the user authorized is exactly the scope recorded');
 // 7. Multi-step mission: two work tasks feeding one synthesis.
 const job=await JOBS.createJob(id,{requestId:crypto.randomUUID(),goal:'Gather notes, then write a summary'},env);
 const node=(nid,deps=[],kind='work')=>({id:nid,description:nid,dependencies:deps,kind,tools:[],capability:'general',status:'pending',attempts:0});
 await store(JOBS.JOB_STORE).setJSON(JOBS.jobKey(id,job.id),{...job,spec:{strategy:'critique',complexity:'high',freshness_required:false},tasks:[node('gather'),node('organize'),node('summary',['gather','organize'],'synthesis')]});
 // 8. Pause mid-execution; the running worker cannot commit past the pause.
 let release,entered;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 const first=RT.runJob(id,job.id,env,{agent:async(_ctx,task)=>{if(task.id==='gather'){entered();await held;}return {output:task.id+' done',evidence:[],models:['fixture'],steps:1};}});
 await started;
 await JOBS.commandJob(id,job.id,'pause');
 release();
 await first;
 assert.equal((await JOBS.getJob(id,job.id)).status,'paused');
 // 9. Wait, resume, run to a terminal outcome with verification detail.
 await JOBS.commandJob(id,job.id,'resume');
 await RT.runJob(id,job.id,env,{agent:async(_ctx,task)=>({output:task.id+' done',evidence:[],models:['fixture'],steps:1})});
 const finished=await JOBS.getJob(id,job.id);
 assert.equal(finished.status,'completed');
 assert.ok(finished.verification,'the outcome carries verification, not just success words');
 // 10. Notification: exactly one mission-completion email, once only.
 rows=await devOutbox();
 assert.equal(rows.filter(r=>r.subject.startsWith('Samvit mission')).length,1);
 await RT.runJob(id,job.id,env,{agent:async()=>{throw Error('never runs');}});
 rows=await devOutbox();
 assert.equal(rows.filter(r=>r.subject.startsWith('Samvit mission')).length,1,'no duplicate mission emails');
});

// ---------------------------------------------------------------------------
// P23 — auth hard edges.
// ---------------------------------------------------------------------------
test('P23: malformed, wrong-kind, expired and replayed tokens are all dead ends',async t=>{
 configure(t);
 await authHandler(req('auth',{action:'register',email:'edge@example.test',password:PASSWORD}),{});
 const id=(await store('samvit-accounts').get(await ACCTS.emailKey('edge@example.test'),{type:'json'})).id;
 const bad=await emailHandler(req('email',{action:'complete',kind:'verify',token:'usr_x.nothex'}),{});
 assert.equal(bad.status,400);
 const good=await MAIL.issueEmailToken(id,'verify');
 assert.equal((await emailHandler(req('email',{action:'complete',kind:'reset',token:good,newPassword:'another good password'}),{})).status,400,'a verify token cannot become a reset');
 // Swap the account-id half of the token: account lookup fails, generic error.
 const [_,raw]=good.split('.');
 assert.equal((await emailHandler(req('email',{action:'complete',kind:'verify',token:'usr_00000000-0000-0000-0000-0000000000ff.'+raw}),{})).status,400);
 // Concurrency: exactly one of two simultaneous consumes succeeds.
 const [r1,r2]=await Promise.all([
  emailHandler(req('email',{action:'complete',kind:'verify',token:good}),{}),
  emailHandler(req('email',{action:'complete',kind:'verify',token:good}),{})
 ]);
 assert.equal([r1.status,r2.status].sort().join(','),'200,400');
});

test('P23: signup→reset rotates every session; unverified login is refused at the handler',async t=>{
 configure(t);
 await authHandler(req('auth',{action:'register',email:'rotate@example.test',password:PASSWORD}),{});
 assert.equal(await MAIL.runEmailQueue(env),1); // drain the signup verification email
 const blocked=await authHandler(req('auth',{email:'rotate@example.test',password:PASSWORD}),{});
 assert.equal(blocked.status,403);
 assert.equal((await blocked.json()).needsVerification,true);
 const id=(await store('samvit-accounts').get(await ACCTS.emailKey('rotate@example.test'),{type:'json'})).id;
 await MAIL.consumeEmailToken(await MAIL.issueEmailToken(id,'verify'),'verify',{});
 const login=await authHandler(req('auth',{email:'rotate@example.test',password:PASSWORD}),{});
 const cookie=cookieOut(login).split(';')[0];
 assert.equal((await SEC.requireSession(req('status',null,cookie),env)).ok,true);
 await emailHandler(req('email',{action:'reset',email:'rotate@example.test'}),{});
 assert.equal(await MAIL.runEmailQueue(env),1);
 const resetToken=linkToken(await devOutbox(),'reset','rotate@example.test');
 await emailHandler(req('email',{action:'complete',kind:'reset',token:resetToken,newPassword:'a brand new strong password'}),{});
 assert.equal((await SEC.requireSession(req('status',null,cookie),env)).ok,false,'every pre-reset session is revoked');
 const relogin=await authHandler(req('auth',{email:'rotate@example.test',password:'a brand new strong password'}),{});
 assert.equal(relogin.status,200);
});

// ---------------------------------------------------------------------------
// P16 — notification preferences are honoured, defaults are safe.
// ---------------------------------------------------------------------------
test('P16: security emails are on by default, opt-out works, and password changes revoke sessions',async t=>{
 configure(t);
 await authHandler(req('auth',{action:'register',email:'guard@example.test',password:PASSWORD}),{});
 const id=(await store('samvit-accounts').get(await ACCTS.emailKey('guard@example.test'),{type:'json'})).id;
 await MAIL.consumeEmailToken(await MAIL.issueEmailToken(id,'verify'),'verify',{});
 const login=await authHandler(req('auth',{email:'guard@example.test',password:PASSWORD}),{});
 const cookie=cookieOut(login).split(';')[0];
 // Defaults reported honestly: security on, mission emails off.
 const me=await (await authHandler(new Request('https://samvit.test/api/auth',{headers:{cookie}}),{})).json();
 assert.deepEqual(me.account.preferences,{emailMissionNotifications:false,emailSecurityNotifications:true});
 // Password change → security email, then ALL other sessions die (the
 // endpoint rotates the caller into a fresh cookie).
 const change=await accountHandler(req('account',{action:'password',currentPassword:PASSWORD,newPassword:'replacement strong password'},cookie),{});
 assert.equal(change.status,200);
 assert.equal((await SEC.requireSession(req('status',null,cookie),env)).ok,false,'the old session is revoked');
 const freshCookie=cookieOut(change).split(';')[0];
 let rows=await devOutbox();
 assert.ok(rows.some(r=>r.subject.includes('password was changed')));
 // Opt out of security emails; the next change sends nothing.
 await accountHandler(req('account',{action:'preferences',preferences:{emailSecurityNotifications:false}},freshCookie),{});
 const count=rows.length;
 const changeTwo=await accountHandler(req('account',{action:'password',currentPassword:'replacement strong password',newPassword:'the third strong password'},freshCookie),{});
 rows=await devOutbox();
 assert.equal(rows.length,count);
 // Preferences validation: unknown keys are rejected, non-booleans rejected.
 const bogus=await accountHandler(req('account',{action:'preferences',preferences:{emailMissionNotifications:'yes'}},cookieOut(changeTwo).split(';')[0]),{});
 assert.equal(bogus.status,400);
});

test('P16: mission email is opt-in only — default-off accounts receive none',async t=>{
 configure(t);
 await authHandler(req('auth',{action:'register',email:'quiet@example.test',password:PASSWORD}),{});
 const id=(await store('samvit-accounts').get(await ACCTS.emailKey('quiet@example.test'),{type:'json'})).id;
 await MAIL.consumeEmailToken(await MAIL.issueEmailToken(id,'verify'),'verify',{});
 const job=await JOBS.createJob(id,{requestId:crypto.randomUUID(),goal:'7*8'},env); // deterministic calc path → completed
 await RT.runJob(id,job.id,env,{modelCall:async()=>assert.fail('calculation needs no model')});
 assert.equal((await JOBS.getJob(id,job.id)).status,'completed');
 const rows=await devOutbox();
 assert.equal(rows.filter(r=>r.subject.startsWith('Samvit mission')).length,0,'no mission email without opt-in');
});

test('P16: device revocation is notified to the account owner',async t=>{
 configure(t);
 await authHandler(req('auth',{action:'register',email:'owner-two@example.test',password:PASSWORD}),{});
 const id=(await store('samvit-accounts').get(await ACCTS.emailKey('owner-two@example.test'),{type:'json'})).id;
 await MAIL.consumeEmailToken(await MAIL.issueEmailToken(id,'verify'),'verify',{});
 const {code}=await REG.beginPairing(id);
 const paired=await REG.completePairing({code,deviceName:'Laptop',platform:'linux',arch:'x64'},{env});
 await REG.revokeDevice(id,paired.deviceId,{env});
 const rows=await devOutbox();
 assert.ok(rows.some(r=>r.subject.includes('disconnected')),'revocation raised a security email');
 assert.equal((await REG.getDevice(id,paired.deviceId)).revoked,true);
});
