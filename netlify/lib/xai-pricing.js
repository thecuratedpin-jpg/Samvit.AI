import {priceFreshness} from '../../shared/pricing-policy.js';
const cache=new Map(),source='https://api.x.ai/v1/language-models';
export function parseXaiPrices(data,now=Date.now()){
 if(!Array.isArray(data?.models))throw Error('Invalid xAI price catalog');
 return data.models.flatMap(m=>{
  if(!m?.input_modalities?.includes('text')||!m.output_modalities?.includes('text')||typeof m.id!=='string')return [];
  const fields=['prompt_text_token_price','completion_text_token_price'];
  if(fields.some(k=>!Number.isSafeInteger(m[k])||m[k]<=0))return [];
  const long=fields.map(k=>Object.hasOwn(m,k+'_long_context')?m[k+'_long_context']:0);if(long.some(v=>!Number.isSafeInteger(v)||v<0))return [];
  if(m.long_context_threshold>0&&fields.some(k=>m[k+'_long_context']===undefined))return [];
  const known=new Set([...fields,...fields.map(k=>k+'_long_context'),'cached_prompt_text_token_price','cached_prompt_text_token_price_long_context','prompt_image_token_price','prompt_image_token_price_long_context','search_price']);
  const cached=['cached_prompt_text_token_price','cached_prompt_text_token_price_long_context'].map(k=>Object.hasOwn(m,k)?m[k]:0);if(cached.some(v=>!Number.isSafeInteger(v)||v<0))return [];
  if(Object.keys(m).some(k=>/_price(?:_|$)/.test(k)&&!known.has(k)&&m[k]!==0))return [];
  // API units: USD cents per 100 million tokens. Divide by 10,000 for USD per million.
  // Reserve the larger standard/long-context rate; text-only calls never enable search tools.
  return [{provider:'grok',id:m.id,label:m.id,input:Math.max(m.prompt_text_token_price,long[0],...cached)/10000,output:Math.max(m.completion_text_token_price,long[1])/10000,pricing:priceFreshness({kind:'live',source,checkedAt:now,note:'Conservative maximum of standard and long-context direct rates.'},now)}];
 });
}
export async function xaiPrices(apiKey,{fetcher=fetch,now=Date.now()}={}){
 if(!apiKey)throw Error('xAI credentials unavailable');
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(apiKey)),key=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
 const hit=cache.get(key);if(hit&&now-hit.checkedAt<300000)return hit.models;
 const response=await fetcher(source,{headers:{authorization:'Bearer '+apiKey},signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)throw Error('xAI price feed unavailable');
 const models=parseXaiPrices(await response.json(),now);if(!models.length)throw Error('No supported xAI text prices');
 if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,{checkedAt:now,models});return models;
}
