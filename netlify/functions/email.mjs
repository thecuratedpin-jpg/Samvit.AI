import {getStore} from '@netlify/blobs';import {json,readBody,nodeEnv as env} from '../lib/new-api.js';import {normalizeEmail,emailKey,finalizeAccount} from '../lib/accounts.js';import {accountLimits} from '../lib/account-limits.js';import {emailConfig,enqueueEmail,consumeEmailToken} from '../lib/email-channel.js';
export default async(req,context)=>{
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 if(req.headers.get('origin')&&req.headers.get('origin')!==new URL(req.url).origin)return json({error:'Invalid request origin.'},403);
 try{emailConfig(env);await accountLimits(req,context);const b=await readBody(req,5000);
 if(b.action==='complete'){const account=await consumeEmailToken(b.token,b.kind,b.newPassword);await finalizeAccount(getStore('samvit-accounts'),account,env);return json({ok:true,message:'Account confirmed. Sign in using your new password.'});}
 if(!['verify','reset','enable'].includes(b.action))return json({error:'Invalid email action.'},400);
 const email=normalizeEmail(b.email),index=await getStore('samvit-accounts').get(await emailKey(email),{type:'json',consistency:'strong'});
 return json(await enqueueEmail(email,index?.id||null,b.action,env),202);
 }catch(e){return json({error:e.status?e.message:'Account email service is unavailable. Try again later.'},e.status||503);}
};export const config={path:'/api/email'};
