import {runtimeSecret} from '../lib/runtime-secrets.js';
import {getStore} from '@netlify/blobs';
import {authorize,json,readBody,nodeEnv as env} from '../lib/new-api.js';
import {readConnections,saveConnection,saveCombo,deleteConnection,publicConnection,CONNECTION_STORE} from '../lib/connection-store.js';
import {CONNECTION_PROVIDERS} from '../../shared/connections.js';
import {environmentTargets,resolveTarget,runTarget} from '../lib/routing.js';
import {getFreeModels} from '../lib/free-models.js';
export default async(req,context)=>{
 if(!['GET','POST'].includes(req.method))return json({error:'Method not allowed.'},405);
 const {auth,response}=await authorize(req,env,context,req.method==='POST');if(response)return response;
 let store;try{store=getStore(CONNECTION_STORE);}catch{return json({error:'Connection storage unavailable.'},503);}
 try{
  if(req.method==='GET'){const data=await readConnections(store,auth.accountId);return json({providers:CONNECTION_PROVIDERS,connections:data.connections.map(publicConnection),combos:data.combos.map(({cursor,...c})=>c),environmentTargets:environmentTargets(env),managementConfigured:Boolean((await runtimeSecret(env,'SAMVIT_KEY_ENCRYPTION_SECRET'))?.length>=32&&(!auth.open||env.get('SAMVIT_CONNECTIONS_ADMIN_CODE')?.length>=16))});}
  const body=await readBody(req);
  if(body.action==='save'){const free=body.provider==='openrouter'?(await getFreeModels()).models:[];return json({connection:await saveConnection(store,auth.accountId,env,body,free)});}
  if(body.action==='combo'){return json({id:await saveCombo(store,auth.accountId,body)});}
  if(body.action==='delete'||body.action==='delete-combo'){if(typeof body.id!=='string')throw new Error('Choose a connection or combo.');await deleteConnection(store,auth.accountId,body.id,body.action==='delete-combo');return json({ok:true});}
  if(body.action==='test'){if(typeof body.id!=='string')throw new Error('Choose a connection.');const target=await resolveTarget('connection:'+body.id,env,auth.accountId);let failure=null,done=false;for await(const e of runTarget(target,{env,accountId:auth.accountId,messages:[{role:'user',content:'Reply with OK.'}],maxTokens:32,signal:req.signal},{test:true})){if(e.error)failure=e.error;if(e.done)done=true;}return json({ok:done&&!failure,message:failure||'Model responded successfully. Connection is ready.'});}
  return json({error:'Unknown connection action.'},400);
 }catch(err){return json({error:err.message||'Connection request failed.'},400);}
};
export const config={path:'/api/connections'};
