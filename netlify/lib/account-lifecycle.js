import {getStore} from '@netlify/blobs';
import {casUpdate} from './storage/concurrency.js';
import {hashPassword,verifyPassword} from './passwords.js';
import {emailKey,ACCOUNT_STORE} from './accounts.js';
import {PERSONAL_STORES,STORE_INVENTORY,listKeys} from './store-inventory.js';
import {billingEnabled,stripeClient} from './checkout.js';
import {retrieveCustomerSubscriptions} from './billing-reconciliation.js';
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
export async function changeAccount(id,action,body){
 const store=getStore(ACCOUNT_STORE),current=await store.get('account:'+id,{type:'json',consistency:'strong'});
 if(!current||current.deleting)throw failure('Account unavailable.',401);
 if(action!=='signout-all'&&!await verifyPassword(body.currentPassword,current.password))throw failure('Current password is incorrect.',401);
 const password=action==='password'?await hashPassword(body.newPassword):null;
 if(!['password','signout-all','disable','enable'].includes(action))throw failure('Unknown account action.');
 const {value}=await casUpdate(store,'account:'+id,r=>{
  if(!r||r.deleting||r.sessionVersion!==current.sessionVersion)throw failure('Account changed. Sign in and retry.',409);
  if(r.disabled&&action!=='enable')throw failure('Account is disabled.',401);
  return {...r,...(password?{password}:{}),...(['disable','enable'].includes(action)?{disabled:action==='disable'}:{}),sessionVersion:r.sessionVersion+1,updatedAt:Date.now()};
 });
 // The email index is an identity pointer, never a backup of an old password hash.
 await casUpdate(store,await emailKey(current.email),r=>r?.id===id?{id}:r);
 return value;
}
export async function requestAccountDeletion(id,body,env,{now=Date.now()}={}){
 const accounts=getStore(ACCOUNT_STORE),a=await accounts.get('account:'+id,{type:'json',consistency:'strong'});
 if(!a||!await verifyPassword(body.currentPassword,a.password))throw failure('Current password is incorrect.',401);
 await assertDeletionBilling(id,env,now);
 await casUpdate(accounts,'account:'+id,r=>{if(!r||r.sessionVersion!==a.sessionVersion)throw failure('Account changed. Retry.',409);return {...r,disabled:true,deleting:true,deletionRequestedAt:now,sessionVersion:r.sessionVersion+1};});
 // Delay physical cleanup so bounded in-flight AI requests can finish. Retryable scheduled job.
 const index=await emailKey(a.email);
 await casUpdate(getStore('samvit-account-deletions'),id,r=>r||{accountId:id,emailIndex:index,notBefore:now+300000,status:'pending'});
 return {pending:true,message:'Account disabled and all sessions revoked. Data deletion is queued after a five-minute drain period.'};
}
export async function purgeAccount(job,now=Date.now(),env){
 if(job.status==='complete'||job.notBefore>now)return false;
 const id=job.accountId,accounts=getStore(ACCOUNT_STORE),a=await accounts.get('account:'+id,{type:'json',consistency:'strong'});
 if(a&&!a.deleting)throw failure('Deletion lock is absent.',409);
 await assertDeletionBilling(id,env,now);
 const meta=await accounts.get('meta',{type:'json',consistency:'strong'}),legacyOwner=meta?.ownerAccountId===id;
 for(const name of STORE_INVENTORY){
  if(['samvit-runtime-secrets','samvit-account-deletions'].includes(name))continue;
  const store=getStore(name);
  for await(const key of listKeys(store)){
   let remove=key.startsWith('accounts/'+id+'/')||key===`workspace:${id}`||key===`sub:${id}`||key===`user:${id}`||key===`student:${id}`||key.startsWith(`budget:${id}:`)||key===`account:${id}`||key===job.emailIndex;
   if(!remove&&!['samvit-accounts',...PERSONAL_STORES].includes(name)){const value=await store.get(key,{type:'json',consistency:'strong'});remove=value?.accountId===id||value?.account===id||key.includes(':'+id+':')||key.endsWith(':'+id);}
   if(legacyOwner&&PERSONAL_STORES.includes(name)&&!key.startsWith('accounts/'))remove=true;
   if(legacyOwner&&(key==='workspace:samvit-user'||key==='sub:samvit-user'||key==='user:samvit-user'||key.startsWith('budget:samvit-user:')))remove=true;
   if(remove)await store.delete(key);
  }
 }
 await casUpdate(accounts,'meta',r=>r?.ownerAccountId===id?{...r,ownerDeleted:true,migrationComplete:true}:r);
 // V14: scrub any dev-mode email captures addressed to this account.
 try{
  const outbox=getStore('samvit-email-dev-outbox'),record=await outbox.get('messages',{type:'json',consistency:'strong'});
  if(Array.isArray(record?.rows)&&record.rows.some(row=>Array.isArray(row.to)&&row.to.includes(a?.email))){
   await outbox.setJSON('messages',{rows:record.rows.filter(row=>!(Array.isArray(row.to)&&row.to.includes(a?.email)))});
  }
 }catch{/* dev outbox hygiene must never block deletion */}
 await casUpdate(getStore('samvit-account-deletions'),id,r=>({...r,emailIndex:null,status:'complete',completedAt:now}));
 return true;
}

export async function assertDeletionBilling(id,env,now=Date.now()){
 const sub=await getStore('samvit-subscription').get('sub:'+id,{type:'json',consistency:'strong'});
 if(sub&&sub.planId!=='free'&&['active','past_due'].includes(sub.status))throw failure('Cancel your paid subscription and wait for it to end before deleting your account.',409);
 const user=await getStore('samvit-users').get('user:'+id,{type:'json',consistency:'strong'});
 if(user?.checkout?.expiresAt>now)throw failure('Wait for your open checkout to expire before deleting the account.',409);
 if(user?.stripeCustomerId){if(!billingEnabled(env))throw failure('Billing must be available to confirm cancellation before deletion.',503);const subscriptions=await retrieveCustomerSubscriptions(stripeClient(env),user.stripeCustomerId);if(subscriptions.some(s=>!['canceled','incomplete_expired'].includes(s.status)))throw failure('Cancel your paid subscription before deleting your account.',409);}
}
