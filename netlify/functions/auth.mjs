import {runtimeSecret} from '../lib/runtime-secrets.js';
import {getStore} from '@netlify/blobs';
import {signToken,sessionCookieHeader,SESSION_TTL_MS,checkRateLimit,clientIdentifier,isDevelopmentMode,requireSession} from '../lib/security.js';
import {registerAccount,signInAccount} from '../lib/accounts.js';
import {readBody,json,nodeEnv as env} from '../lib/new-api.js';
export default async(req,context)=>{
 if(req.method==='GET'){const auth=await requireSession(req,env);return auth.ok?json({account:{id:auth.accountId,email:auth.email,role:auth.role,emailVerified:auth.emailVerified}}):json({error:auth.message},auth.status);}
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return json({error:'Invalid request origin.'},403);
 let body;try{body=await readBody(req,5000);}catch{return json({error:'Enter valid sign-in details.'},400);}
 if(body.logout)return new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json','cache-control':'no-store','set-cookie':sessionCookieHeader('',{clear:true})}});
 if(!env.get('ACCESS_CODE')&&isDevelopmentMode(env)&&!body.email)return json({ok:true,open:true});
 let secret;try{secret=await runtimeSecret(env,'SESSION_SECRET');}catch{return json({error:'Session storage is unavailable.'},503);}if(!secret||secret.length<32)return json({error:'Account sign-in is not configured. A session secret of at least 32 characters is required.'},503);
 try{
  const store=getStore('samvit-ratelimits');
  for(const [id,max]of [[`account-login:${clientIdentifier(req,context)}`,5],['account-kdf-global',60]]){const limit=await checkRateLimit(store,id,{windowMs:60000,max});if(limit.degraded)return json({error:'Sign-in is temporarily unavailable.'},503);if(!limit.allowed)return json({error:'Too many attempts. Try again in a minute.'},429);}
 }catch{return json({error:'Sign-in is temporarily unavailable.'},503);}
 try{
  if(body.action==='register')return json(await registerAccount(body,env),202);
  const account=await signInAccount(body,env);
  const token=await signToken(secret,{sub:account.id,version:account.sessionVersion,exp:Date.now()+SESSION_TTL_MS});
  return new Response(JSON.stringify({ok:true,account:{id:account.id,email:account.email,role:account.role,emailVerified:account.emailVerified}}),{status:body.action==='register'?201:200,headers:{'content-type':'application/json','cache-control':'no-store','set-cookie':sessionCookieHeader(token)}});
 }catch(err){const known=/password|email|invitation|owner-claim/.test(err.message);return json({error:err.status||known?err.message:'Account setup could not finish. Try again later.'},err.status|| (known?400:503));}
};
export const config={path:'/api/auth'};
