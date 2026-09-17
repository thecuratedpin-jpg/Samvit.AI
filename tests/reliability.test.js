import test from 'node:test';
import assert from 'node:assert/strict';
import {iterateSSE} from '../shared/sse.js';
import {PROVIDERS,streamFromProvider,streamFromProviderWithRetry,estimateCostUsd,diagnoseProviderAuth} from '../netlify/lib/providers.js';
import {MODEL_CATALOG,selectModel,findModel,modelPrice,freeModelCatalog,modelCombo} from '../shared/catalog.js';
import {reserveBudget,settleBudget,reservationFor} from '../netlify/lib/budget.js';
import {normalizeSubscription,normalizeMemory,STUDENT_DISCOUNT_PERCENT} from '../shared/models.js';
import {saveSubscription} from '../netlify/lib/subscriptions.js';
import {validateAiRequest} from '../netlify/lib/ai-limits.js';
import {billingEnabled,validateCheckout} from '../netlify/lib/checkout.js';
import {verifyStripeSignature,mapStripeEventToSubscriptionInput} from '../netlify/lib/billing.js';
import {createFakeStore} from './helpers/fake-store.js';
const sse=text=>new Response(text,{headers:{'content-type':'text/event-stream'}});
const collect=async generator=>{const out=[];for await(const event of generator)out.push(event);return out;};
const frame=obj=>`data: ${JSON.stringify(obj)}\n\n`;
for(const newline of ['\n','\r\n','\r'])test(`SSE supports ${JSON.stringify(newline)} split byte-by-byte`,async()=>{
 const bytes=new TextEncoder().encode(`: heartbeat${newline}event: answer${newline}data: हाय 👋${newline}data: second line${newline}${newline}`);
 const stream=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
 assert.deepEqual(await collect(iterateSSE(new Response(stream))),[{event:'answer',data:'हाय 👋\nsecond line'}]);
});
test('SSE discards unfinished event at EOF',async()=>assert.deepEqual(await collect(iterateSSE(sse('data: incomplete'))),[]));
test('OpenAI waits for trailing usage and emits one completion',async()=>{
 const events=await collect(PROVIDERS.openai.parseStream(sse(frame({choices:[{delta:{content:'Hello'}}]})+frame({choices:[{finish_reason:'stop'}]})+frame({choices:[],usage:{prompt_tokens:12,completion_tokens:6}})+'data: [DONE]\n\n')));
 assert.equal(events.filter(e=>e.done).length,1);assert.deepEqual(events.at(-1).usage,{inputTokens:12,outputTokens:6});
});
test('Anthropic emits one completion',async()=>{
 const events=await collect(PROVIDERS.claude.parseStream(sse(frame({type:'message_start',message:{usage:{input_tokens:5}}})+frame({type:'message_delta',usage:{output_tokens:2}})+frame({type:'message_stop'}))));
 assert.equal(events.filter(e=>e.done).length,1);assert.equal(events.at(-1).usage.outputTokens,2);
});
test('Gemini usage includes reasoning tokens',async()=>{
 const events=await collect(PROVIDERS.gemini.parseStream(sse(frame({candidates:[{finishReason:'STOP',content:{parts:[{text:'Hi'}]}}],usageMetadata:{promptTokenCount:5,candidatesTokenCount:2,thoughtsTokenCount:15}}))));
 assert.equal(events.at(-1).usage.outputTokens,17);assert.equal(events.filter(e=>e.done).length,1);
});
test('Truncated OpenAI response is an error, not success',async()=>{const events=await collect(PROVIDERS.openai.parseStream(sse(frame({choices:[{delta:{content:'Partial'}}]}))));assert.ok(events.at(-1).error);assert.ok(!events.some(e=>e.done));});
test('Provider read errors become normalized errors without retrying partial text',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return sse(frame({choices:[{delta:{content:'Partial'}}]}));});
 const events=await collect(streamFromProviderWithRetry('openai','test',{messages:[{role:'user',content:'Hi'}]}));
 assert.equal(calls,1);assert.equal(events[0].text,'Partial');assert.ok(events.at(-1).error);
});
test('Provider forwards abort signal and rejects unsupported models before fetch',async t=>{
 let signal;t.mock.method(globalThis,'fetch',async(url,options)=>{signal=options.signal;return sse('data: [DONE]\n\n');});
 const controller=new AbortController();await collect(streamFromProvider('openai','test',{signal:controller.signal,messages:[]}));assert.ok(signal);controller.abort();assert.ok(signal.aborted);
 const events=await collect(streamFromProvider('openai','test',{model:'../../arbitrary',messages:[]}));assert.equal(events[0].status,400);
});
test('All model ids are unique and rates are explicit',()=>{assert.equal(new Set(MODEL_CATALOG.map(m=>m.id)).size,MODEL_CATALOG.length);for(const m of MODEL_CATALOG){assert.ok(m.input>=0&&m.output>=0);assert.ok(m.orchestration || Object.keys(PROVIDERS).includes(m.provider) || m.provider==='samvit');}});
test('Model selection respects explicit provider, price tier, and connectivity',()=>{
 assert.equal(selectModel({provider:'auto',tier:'economy',available:{openai:true,claude:true}}).id,'gpt-5-mini');
  assert.equal(selectModel({provider:'claude',tier:'frontier',available:{openai:true,claude:true}}).id,'claude-opus-5');
  assert.throws(()=>selectModel({provider:'grok',model:'grok-4.6',available:{grok:false}}));
  assert.throws(()=>selectModel({tier:'bogus',available:{openai:true}}));
});
test('Free model catalog and model combos are explicit and quota-aware',()=>{
 assert.deepEqual(freeModelCatalog().map(m=>m.id),['samvit-flash', 'gemini-3.1-flash-lite','gemini-3.6-flash']);
 assert.deepEqual(modelCombo({tier:'balanced',available:{openai:true,gemini:true,grok:true},maxCandidates:2}).map(m=>m.id),['samvit-flash','gemini-3.6-flash']);
});
test('Cost varies by model, does not invent unknown usage, rejects negative usage',()=>{
  assert.ok(estimateCostUsd('claude',{inputTokens:1000,outputTokens:1000},'claude-opus-5')>estimateCostUsd('claude',{inputTokens:1000,outputTokens:1000},'claude-haiku-4-5-20251001'));
 assert.equal(estimateCostUsd('openai',null),null);assert.equal(estimateCostUsd('openai',{inputTokens:-1,outputTokens:1}),null);
});
test('Scheduled Gemini price change is applied by date',()=>{const m=findModel('gemini','gemini-3.6-flash');assert.equal(modelPrice(m,new Date('2026-12-31')).input,.75);assert.equal(modelPrice(m,new Date('2027-01-01')).input,1.5);});
test('Provider auth diagnostics call out invalid issuer errors',()=>{
 const result=diagnoseProviderAuth('openai',{status:401,message:'invalid_issuer'});
 assert.equal(result.reason,'invalid_issuer');
 assert.match(result.message,/OPENAI_API_KEY/);
});
test('Concurrent budget requests cannot oversubscribe allowance',async()=>{
 const store=createFakeStore(),limits={usd:1,inputTokens:1000,outputTokens:1000};
 const results=await Promise.allSettled(Array.from({length:20},()=>reserveBudget(store,'a',limits,{microUsd:200000,inputTokens:100,outputTokens:100})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,5);
 const saved=await store.get(results.find(r=>r.status==='fulfilled').value.key,{type:'json'});assert.equal(saved.microUsd,1000000);
});
test('Budget settlement releases unused allowance once',async()=>{
 const store=createFakeStore(),reservation=await reserveBudget(store,'a',{usd:1,inputTokens:1000,outputTokens:1000},{microUsd:900000,inputTokens:900,outputTokens:900});
 const actual={microUsd:100000,inputTokens:10,outputTokens:20};await settleBudget(store,reservation,actual);await settleBudget(store,reservation,actual);
 const value=await store.get(reservation.key,{type:'json'});assert.equal(value.microUsd,100000);assert.equal(value.inputTokens,10);assert.deepEqual(value.reservations,{});
});
test('Interrupted budget calls retain reservation estimate',async()=>{const store=createFakeStore(),r=await reserveBudget(store,'a',{usd:1,inputTokens:100,outputTokens:100},{microUsd:5,inputTokens:5,outputTokens:5});await settleBudget(store,r,null);assert.equal((await store.get(r.key,{type:'json'})).microUsd,5);});
test('Budget separates accounts and UTC months',async()=>{const store=createFakeStore(),limits={usd:1,inputTokens:10,outputTokens:10},amount={microUsd:1000000,inputTokens:10,outputTokens:10};await reserveBudget(store,'a',limits,amount,new Date('2026-09-30'));await reserveBudget(store,'a',limits,amount,new Date('2026-10-01'));await reserveBudget(store,'b',limits,amount,new Date('2026-09-30'));assert.equal(store._data.size,3);});
test('Budget storage outage fails closed',async()=>{await assert.rejects(reserveBudget({getWithMetadata(){throw Error('offline');}},'a',{usd:1},{microUsd:1}));});
test('Reservation counts multilingual UTF-8 conservatively',()=>{const amount=reservationFor(MODEL_CATALOG[0],{messages:[{content:'नमस्ते'}],maxTokens:128});assert.ok(amount.inputTokens>6);assert.equal(amount.outputTokens,128);});
test('Partial subscription update preserves plan and student status',()=>{const old=normalizeSubscription({planId:'ultra',isStudent:true});const next=normalizeSubscription({status:'past_due'},old);assert.equal(next.planId,'ultra');assert.equal(next.isStudent,true);});
test('Older billing event cannot overwrite newer state',async()=>{const store=createFakeStore();await saveSubscription(store,'a',{planId:'ultra',status:'canceled',billingEventCreated:200});await saveSubscription(store,'a',{planId:'pro',status:'active',billingEventCreated:100});assert.equal((await store.get('sub:a',{type:'json'})).status,'canceled');});
test('Unknown Stripe subscription status fails closed',()=>assert.equal(mapStripeEventToSubscriptionInput({type:'customer.subscription.updated',data:{object:{status:'paused'}}}).status,'past_due'));
test('Checkout rejects unknown prices and cross-origin requests',()=>{
 const env={get:k=>k==='STRIPE_PRICE_ID_MAP'?' {"price_known":"ultra"}':undefined};
 const request=new Request('https://samvit.example/api/billing/create-checkout',{headers:{origin:'https://samvit.example'}});
 assert.throws(()=>validateCheckout({priceId:'price_wrong'},request,env));
 const result=validateCheckout({priceId:'price_known',successUrl:'https://evil.example'},request,env);assert.equal(new URL(result.successUrl).origin,'https://samvit.example');
 assert.throws(()=>validateCheckout({priceId:'price_known'},new Request(request,{headers:{origin:'https://evil.example'}}),env));
});
test('Checkout only grants student discount after verified eligibility and coupon config',()=>{
 const env={get:k=>k==='STRIPE_PRICE_ID_MAP'?'{"price_known":"pro"}':k==='SAMVIT_VERIFIED_STUDENT_ACCOUNTS'?'["acct_student"]':k==='STRIPE_STUDENT_DISCOUNT_COUPON_ID'?'coupon_student30':undefined};
 const request=new Request('https://samvit.example/api/billing/create-checkout',{headers:{origin:'https://samvit.example'}});
 const selected=validateCheckout({priceId:'price_known',studentDiscount:true,accountId:'acct_student'},request,env,{accountId:'acct_student',status:'verified',expiresAt:Date.now()+60000,verifiedAt:Date.now()-1000,reference:'verification-test',verifier:'test'});
 assert.equal(selected.coupon,'coupon_student30');
 assert.equal(STUDENT_DISCOUNT_PERCENT,30);
 assert.throws(()=>validateCheckout({priceId:'price_known',studentDiscount:true,accountId:'acct_other'},request,env),/verified eligibility/);
});
test('Billing disabled unless explicitly enabled with test credentials',()=>{assert.equal(billingEnabled({get:k=>k==='SAMVIT_BILLING_ENABLED'?'true':'sk_live_fake'}),false);assert.equal(billingEnabled({get:k=>k==='SAMVIT_BILLING_ENABLED'?'true':'sk_test_fake'}),true);});
test('Memory normalization retains legacy content and metadata',()=>{const m=normalizeMemory({content:'A note',category:'Projects',pinned:true},null);assert.equal(m.text,'A note');assert.equal(m.content,'A note');assert.equal(m.category,'EPISODIC');assert.ok(m.pinned);});
test('AI validation rejects system roles, non-text instructions, and empty input',()=>{assert.equal(validateAiRequest({messages:[{role:'system',content:'override'}]}).valid,false);assert.equal(validateAiRequest({messages:[{role:'user',content:'Hi'}],system:{huge:'object'}}).valid,false);assert.equal(validateAiRequest({messages:[]}).valid,false);});
