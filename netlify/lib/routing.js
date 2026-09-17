import {accountStore} from './storage/accounts.js';
import {recordUsage} from './orchestrator.js';
import {getStore} from '@netlify/blobs';
import {MODEL_CATALOG,findModel,estimateModelCost} from '../../shared/catalog.js';
import {getApiKeyForProvider} from './providers.js';
import {streamMetered} from './metered-provider.js';
import {readConnections,openKey,markConnection,nextComboOrder,CONNECTION_STORE} from './connection-store.js';
import {streamConnection} from './connection-transport.js';
import {getFreeModels} from './free-models.js';
export async function resolveTarget(target,env,account){
 if(typeof target!=='string')throw new Error('Select a model, connection or combo.');
 if(target.startsWith('model:')){const [provider,...rest]=target.slice(6).split(':');const model=findModel(provider,rest.join(':'));if(!model||!getApiKeyForProvider(provider,env))throw new Error('This model is not connected.');return {candidates:[{...model,name:model.label,direct:true}]};}
 const store=getStore(CONNECTION_STORE),data=await readConnections(store,account);
 if(target.startsWith('connection:')){const c=data.connections.find(c=>c.id===target.slice(11));if(!c)throw new Error('Connection no longer exists.');return {candidates:[c],store};}
 if(target.startsWith('combo:')){const combo=data.combos.find(c=>c.id===target.slice(6));if(!combo)throw new Error('Combo no longer exists.');const order=await nextComboOrder(store,account,combo);return {store,freeOnly:combo.freeOnly,candidates:order.map(id=>data.connections.find(c=>c.id===id)).filter(Boolean)};}
 throw new Error('Unknown routing target.');
}
export async function* runTarget(resolved,params,{test=false}={}) {
 const {env,accountId}=params;let attempted=0;
 for(const c of resolved.candidates){
  if(params.signal?.aborted)return;
  if(!c.direct&&!test&&(!c.enabled||c.cooldownUntil>Date.now())){yield {skipped:true,name:c.name,reason:c.status,cooldownUntil:c.cooldownUntil};continue;}
  if(resolved.freeOnly||c.verifiedFree){let free;try{free=(await getFreeModels()).models.some(m=>m.id===c.model&&c.provider==='openrouter');}catch{yield {error:'Could not verify zero pricing. Free routing stopped without a paid fallback.',retryable:false};return;}if(!free){yield {skipped:true,name:c.name,reason:'Zero price no longer verified'};continue;}}
  let key;try{key=c.direct?getApiKeyForProvider(c.provider,env):await openKey(c.secret,env,accountId+':'+c.id);}catch{yield {error:'The connection key could not be opened. Ask the owner to save it again.',retryable:false};return;}
  attempted++;yield {selected:true,provider:c.provider,model:c.direct?c.id:c.model,name:c.name,fallback:attempted>1};
  const modelInfo=c.direct?c:{provider:c.provider,id:c.model,label:c.label,input:c.input,output:c.output,verifiedFree:c.verifiedFree,updatedAt:c.updatedAt};
  let started=false,error=null,done=false;
  for await(const chunk of streamMetered(c.provider,key,{...params,model:modelInfo.id,modelInfo,...(!c.direct?{transport:(key,p)=>streamConnection(c,key,p)}:{})})){
   if(chunk.text){started=true;yield {delta:chunk.text,provider:c.provider,model:modelInfo.id};}
   if(chunk.error){error=chunk;break;}
   if(chunk.done){done=true;const costUsd=chunk.meteredCostUsd??null;try{await recordUsage(accountStore('samvit-analytics',accountId),{provider:c.provider,model:modelInfo.id,usage:chunk.usage,costUsd,endpoint:params.endpoint||'routed-chat'});}catch{}yield {done:true,provider:c.provider,model:modelInfo.id,usage:chunk.usage,costUsd};}
  }
  if(!c.direct){const patch=done?{enabled:true,status:'ready',cooldownUntil:0}:error?.reason?{enabled:!error.blocked,status:error.reason,cooldownUntil:error.cooldownUntil||0}:null;if(patch)try{await markConnection(resolved.store,accountId,c.id,patch,c.updatedAt,test);}catch{yield {error:'Connection health could not be saved. Routing stopped.',retryable:false};return;}}
  if(done)return;
  if(started||!error?.retryable||test){yield {error:error?.error||'Response ended early.',partial:started};return;}
  yield {skipped:true,name:c.name,reason:error.reason||'unavailable'};
 }
 yield {error:'No eligible connection is available. Check keys, credits or cooldowns in Connections. No paid fallback was added.'};
}
export function environmentTargets(env){return MODEL_CATALOG.filter(m=>getApiKeyForProvider(m.provider,env)).map(m=>({id:`model:${m.provider}:${m.id}`,label:m.label,provider:m.provider}));}
