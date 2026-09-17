import {getStore} from '@netlify/blobs';import {validAccountId} from './storage/accounts.js';import {casUpdate} from './storage/concurrency.js';
export async function ownBillingAccount(auth,{create=false}={}){
 if(auth.open||!validAccountId(auth.accountId))throw new Error('A signed-in account owner is required for billing.');
 const account=await getStore('samvit-accounts').get('account:'+auth.accountId,{type:'json',consistency:'strong'});if(!account?.emailVerified||account.disabled||account.deleting)throw new Error('Verified active account required for billing');
 const store=getStore('samvit-users'),key='user:'+auth.accountId;
 let record=await store.get(key,{type:'json',consistency:'strong'});
 if(!record&&create)record=(await casUpdate(store,key,r=>r||{ownerAccountId:auth.accountId,createdAt:Date.now()})).value;
 if(record?.ownerAccountId!==auth.accountId)throw new Error('Billing account ownership could not be verified.');
 return {store,key,record};
}
export async function bindCustomer(store,key,accountId,customerId){
 const reverse=getStore('samvit-billing-customers');await casUpdate(reverse,customerId,r=>{if(r&&r.accountId!==accountId)throw new Error('Customer already belongs to another account');return {accountId};});
 return (await casUpdate(store,key,r=>{if(r?.ownerAccountId!==accountId||r.stripeCustomerId&&r.stripeCustomerId!==customerId)throw new Error('Billing ownership changed');return {...r,stripeCustomerId:customerId};})).value;
}
