import {casUpdate} from './storage/concurrency.js';import {normalizeSubscription} from './subscriptions.js';import {hasVerifiedStudentEligibility} from './student-eligibility.js';
const iso=value=>Number.isFinite(value)?new Date(value*1000).toISOString():null;
export function snapshotSubscription(sub,{customerId,priceMap,student,accountId,couponId}={}){
 if(!sub)return {planId:'free',status:'canceled',externalCustomerId:customerId,externalSubscriptionId:null,currentPeriodEnd:null,cancelAtPeriodEnd:false,isStudent:false,source:'stripe'};
 if((typeof sub.customer==='string'?sub.customer:sub.customer?.id)!==customerId||sub.livemode!==false)throw new Error('Subscription customer or mode mismatch');
 const items=sub.items?.data||[],item=items[0],plan=items.length===1&&item.quantity===1?priceMap[item.price?.id]:null;
 const status=plan&&sub.status==='active'?'active':sub.status==='canceled'?'canceled':'past_due';
 const discounts=[...(sub.discounts||[]),...(sub.discount?[sub.discount]:[])];
 const hasCoupon=discounts.some(d=>typeof d==='object'&&(d.coupon?.id===couponId||d.source?.coupon?.id===couponId));
 return {planId:plan||'free',status,externalCustomerId:customerId,externalSubscriptionId:sub.id,currentPeriodStart:iso(sub.current_period_start??item?.current_period_start),currentPeriodEnd:iso(sub.current_period_end??item?.current_period_end),cancelAtPeriodEnd:Boolean(sub.cancel_at_period_end),isStudent:hasCoupon&&hasVerifiedStudentEligibility(accountId,student),source:'stripe'};
}
export async function retrieveCustomerSubscriptions(stripe,customerId){let all=[],cursor;for(let page=0;page<20;page++){const result=await stripe.subscriptions.list({customer:customerId,status:'all',limit:100,...(cursor?{starting_after:cursor}:{})});if(!Array.isArray(result.data))throw new Error('Invalid subscription list');all.push(...result.data);if(!result.has_more)return all;cursor=result.data.at(-1)?.id;if(!cursor)throw new Error('Incomplete subscription pagination');}throw new Error('Too many subscriptions to reconcile safely');}
export async function reconcileBilling({store,accountId,customerId,event,stripe,priceMap,student,couponId,now=()=>Date.now()}){
 const key='sub:'+accountId,token=crypto.randomUUID();
 const {value:claimed}=await casUpdate(store,key,r=>{if(r?._lease&&r._lease.expiresAt>now())throw new Error('Reconciliation already in progress');return {...r,_lease:{token,expiresAt:now()+120000}};});
 try{
  if((claimed.billingEventCreated||0)>(event.created||0))return {ignored:true};
  // Events trigger reconciliation; their mutable snapshots are never applied.
  const all=event.type==='customer.deleted'?[]:await retrieveCustomerSubscriptions(stripe,customerId);
  const candidates=all.filter(s=>!['canceled','incomplete_expired'].includes(s.status));
  // A second active subscription is a billing anomaly; refuse generous entitlements.
  const selected=candidates.length===1?candidates[0]:null;
  const input=snapshotSubscription(selected,{customerId,priceMap,student,accountId,couponId});
  if(candidates.length>1)input.status='past_due';
  const {value}=await casUpdate(store,key,current=>{if(current?._lease?.token!==token||current._lease.expiresAt<=now())throw new Error('Reconciliation lease lost');if((current.billingEventCreated||0)>(event.created||0))return {...current,_lease:null};const result=normalizeSubscription({...input,billingEventCreated:Math.max(current.billingEventCreated||0,event.created||0)},current);return {...result,externalSubscriptionId:input.externalSubscriptionId,currentPeriodEnd:input.currentPeriodEnd,_lease:null,reconciledAt:now(),reconciliationEventId:event.id,reconciliationRevision:(current.reconciliationRevision||0)+1,billingAnomaly:candidates.length>1?'multiple_subscriptions':null};});
  return value;
 }finally{await casUpdate(store,key,r=>r?._lease?.token===token?{...r,_lease:null}:r);}
}
