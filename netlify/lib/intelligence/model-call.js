import {streamMetered} from '../metered-provider.js';
import {pricedModel} from '../model-catalog.js';
import {reservationFor} from '../budget.js';
import {nativeCompletion} from './native.js';
import {candidates,candidateKey,observeModel} from './model-routing.js';
export async function callModel(ctx,{system,history,tools=[],capability='general',complexity='low',avoid=[]}){
 const serialized=JSON.stringify(history),definitions=JSON.stringify(tools);if(serialized.length+system.length+definitions.length>70000)throw Error('Mission context limit reached');
 let options=await candidates(ctx.accountId,ctx.env,{capability,complexity,contextBytes:Buffer.byteLength(serialized+system+definitions),exclude:avoid});options = options.filter(m => !m.orchestration); if(!options.length&&avoid.length)options=await candidates(ctx.accountId,ctx.env,{capability,complexity,contextBytes:Buffer.byteLength(serialized+system+definitions)});options = options.filter(m => !m.orchestration); if(!options.length)throw Error('No eligible model is connected');
 if(ctx.preferredTarget)options.sort((a,b)=>Number(b.target===ctx.preferredTarget)-Number(a.target===ctx.preferredTarget));
 let last;for(const m of options.slice(0,3)){
  await ctx.assertActive();ctx.signal.throwIfAborted();const key=await candidateKey(m,ctx.accountId,ctx.env),price=await pricedModel(m.provider,m.model,m,{apiKey:key});
  const billingParams={system:system+'\nTool schemas: '+definitions,messages:[{role:'user',content:serialized}],maxTokens:1536};
  const estimate=reservationFor(price,billingParams);await ctx.reserveCall(estimate.microUsd);const start=Date.now();let result,error;
  const transport=async function*(){try{result=await nativeCompletion(m.provider,key,{model:m.model,history,system,tools,maxTokens:1536,env:ctx.env,signal:ctx.signal});yield {done:true,usage:result.usage};}catch(e){error=e;yield {error:'Model request failed',reason:e.reason,retryable:e.retryable,rejected:e.rejected};}};
  for await(const chunk of streamMetered(m.provider,key,{...billingParams,accountId:ctx.accountId,env:ctx.env,signal:ctx.signal,model:m.model,modelInfo:price,transport})){if(chunk.error&&!error)error=Error(chunk.error);}
  await ctx.trace({kind:'model',provider:m.provider,model:m.model,latencyMs:Date.now()-start,estimatedMicroUsd:estimate.microUsd,usage:result?.usage||null,status:error?'failed':'completed',reason:error?.reason||null});
  await observeModel(ctx.accountId,m.target,{ok:!error,latencyMs:Date.now()-start,reason:error?.reason});
  if(!error&&result)return {...result,model:m.model,provider:m.provider,target:m.target};
  last=error||Error('No model result');if(!error?.retryable||error?.reason==='safety')throw last;
 }
 throw last||Error('Models unavailable');
}
