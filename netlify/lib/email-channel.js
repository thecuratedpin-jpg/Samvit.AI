import {getStore} from '@netlify/blobs';import {casUpdate} from './storage/concurrency.js';import {sealKey,openKey} from './connection-store.js';import {listKeys} from './store-inventory.js';import {hashPassword} from './passwords.js';
export const EMAIL_STORE='samvit-email-outbox';
export const acceptedEmail={accepted:true,message:'Request queued. Check your email for the next step if this address can be used. Delivery may take a few minutes.'};
export function emailConfig(env){const key=env.get('RESEND_API_KEY'),from=env.get('SAMVIT_EMAIL_FROM'),raw=env.get('SAMVIT_PUBLIC_ORIGIN');let origin;try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error();origin=u.origin;}catch{}if(!key||!from||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from)||!origin)throw Object.assign(new Error('Email is not configured. The operator must set RESEND_API_KEY, SAMVIT_EMAIL_FROM and an HTTPS SAMVIT_PUBLIC_ORIGIN.'),{status:503});return {key,from,origin};}
const digest=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
export async function enqueueEmail(to,accountId,kind,env){emailConfig(env);const id=crypto.randomUUID(),payload=await sealKey(JSON.stringify({to,accountId,kind}),env,'email:'+id);await casUpdate(getStore(EMAIL_STORE),id,r=>r||{id,accountId,payload,status:'pending',attempts:0,createdAt:Date.now()});return acceptedEmail;}
export async function issueEmailToken(accountId,kind,now=Date.now()){
 const raw=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),hash=await digest(raw);
 await casUpdate(getStore('samvit-accounts'),'account:'+accountId,r=>{if(!r||r.deleting)throw Error('Account unavailable');return {...r,emailChallenges:{...Object.fromEntries(Object.entries(r.emailChallenges||{}).filter(([,v])=>v.expiresAt>now).slice(-4)),[hash]:{kind,expiresAt:now+1800000,version:r.sessionVersion}}};});return accountId+'.'+raw;
}
export async function consumeEmailToken(token,kind,newPassword,now=Date.now()){
 if(typeof token!=='string'||!/^usr_[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(token)||!['verify','reset','enable'].includes(kind))throw Object.assign(Error('Invalid or expired link.'),{status:400});
 const [id,raw]=token.split('.'),hash=await digest(raw),password=await hashPassword(newPassword);
 return (await casUpdate(getStore('samvit-accounts'),'account:'+id,r=>{const c=r?.emailChallenges?.[hash];if(!r||r.deleting||!c||c.kind!==kind||c.expiresAt<=now||c.version!==r.sessionVersion)throw Object.assign(Error('Invalid or expired link.'),{status:400});if(r.disabled&&kind!=='enable')throw Object.assign(Error('Account disabled. Use the re-enable email flow.'),{status:400});return {...r,password,emailVerified:true,emailVerifiedAt:now,disabled:kind==='enable'?false:r.disabled,sessionVersion:r.sessionVersion+1,emailChallenges:{},updatedAt:now};})).value;
}
export async function deliverQueuedEmail(job,env,{fetcher=fetch,now=Date.now()}={}){
 const config=emailConfig(env),store=getStore(EMAIL_STORE),token=crypto.randomUUID();let held;
 held=(await casUpdate(store,job.id,r=>{if(!r||r.status==='sent'||r.leaseUntil>now||r.attempts>=5)return r;return {...r,status:'sending',lease:token,leaseUntil:now+120000,attempts:r.attempts+1};})).value;
 if(held?.lease!==token)return false;
 try{
  let delivery=held.delivery?JSON.parse(await openKey(held.delivery,env,'delivery:'+job.id)):null;
  if(!delivery){const payload=JSON.parse(await openKey(held.payload,env,'email:'+job.id));const account=payload.accountId?await getStore('samvit-accounts').get('account:'+payload.accountId,{type:'json',consistency:'strong'}):null;let text='A Samvit account request was received for this address. If you already have an account, sign in or request recovery from the account page.';
   const kind=payload.kind==='register'?'verify':payload.kind;
   if(account&&!account.deleting&&!(kind==='verify'&&account.emailVerified)){const link=config.origin+'/#email?kind='+kind+'&token='+encodeURIComponent(await issueEmailToken(account.id,kind));text='Complete your Samvit '+kind+' request at: '+link+'\nThis single-use link expires in 30 minutes. Set your own password when confirming. If you did not request this, ignore this email.';}
   delivery={from:config.from,to:[payload.to],subject:'Your Samvit account request',text};const encrypted=await sealKey(JSON.stringify(delivery),env,'delivery:'+job.id);await casUpdate(store,job.id,r=>{if(r?.lease!==token)throw Error('Mail lease lost');return {...r,delivery:encrypted};});
  }
  const response=await fetcher('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+config.key,'content-type':'application/json','idempotency-key':'samvit-email-'+job.id},body:JSON.stringify(delivery)});
  if(!response.ok||!(await response.json())?.id)throw Error('Email provider rejected delivery');
  await casUpdate(store,job.id,r=>{if(r?.lease!==token)throw Error('Mail lease lost');return {...r,status:'sent',lease:null,leaseUntil:0,payload:null,delivery:null,sentAt:Date.now()};});return true;
 }catch{await casUpdate(store,job.id,r=>r?.lease===token?{...r,status:'failed',lease:null,leaseUntil:0,lastError:'Email delivery failed; check provider configuration and delivery logs.'}:r);return false;}
}
export async function runEmailQueue(env){const store=getStore(EMAIL_STORE);let count=0;for await(const key of listKeys(store)){const job=await store.get(key,{type:'json',consistency:'strong'});if(job.status!=='sent'&&job.attempts<5){await deliverQueuedEmail(job,env);if(++count>=10)break;}}return count;}
