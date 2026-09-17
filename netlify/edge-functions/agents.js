import {getStore} from '@netlify/blobs';
import {authorize,json,readBody,sseResponse} from '../lib/new-api.js';
import {getSubscription,isSubscriptionServiceUnavailable,SUBSCRIPTION_STORE_NAME} from '../lib/subscriptions.js';
import {validateTeam} from '../../shared/teams.js';
import {resolveTarget,runTarget} from '../lib/routing.js';
import {runTeam} from '../lib/team-runner.js';
export default async(req,context)=>{
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 const env=Netlify.env,{auth,response}=await authorize(req,env,context);if(response)return response;
 let subscription;try{subscription=await getSubscription(getStore(SUBSCRIPTION_STORE_NAME),auth.accountId,env);if(isSubscriptionServiceUnavailable(subscription))throw Error();}catch{return json({error:'Subscription validation unavailable.'},503);}
 let body;try{body=await readBody(req,14000);}catch(err){return json({error:err.message},400);}
 const validation=validateTeam(body,subscription);if(!validation.ok)return json({error:validation.error},validation.status);
 const targets=[];try{for(const a of body.agents)targets.push(await resolveTarget(a.target,env,auth.accountId));}catch(err){return json({error:err.message},400);}
 return sseResponse(req,(send,signal)=>runTeam({goal:body.goal,agents:body.agents,targets,env,accountId:auth.accountId,send,signal:AbortSignal.any([signal,AbortSignal.timeout(240000)]),run:runTarget}));
};
export const config={path:'/api/agents'};
