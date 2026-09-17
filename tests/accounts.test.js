import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {createFakeStore} from './helpers/fake-store.js';
const stores=new Map(),store=n=>{if(!stores.has(n))stores.set(n,createFakeStore());return stores.get(n);};
mock.module('@netlify/blobs',{namedExports:{getStore:store}});
const {registerAccount,signInAccount,accountRole,emailKey,isAdminEmail,MAX_SIGNIN_FAILURES}=await import('../netlify/lib/accounts.js');
const {issueEmailToken,consumeEmailToken}=await import('../netlify/lib/email-channel.js');
const {signToken,requireSession}=await import('../netlify/lib/security.js');
const handlers={};for(const name of ['conversations','memory','projects','missions','analytics','connections','status'])handlers[name]=(await import('../netlify/functions/'+name+'.mjs')).default;
const secret='s'.repeat(48),env={get:k=>({SESSION_SECRET:secret,NODE_ENV:'production',ACCESS_CODE:'legacy-dev-toggle',SAMVIT_KEY_ENCRYPTION_SECRET:'e'.repeat(48),RESEND_API_KEY:'re_fixture',SAMVIT_EMAIL_FROM:'hello@example.test',SAMVIT_PUBLIC_ORIGIN:'https://samvit.test'})[k]};
const request=(path,token,body,method=body?'POST':'GET')=>new Request('https://samvit.test/api/'+path,{method,headers:{cookie:'samvit_session='+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
const tokenFor=a=>signToken(secret,{sub:a.id,version:1,exp:Date.now()+60000});
// Register openly, then mark the mailbox verified the way the email challenge
// would. NO invitation code is offered or needed at any point (V14 P1).
const registration=async(email,pw='correct horse battery staple')=>{const r=await registerAccount({email,password:pw},env);const a=await store('samvit-accounts').get('account:'+r.id,{type:'json'});await store('samvit-accounts').setJSON('account:'+a.id,{...a,emailVerified:true});return {...a,emailVerified:true,role:accountRole({...a,emailVerified:true},env)};};

test('V14: open registration — no invitation, no owner claim, no first-user ownership',async()=>{
 stores.clear();
 // No ACCESS_CODE-style code in the request at all — registration just works.
 const a=await registration('First@example.test');
 assert.equal(a.email,'first@example.test');
 assert.match(a.id,/^usr_/);
 // The FIRST verified account is an ordinary member. No meta.ownerAccountId
 // ever appears; the hidden bootstrap is gone, not relocated.
 assert.equal(accountRole(a,env),'member');
 assert.equal(await store('samvit-accounts').get('meta'),null);
 const b=await registration('second@example.test');
 assert.equal(accountRole(b,env),'member');
 assert.notEqual(a.id,b.id);
 const saved=await store('samvit-accounts').get('account:'+a.id,{type:'json'});
 assert.equal(saved.password.algorithm,'scrypt');assert.equal(saved.password.N,131072);
 assert.ok(!JSON.stringify(saved).includes('correct horse'));
 // An invitation-shaped field is inert: sending one changes nothing.
 const c=await registration('third@example.test');
 assert.equal((await store('samvit-accounts').get('account:'+c.id,{type:'json'})).admin,false);
 // Operator-configured admin: from env, never from a claim.
 assert.equal(isAdminEmail('ops@example.test',{get:k=>k==='SAMVIT_ADMIN_EMAILS'?'ops@example.test, two@example.test':undefined}),true);
 assert.equal(accountRole({...a,emailVerified:true,email:'ops@example.test'},{get:k=>k==='SAMVIT_ADMIN_EMAILS'?'ops@example.test':undefined}),'admin');
});

test('V14: duplicate email, wrong password, per-account lockout, forged and legacy sessions',async()=>{
 stores.clear();
 const a=await registration('Owner@example.test');
 assert.equal((await registration('OWNER@example.test')).id,a.id);
 await assert.rejects(signInAccount({email:a.email,password:'incorrect password'},env),/Email or password is incorrect/);
 await assert.rejects(signInAccount({email:'nobody@example.test',password:'incorrect password'},env),/Email or password is incorrect/);
 assert.equal((await signInAccount({email:a.email,password:'correct horse battery staple'},env)).id,a.id);
 // Forged / legacy sessions stay dead.
 const token=await tokenFor(a);
 assert.equal((await requireSession(request('status',token),env)).accountId,a.id);
 assert.equal((await requireSession(request('status',token+'x'),env)).status,401);
 assert.equal((await requireSession(request('status',await signToken(secret,{sub:'samvit-user',exp:Date.now()+60000})),env)).status,401);
 // Per-account brute-force lockout survives IP rotation: MAX_SIGNIN_FAILURES
 // bad passwords put the account itself on a timed hold.
 stores.clear();const b=await registration('brute@example.test');
 for(let i=0;i<MAX_SIGNIN_FAILURES;i++)await assert.rejects(signInAccount({email:b.email,password:'wrong guess '+i},env),/incorrect/);
 await assert.rejects(signInAccount({email:b.email,password:'correct horse battery staple'},env),/temporarily locked/);
});

test('V14: unverified accounts cannot sign in; verification activates, without a password step',async()=>{
 stores.clear();
 const r=await registerAccount({email:'pending@example.test',password:'correct horse battery staple'},env);
 await assert.rejects(signInAccount({email:'pending@example.test',password:'correct horse battery staple'},env),err=>{assert.equal(err.status,403);assert.equal(err.needsVerification,true);return /Verify your email/.test(err.message);});
 // The verify challenge burns single-use, sets no password, activates the account.
 const token=await issueEmailToken(r.id,'verify');
 const account=await consumeEmailToken(token,'verify',{});
 assert.equal(account.emailVerified,true);
 assert.equal((await store('samvit-accounts').get('account:'+r.id,{type:'json'})).emailChallenges && Object.keys((await store('samvit-accounts').get('account:'+r.id,{type:'json'})).emailChallenges).length,0);
 await assert.rejects(consumeEmailToken(token,'verify',{}),/expired/); // replay is dead
 // The free workspace allowance exists exactly once, provisioned at activation.
 assert.equal((await store('samvit-subscription').get('sub:'+r.id,{type:'json'})).planId,'free');
 assert.equal((await signInAccount({email:'pending@example.test',password:'correct horse battery staple'},env)).id,r.id);
});

test('V14: legacy single-tenant data is not adopted by anyone — the migration owner mechanism is gone',async()=>{
 stores.clear();
 await store('samvit-conversations').setJSON('convo:old',{id:'old',messages:[]});
 await store('samvit-subscription').setJSON('sub:samvit-user',{planId:'ultra',status:'active'});
 const a=await registration('first@example.test'),b=await registration('second@example.test');
 // Nothing was copied: register/finalize no longer runs migrateLegacy.
 assert.equal(await store('samvit-conversations').get('accounts/'+a.id+'/convo:old'),null);
 assert.equal(await store('samvit-conversations').get('accounts/'+b.id+'/convo:old'),null);
 assert.equal(await store('samvit-accounts').get('meta'),null);
});

test('every persisted-record endpoint scopes reads, updates, deletes and direct IDs to its signed-in user',async t=>{
 stores.clear();for(const k of ['SESSION_SECRET','NODE_ENV','ACCESS_CODE','SAMVIT_KEY_ENCRYPTION_SECRET']){const old=process.env[k];process.env[k]=env.get(k);t.after(()=>old===undefined?delete process.env[k]:process.env[k]=old);}
 const a=await registration('a@example.test'),b=await registration('b@example.test'),ta=await tokenFor(a),tb=await tokenFor(b);
 const specs=[['conversations',{messages:[{role:'user',content:'A private note'}]},'conversation','conversations'],['memory',{text:'A private memory'},'memory','memories'],['projects',{name:'Private project'},'project','projects'],['missions',{title:'Private mission',goal:'Private goal',steps:[{title:'First',detail:'Start'}]},'mission','missions']];
 for(const [name,body,singular,plural]of specs){const created=await handlers[name](request(name,ta,body));assert.equal(created.status,201,name+await created.clone().text());const item=(await created.json())[singular];assert.equal((await(await handlers[name](request(name+'?id='+item.id+'&accountId='+a.id,tb))).json())[plural]?.length??0,0);assert.equal((await handlers[name](request(name,tb,{id:item.id,title:'Intrusion',text:'Intrusion',name:'Intrusion'},'PUT'))).status,404,name);await handlers[name](request(name+'?id='+item.id,tb,null,'DELETE'));assert.equal((await(await handlers[name](request(name,ta))).json())[plural].length,1,name);}
 const created=await handlers.connections(request('connections',ta,{action:'save',provider:'openai',name:'Private',model:'gpt-5-mini',apiKey:'test-key-123456',input:1,output:5}));assert.equal(created.status,200,await created.clone().text());const ca=(await(await handlers.connections(request('connections',ta))).json()).connections[0];assert.equal((await(await handlers.connections(request('connections?accountId='+a.id,tb))).json()).connections.length,0);assert.equal((await handlers.connections(request('connections',tb,{action:'save',id:ca.id,provider:'openai',name:'Stolen',model:'gpt-5-mini',apiKey:'test-key-22222'}))).status,400);
 const usage=await(await handlers.analytics(request('analytics?accountId='+a.id,tb))).text();assert.ok(!usage.includes('Private'));const status=await(await handlers.status(request('status?accountId='+a.id,tb))).json();assert.equal(status.account.id,b.id);assert.equal(status.subscription.planId,'free');
});
