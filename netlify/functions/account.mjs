import {getStore} from '@netlify/blobs';import {requireSession,signToken,sessionCookieHeader,SESSION_TTL_MS} from '../lib/security.js';
import {runtimeSecret} from '../lib/runtime-secrets.js';import {json,readBody,nodeEnv as env} from '../lib/new-api.js';import {changeAccount,requestAccountDeletion} from '../lib/account-lifecycle.js';import {accountLimits} from '../lib/account-limits.js';import {normalizeEmail,emailKey} from '../lib/accounts.js';
export default async(req,context)=>{
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 if(req.headers.get('origin')&&req.headers.get('origin')!==new URL(req.url).origin)return json({error:'Invalid request origin.'},403);
 try{
  const body=await readBody(req,5000);let id;
  if(body.action==='enable')return json({error:'Use the email recovery form to re-enable your account.'},403);
  const auth=await requireSession(req,env);if(!auth.ok||auth.open)return json({error:auth.message||'Sign in to a real account.'},auth.status||401);id=auth.accountId;await accountLimits(req,context,id);
  if(body.action==='delete'){const result=await requestAccountDeletion(id,body,env);return new Response(JSON.stringify(result),{status:202,headers:{'content-type':'application/json','cache-control':'no-store','set-cookie':sessionCookieHeader('',{clear:true})}});}
  const account=await changeAccount(id,body.action,body);
  const keep=['password','enable'].includes(body.action),token=keep?await signToken(await runtimeSecret(env,'SESSION_SECRET'),{sub:id,version:account.sessionVersion,exp:Date.now()+SESSION_TTL_MS}):'';
  return new Response(JSON.stringify({ok:true,signedOut:!keep}),{headers:{'content-type':'application/json','cache-control':'no-store','set-cookie':sessionCookieHeader(token,{clear:!keep})}});
 }catch(e){return json({error:e.status?e.message:'Account operation unavailable. Please retry.'},e.status||503);}
};export const config={path:'/api/account'};
