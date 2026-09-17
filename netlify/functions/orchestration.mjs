import {getStore} from '@netlify/blobs';
import {authorize,json,readBody,nodeEnv as env} from '../lib/new-api.js';
import {JOB_STORE,createJob,getJob,commandJob,publicJob} from '../lib/intelligence/jobs.js';
import {dispatchJob} from '../lib/intelligence/dispatch.js';
import {listKeys} from '../lib/store-inventory.js';
import {availableTools,TOOL_CATEGORIES,COMPUTER_GRANTS} from '../lib/intelligence/tools.js';
import {summarizeMission,completionNotification,TRACE_LIMIT} from '../lib/intelligence/trace.js';
import {readSafety} from '../lib/intelligence/permissions.js';
export default async(req,context)=>{
 if(!['GET','POST'].includes(req.method))return json({error:'Method not allowed'},405);
 const {auth,response}=await authorize(req,env,context);if(response)return response;if(auth.open)return json({error:'Sign in with a verified account to run durable missions'},403);
 try{
  if(req.method==='GET'){
   const id=new URL(req.url).searchParams.get('id');
   if(id){
    const job=await getJob(auth.accountId,id);if(!job)return json({error:'Mission not found'},404);
    // Phase 10/8: the user-facing trace, reasoning summary and completion
    // notification are derived on read, so they can never drift from the
    // stored mission state.
    return json({job:publicJob(job),summary:summarizeMission(job),notification:completionNotification(job),trace:(Array.isArray(job.trace)?job.trace:[]).slice(-TRACE_LIMIT)});
   }
   const jobs=[];for await(const key of listKeys(getStore(JOB_STORE),`accounts/${auth.accountId}/job:`)){const r=await getStore(JOB_STORE).get(key,{type:'json',consistency:'strong'});if(r)jobs.push({id:r.id,goal:r.goal.slice(0,160),status:r.status,createdAt:r.createdAt,projectId:r.projectId,notification:r.notification});if(jobs.length>=100)break;}
   const safety=await readSafety(auth.accountId);
   return json({jobs:jobs.sort((a,b)=>b.createdAt-a.createdAt),tools:availableTools(env,['calculate','web_search','fetch_url','file_read','file_search','memory_search','create_document',...COMPUTER_GRANTS]),categories:TOOL_CATEGORIES,unavailable:['host filesystem access','host terminal or shell','sandboxed native code execution','image generation','external publishing or messaging','binary Office formats'],safety:{halted:safety.halted,reason:safety.reason||null}});
  }
  // `body` is passed through so `decide` can carry the decision id and answer.
  const body=await readBody(req,16000),job=body.action&&body.action!=='create'?await commandJob(auth.accountId,body.id,body.action,body):await createJob(auth.accountId,body,env);
  let dispatched=false;if(job.status==='queued')try{dispatched=await dispatchJob(job,env);}catch{}
  return json({job:publicJob(job),dispatched,message:job.status==='queued'&&!dispatched?'Mission saved. The background dispatcher will retry; check worker configuration if it stays queued.':null},202);
 }catch(e){return json({error:e.message.startsWith('Failed to')?'Mission storage unavailable':e.message},400);}
};export const config={path:'/api/orchestration'};
