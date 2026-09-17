import {authorize,json,readBody,sseResponse} from '../lib/new-api.js';
import {resolveTarget,runTarget} from '../lib/routing.js';
export default async(req,context)=>{
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 const env=Netlify.env,{auth,response}=await authorize(req,env,context);if(response)return response;
 let body,target;try{body=await readBody(req);if(!Array.isArray(body.messages)||body.messages.length<1||body.messages.length>30||body.messages.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>24000))throw new Error('Enter a valid conversation.');target=await resolveTarget(body.target,env,auth.accountId);}catch(err){return json({error:err.message},400);}
 return sseResponse(req,async(send,signal)=>{for await(const chunk of runTarget(target,{env,accountId:auth.accountId,messages:body.messages,maxTokens:2048,signal}))send(chunk);});
};
export const config={path:'/api/routed-chat'};
