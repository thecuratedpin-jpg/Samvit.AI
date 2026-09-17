import {runtimeSecret} from '../runtime-secrets.js';
import {signToken,verifyToken} from '../security.js';
import {jobKey} from './jobs.js';
export async function dispatchJob(job,env,{fetcher=fetch}={}){
 const origin=new URL(env.get('SAMVIT_PUBLIC_ORIGIN'));if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Configure HTTPS SAMVIT_PUBLIC_ORIGIN');
 const secret=await runtimeSecret(env,'SESSION_SECRET');const token=await signToken(secret,{aud:'samvit-worker-v9',accountId:job.accountId,id:job.id,exp:Date.now()+120000});
 const r=await fetcher(origin.origin+'/.netlify/functions/orchestrate-background',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(7000)});if(r.status!==202)throw Error('Background worker dispatch unavailable');return true;
}
export async function authorizeWorker(req,env){if(req.method!=='POST')throw Error('Method denied');const raw=req.headers.get('authorization')||'';if(!raw.startsWith('Bearer ')||raw.length>2000)throw Error('Worker authentication required');const payload=await verifyToken(await runtimeSecret(env,'SESSION_SECRET'),raw.slice(7));if(payload?.aud!=='samvit-worker-v9')throw Error('Invalid worker token');jobKey(payload.accountId,payload.id);return payload;}
