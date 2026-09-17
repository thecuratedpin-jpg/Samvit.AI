import {getStore} from '@netlify/blobs';
import {getSubscription,isSubscriptionServiceUnavailable} from '../subscriptions.js';
import {reserveBudget,settleBudget} from '../budget.js';
export function embeddingReady(env){return Boolean(env.get('OPENAI_API_KEY'))&&env.get('SAMVIT_SEMANTIC_MEMORY')==='true'&&Number.isFinite(Number(env.get('SAMVIT_EMBEDDING_USD_PER_MILLION')))&&Number(env.get('SAMVIT_EMBEDDING_USD_PER_MILLION'))>0;}
export async function embedTexts(texts,ctx,{fetcher=fetch}={}){
 if(!embeddingReady(ctx.env)||!Array.isArray(texts)||!texts.length||texts.length>101||texts.some(t=>typeof t!=='string'||!t.trim()||Buffer.byteLength(t)>12000))throw Error('Semantic memory not configured or input too large');
 await ctx.assertActive();const rate=Number(ctx.env.get('SAMVIT_EMBEDDING_USD_PER_MILLION')),inputTokens=texts.reduce((n,t)=>n+Buffer.byteLength(t)+16,0),amount={inputTokens,outputTokens:0,microUsd:Math.ceil(inputTokens*rate)};
 await ctx.reserveCall(amount.microUsd);const sub=await getSubscription(getStore('samvit-subscription'),ctx.accountId,ctx.env);if(isSubscriptionServiceUnavailable(sub)||sub.status!=='active')throw Error('Subscription unavailable');
 const planUsd=sub.planId==='free'?.10:sub.limits.monthlySpendUsd,override=ctx.env.get('SAMVIT_MONTHLY_BUDGET_USD'),usd=override?Math.min(planUsd,Number(override)):planUsd;if(!Number.isFinite(usd)||usd<0)throw Error('Invalid allowance');
 const store=getStore('samvit-budget'),reservation=await reserveBudget(store,ctx.accountId,{usd,inputTokens:sub.limits.monthlyInputTokens,outputTokens:sub.limits.monthlyOutputTokens},amount);let actual=null;
 try{
  const response=await fetcher('https://api.openai.com/v1/embeddings',{method:'POST',headers:{authorization:'Bearer '+ctx.env.get('OPENAI_API_KEY'),'content-type':'application/json'},body:JSON.stringify({model:'text-embedding-3-small',input:texts,dimensions:256,encoding_format:'float'}),redirect:'error',signal:ctx.signal});
  if(!response.ok){if(response.status>=400&&response.status<500)actual={inputTokens:0,outputTokens:0,microUsd:0};throw Error('Embedding provider unavailable');}
  const data=await response.json();if(!Array.isArray(data.data)||data.data.length!==texts.length)throw Error('Invalid embedding response');
  const sorted=data.data.sort((a,b)=>a.index-b.index),vectors=sorted.map((d,i)=>{if(d.index!==i||!Array.isArray(d.embedding)||d.embedding.length!==256||d.embedding.some(n=>!Number.isFinite(n)))throw Error('Invalid vector');return d.embedding;});
  if(Number.isSafeInteger(data.usage?.total_tokens)&&data.usage.total_tokens>=0)actual={inputTokens:data.usage.total_tokens,outputTokens:0,microUsd:Math.ceil(data.usage.total_tokens*rate)};
  await ctx.trace({kind:'embedding',model:'text-embedding-3-small',items:texts.length,status:'completed',estimatedMicroUsd:amount.microUsd});return vectors;
 }finally{await settleBudget(store,reservation,actual);}
}
