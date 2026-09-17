import {getStore} from '@netlify/blobs';import {casUpdate} from './storage/concurrency.js';import {STUDENT_STORE,hasVerifiedStudentEligibility,studentDiscountCoupon} from './student-eligibility.js';import {retrieveCustomerSubscriptions} from './billing-reconciliation.js';
const couponOf=d=>d?.coupon?.id||d?.source?.coupon?.id;
export async function revokeExpiredDiscount(accountId,env,stripe,{now=()=>Date.now()}={}){
 const store=getStore(STUDENT_STORE),key='student:'+accountId,token=crypto.randomUUID();
 const record=await store.get(key,{type:'json',consistency:'strong'});if(!record||hasVerifiedStudentEligibility(accountId,record,now()))return false;
 await casUpdate(store,key,r=>{if(hasVerifiedStudentEligibility(accountId,r,now()))throw Error('Eligibility changed');if(r?.revocationLease?.expiresAt>now())throw Error('Revocation busy');return {...r,revocationPending:true,revocationLease:{token,expiresAt:now()+120000}};});
 try{
  const user=await getStore('samvit-users').get('user:'+accountId,{type:'json',consistency:'strong'});
  if(user?.stripeCustomerId){if(user.ownerAccountId!==accountId)throw Error('Billing ownership mismatch');const coupon=studentDiscountCoupon(env);if(!coupon)throw Error('Student coupon missing');
   const subscriptions=await retrieveCustomerSubscriptions(stripe,user.stripeCustomerId);
   for(const candidate of subscriptions.filter(s=>!['canceled','incomplete_expired'].includes(s.status))){
    const sub=await stripe.subscriptions.retrieve(candidate.id,{expand:['discounts']});if(sub.livemode!==false||(typeof sub.customer==='string'?sub.customer:sub.customer?.id)!==user.stripeCustomerId)throw Error('Subscription ownership mismatch');
    const discounts=sub.discounts?.length?sub.discounts:sub.discount?[sub.discount]:[];
    if(discounts.some(d=>typeof d!=='object'||!d.id||!couponOf(d)))throw Error('Discount detail unavailable');
    const keep=discounts.filter(d=>couponOf(d)!==coupon);if(keep.length!==discounts.length)await stripe.subscriptions.update(sub.id,{discounts:keep.length?keep.map(d=>({discount:d.id})):'',proration_behavior:'none'},{idempotencyKey:`samvit-student-revoke-${accountId}-${record.revision}-${sub.id}`});
   }
  }
  await casUpdate(store,key,r=>{if(r?.revocationLease?.token!==token||r.revocationLease.expiresAt<=now())throw Error('Revocation lease lost');return {...r,status:r.status==='verified'?'expired':r.status,revocationPending:false,discountRevokedAt:now(),revocationLease:null};});return true;
 }finally{await casUpdate(store,key,r=>r?.revocationLease?.token===token?{...r,revocationLease:null}:r);}
}
