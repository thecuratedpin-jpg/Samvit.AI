import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {createFakeStore} from './helpers/fake-store.js';
import {iterateSSE} from '../shared/sse.js';
const stores=new Map();let outage=false;
mock.module('@netlify/blobs',{namedExports:{getStore(name){if(outage)throw Error('offline');if(!stores.has(name))stores.set(name,createFakeStore());return stores.get(name);}}});
const {default:chat}=await import('../netlify/edge-functions/chat.js');
const {default:status}=await import('../netlify/functions/status.mjs');
const {default:authHandler}=await import('../netlify/functions/auth.mjs');
const {default:memory}=await import('../netlify/functions/memory.mjs');
const {default:conversations}=await import('../netlify/functions/conversations.mjs');
const {default:checkout}=await import('../netlify/functions/billing-create-checkout.mjs');
const {default:workflow}=await import('../netlify/edge-functions/workflow.js');
const {default:council}=await import('../netlify/edge-functions/council.js');
const {signToken,DEFAULT_ACCOUNT_ID}=await import('../netlify/lib/security.js');
const request=(path,body,headers={})=>new Request(`http://localhost${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
const collect=async response=>{const events=[];for await(const {data}of iterateSSE(response))events.push(JSON.parse(data));return events;};
const event=obj=>`data: ${JSON.stringify(obj)}\n\n`;
function configure(t,extra={}){
 stores.clear();outage=false;
 const env={DEV_MODE:'true',NODE_ENV:'test',OPENAI_API_KEY:'test-key',SAMVIT_DEFAULT_PLAN_ID:'pro',...extra};
 for(const key of ['DEV_MODE','NODE_ENV','OPENAI_API_KEY','SAMVIT_DEFAULT_PLAN_ID','ACCESS_CODE','SESSION_SECRET','SAMVIT_BILLING_ENABLED','STRIPE_SECRET_KEY']){const previous=process.env[key];process.env[key]=env[key]||'';t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});}
 globalThis.Netlify={env:{get:key=>env[key]}};
 return env;
}
test('Real status handler loads and reports configuration without exposing keys',async t=>{configure(t);const response=await status(request('/api/status'));const result=await response.json();assert.equal(result.configuredCount,1);assert.equal(result.authenticated,true);assert.ok(!JSON.stringify(result).includes('test-key'));});
test('Real chat selects model, streams once, saves final usage, and settles budget',async t=>{
 configure(t);let calledModel;t.mock.method(globalThis,'fetch',async(url,options)=>{calledModel=JSON.parse(options.body).model;return new Response(event({choices:[{delta:{content:'Hello'}}]})+event({choices:[{finish_reason:'stop'}]})+event({choices:[],usage:{prompt_tokens:10,completion_tokens:5}})+'data: [DONE]\n\n');});
 const response=await chat(request('/api/chat',{provider:'auto',tier:'economy',messages:[{role:'user',content:'Hi'}]}),{ip:'127.0.0.1'});assert.equal(response.status,200);const events=await collect(response);assert.equal(calledModel,'gpt-5-mini');assert.equal(events.filter(e=>e.done).length,1);assert.equal(events.at(-1).usage.outputTokens,5);
 const budget=[...stores.get('samvit-budget')._data.values()].map(JSON.parse)[0];assert.equal(budget.inputTokens,10);assert.deepEqual(budget.reservations,{});
 const analytics=[...stores.get('samvit-analytics')._data.entries()].find(([key])=>key.startsWith('usage:'));assert.equal(JSON.parse(analytics[1]).byProvider.openai.calls,1);
});
test('Real chat refuses paid provider calls when rate-limit storage is unavailable',async t=>{configure(t);outage=true;let fetched=false;t.mock.method(globalThis,'fetch',async()=>{fetched=true;});const response=await chat(request('/api/chat',{messages:[{role:'user',content:'Hi'}]}),{});assert.equal(response.status,503);assert.equal(fetched,false);outage=false;});
test('Real chat enforces budget before calling provider',async t=>{configure(t,{SAMVIT_MONTHLY_BUDGET_USD:'0'});let fetched=false;t.mock.method(globalThis,'fetch',async()=>{fetched=true;});const events=await collect(await chat(request('/api/chat',{messages:[{role:'user',content:'Hi'}]}),{}));assert.ok(events.some(e=>e.error));assert.equal(fetched,false);});
test('Production without authentication fails closed',async t=>{configure(t,{DEV_MODE:'false',NODE_ENV:'production'});const response=await chat(request('/api/chat',{messages:[{role:'user',content:'Hi'}]}),{});assert.equal(response.status,500);});
test('Real memory starts empty and preserves text across create/read',async t=>{configure(t);const first=await memory(request('/api/memory'));assert.deepEqual((await first.json()).memories,[]);const response=await memory(request('/api/memory',{text:'Remember this <script> text',tags:['test']}));assert.equal(response.status,201);const list=await(await memory(request('/api/memory'))).json();assert.equal(list.memories[0].text,'Remember this <script> text');});
test('Real conversations reject invalid message types and persist valid chat',async t=>{configure(t);assert.equal((await conversations(request('/api/conversations',{messages:[{role:'system',content:{bad:true}}]}))).status,400);const response=await conversations(request('/api/conversations',{messages:[{role:'user',content:'Hi'}]}));assert.equal(response.status,201);const saved=await response.json();const list=await(await conversations(request('/api/conversations'))).json();assert.equal(list.conversations[0].id,saved.conversation.id);});
test('Real billing endpoint remains disabled even with shared login',async t=>{configure(t);assert.equal((await checkout(request('/api/billing/create-checkout',{priceId:'price_any'}))).status,501);});
test('Real auth works in explicit development without a backing audit store',async t=>{configure(t);outage=true;const response=await authHandler(request('/api/auth',{code:'unused'}));assert.equal(response.status,200);outage=false;});
test('Real workflow meters generated plans',async t=>{configure(t);t.mock.method(globalThis,'fetch',async()=>new Response(event({choices:[{delta:{content:JSON.stringify({title:'Project plan',summary:'A useful plan',steps:[{title:'Start',detail:'Write the goal',estimatedMinutes:10}]})}}]})+event({usage:{prompt_tokens:100,completion_tokens:100}})+'data: [DONE]\n\n'));const response=await workflow(request('/api/workflow',{goal:'Plan my project',provider:'openai',model:'gpt-5-mini'}),{});assert.equal(response.status,200);assert.equal((await response.json()).mission.title,'Project plan');assert.ok(stores.has('samvit-budget'));});
test('Real Council rejects a protected Free workspace before any model call',async t=>{const env=configure(t,{DEV_MODE:'false',ACCESS_CODE:'secret-code',SESSION_SECRET:'a-long-test-secret'.repeat(3),SAMVIT_DEFAULT_PLAN_ID:'free'});const id='usr_00000000-0000-0000-0000-000000000001';stores.set('samvit-accounts',createFakeStore());await stores.get('samvit-accounts').setJSON('account:'+id,{id,sessionVersion:1,emailVerified:true});const token=await signToken(env.SESSION_SECRET,{sub:id,version:1,exp:Date.now()+60000});const response=await council(request('/api/council',{providers:['openai','claude'],prompt:'Compare these options'},{cookie:`samvit_session=${token}`}),{});assert.equal(response.status,403);});
