import {providerDefinition} from '../../shared/connections.js';
import {PROVIDERS} from './providers.js';
export function classifyFailure(status,data,headers=new Headers(),now=Date.now()) {
 const code=String(data?.error?.code||data?.error?.type||data?.error?.details?.error_code||'');
 const message=String(data?.error?.message||data?.message||'');
 if(status===401||status===403)return {reason:'auth',retryable:true,rejected:true,blocked:true,cooldownUntil:0,error:'This provider rejected its credential. Check the key issuer and provider, then rotate the key or test again.'};
 if(status===402||((status===429||status===400)&&/quota|insufficient|credit|balance|spend_limit|billing/i.test(code+' '+message)))return {reason:'quota',retryable:true,rejected:true,blocked:true,cooldownUntil:0,error:'Provider credits or quota are exhausted. Refill or wait for the provider reset, then test this connection.'};
 if(status===429){const raw=headers.get('retry-after'),seconds=Number(raw);const delay=raw?(Number.isFinite(seconds)?seconds*1000:Date.parse(raw)-now):60000;return {reason:'rate_limit',retryable:true,rejected:true,cooldownUntil:now+Math.max(1000,Math.min(Number.isFinite(delay)?delay:60000,86400000)),error:'Provider rate limit reached. Trying the next eligible connection.'};}
 return {reason:'provider_error',retryable:status>=500,rejected:status>=400&&status<500,cooldownUntil:status>=500?now+30000:0,error:`Provider request failed (HTTP ${status}). Check model access and configuration.`};
}
export function connectionRequest(connection,key,params,env) {
 const def=providerDefinition(connection.provider);if(!def)throw new Error('Unknown provider.');
 if(def.kind==='direct')return PROVIDERS[def.id].buildRequest(key,{...params,model:connection.model});
 let base=def.base;
 if(def.id==='omniroute'){
  base=env.get('SAMVIT_OMNIROUTE_BASE_URL');if(!base)throw new Error('The operator must configure the OmniRoute gateway URL on the server.');
  const url=new URL(base);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('OmniRoute needs a trusted HTTPS gateway URL without credentials or query parameters.');
  base=base.replace(/\/$/,'');
 }
 const messages=[...(params.system?[{role:'system',content:params.system}]:[]),...params.messages];
 return {url:base+'/chat/completions',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({model:connection.model,messages,max_tokens:params.maxTokens||2048,stream:true,...(['openrouter','groq','together','deepinfra','fireworks','huggingface','omniroute'].includes(def.id)?{stream_options:{include_usage:true}}:{})})};
}
export async function* streamConnection(connection,key,params) {
 let request;try{request=connectionRequest(connection,key,params,params.env);}catch(err){yield {error:err.message,retryable:false,rejected:true};return;}
 const timeout=AbortSignal.timeout(params.timeoutMs||60000),signal=params.signal?AbortSignal.any([params.signal,timeout]):timeout;
 let response;
 try{response=await fetch(request.url,{method:'POST',headers:request.headers,body:request.body,signal,redirect:'error'});}catch{yield {error:signal.aborted?'Request stopped or timed out.':'Could not reach the provider.',retryable:false,reason:'network'};return;}
 if(!response.ok){let data={};try{data=await response.json();}catch{}yield {...classifyFailure(response.status,data,response.headers),status:response.status};return;}
 try {yield* (PROVIDERS[connection.provider]||PROVIDERS.openai).parseStream(response);}catch{yield {error:'Provider stream interrupted.',retryable:false};}
}
