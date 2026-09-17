import {getStore} from '@netlify/blobs';
import {checkRateLimit,clientIdentifier} from './security.js';
export async function accountLimits(req,context,accountId='anonymous'){
 const store=getStore('samvit-ratelimits');
 for(const [key,max]of [[`account-action:ip:${clientIdentifier(req,context)}`,5],...(accountId==='anonymous'?[]:[[`account-action:user:${accountId}`,5]]),['account-kdf-global',60]]){
  const r=await checkRateLimit(store,key,{windowMs:60000,max});
  if(r.degraded)throw Object.assign(new Error('Account security controls unavailable.'),{status:503});
  if(!r.allowed)throw Object.assign(new Error('Too many account attempts. Try again in a minute.'),{status:429});
 }
}
