import {accountStore} from '../lib/storage/accounts.js';
import {getStore} from '@netlify/blobs';
import {PROVIDERS,getApiKeyForProvider,estimateCostUsd} from '../lib/providers.js';
import {streamMetered} from '../lib/metered-provider.js';
import {selectModel,MODEL_CATALOG,estimateModelCost} from '../../shared/catalog.js';
import {requireSession,checkRateLimit,clientIdentifier} from '../lib/security.js';
import {validateAiRequest} from '../lib/ai-limits.js';
import {recordUsage} from '../lib/orchestrator.js';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export default async (request,context)=> {
  if (request.method !== 'POST') return json({error:'Method not allowed'},405);
  const env = Netlify.env;
  const auth = await requireSession(request,env);
  if (!auth.ok) return json({error:auth.message},auth.status);
  let body; try {body = await request.json();} catch {return json({error:'Malformed request body.'},400);}
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({error:'Expected an object.'},400);
  const {messages,system,tier='balanced',allowFallback=false,maxTokens=2048} = body;
  if (typeof allowFallback !== 'boolean' || !Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 4096) return json({error:'Invalid fallback setting or output limit (128–4096).'},400);
  const available = Object.fromEntries(Object.keys(PROVIDERS).map(id=>[id,Boolean(getApiKeyForProvider(id,env))]));
  let selected;
  try {selected=selectModel({provider:body.provider || 'auto',model:body.model,tier,available});} catch(err) {return json({error:err.message},400);}
  const validation=validateAiRequest({messages,system,providers:[selected.provider]});
  if (!validation.valid) return json({error:validation.error},400);
  try {
    const rl=await checkRateLimit(getStore('samvit-ratelimits'),clientIdentifier(request,context),{windowMs:60000,max:Number(env.get('RATE_LIMIT_PER_MINUTE'))||20});
    if (rl.degraded) return json({error:'Usage controls temporarily unavailable.'},503);
    if (!rl.allowed) return json({error:'Too many requests. Please try again shortly.'},429);
  } catch {return json({error:'Usage controls temporarily unavailable.'},503);}
  const candidates=[selected];
  if (allowFallback) candidates.push(...MODEL_CATALOG.filter(m=>m.provider!==selected.provider && available[m.provider] && m.tier===selected.tier && estimateModelCost(m,1000,maxTokens)<=estimateModelCost(selected,1000,maxTokens)).slice(0,2));
  const abort=new AbortController();
  const signal=AbortSignal.any([request.signal,abort.signal]);
  let closed=false;
  const stream=new ReadableStream({
    async start(controller) {
      const send=event=> {if(!closed&&!signal.aborted) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));};
      try {
        for(let index=0;index<candidates.length;index++) {
          const candidate=candidates[index]; let started=false,lastError=null;
          send({selected:true,provider:candidate.provider,model:candidate.id,fallback:index>0});
          for await(const chunk of streamMetered(candidate.provider,getApiKeyForProvider(candidate.provider,env),{model:candidate.id,messages,system,maxTokens,signal,env,accountId:auth.accountId})) {
            if(chunk.text) {started=true;send({delta:chunk.text,provider:candidate.provider,model:candidate.id});}
            if(chunk.error) {lastError=chunk.error;break;}
            if(chunk.done) {
              const costUsd=(chunk.meteredCostUsd??null);
              try {await recordUsage(accountStore('samvit-analytics',auth.accountId),{provider:candidate.provider,model:candidate.id,usage:chunk.usage,costUsd,endpoint:'chat'});} catch {}
              send({done:true,provider:candidate.provider,model:candidate.id,usage:chunk.usage,costUsd});return;
            }
          }
          if(started || index===candidates.length-1 || signal.aborted) {send({error:lastError||'Response interrupted. Please try again.'});return;}
        }
      } catch {send({error:'The request could not be completed. Please try again.'});}
      finally {if(!closed) {closed=true;controller.close();}}
    },
    cancel() {closed=true;abort.abort();}
  });
  return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-cache, no-transform'}});
};
export const config={path:'/api/chat'};
