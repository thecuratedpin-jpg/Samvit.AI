import {getStore} from '@netlify/blobs';
import {casUpdate} from './storage/concurrency.js';
export const PAYMENT_RISK_STORE='samvit-payment-risk';
export const RISK_EVENTS=new Set(['charge.refunded','refund.created','refund.updated','refund.failed','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated']);
const idOf=x=>typeof x==='string'?x:x?.id;
export async function riskCustomer(event,stripe){
 const o=event.data?.object;
 const chargeId=event.type==='charge.refunded'?o?.id:idOf(o?.charge);
 if(!/^ch_[A-Za-z0-9]+$/.test(chargeId||''))throw Error('Missing charge identity');
 const charge=await stripe.charges.retrieve(chargeId);
 if(charge.id!==chargeId||charge.livemode!==false||!idOf(charge.customer))throw Error('Charge mode or ownership unavailable');
 return {customerId:idOf(charge.customer),chargeId};
}
export async function reconcilePaymentRisk({accountId,customerId,event,stripe,now=()=>Date.now()}){
 const store=getStore(PAYMENT_RISK_STORE),key='risk:'+accountId,token=crypto.randomUUID();
 await casUpdate(store,key,r=>{if(r?.lease?.expiresAt>now())throw Error('Payment review busy');return {...r,accountId,uncertain:true,lease:{token,expiresAt:now()+120000}};});
 try{
  // Read the current charge/dispute inside a fenced lease, never apply event snapshots.
  const {chargeId,customerId:owner}=await riskCustomer(event,stripe);if(owner!==customerId)throw Error('Charge customer mismatch');
  const charge=await stripe.charges.retrieve(chargeId);
  if(idOf(charge.customer)!==customerId||charge.livemode!==false||!Number.isSafeInteger(charge.amount_refunded)||charge.amount_refunded<0)throw Error('Invalid charge');
  let dispute;
  if(event.type.startsWith('charge.dispute.')){dispute=await stripe.disputes.retrieve(event.data.object.id);if(idOf(dispute.charge)!==chargeId||dispute.livemode!==false)throw Error('Dispute ownership mismatch');}
  return (await casUpdate(store,key,r=>{
   if(r?.lease?.token!==token||r.lease.expiresAt<=now())throw Error('Payment review lease lost');
   const holds={...r.holds};
   if(charge.amount_refunded>0)holds['refund:'+chargeId]={reason:'refunded_payment',amountRefunded:charge.amount_refunded,updatedAt:now()};
   if(dispute){const k='dispute:'+dispute.id;if(['won','warning_closed'].includes(dispute.status))delete holds[k];else holds[k]={reason:'disputed_payment',status:dispute.status,updatedAt:now()};}
   return {...r,holds,uncertain:false,lease:null,revision:(r.revision||0)+1,lastEventId:event.id,updatedAt:now()};
  })).value;
 }finally{await casUpdate(store,key,r=>r?.lease?.token===token?{...r,lease:null}:r);}
}
export async function paymentRisk(accountId){const r=await getStore(PAYMENT_RISK_STORE).get('risk:'+accountId,{type:'json',consistency:'strong'});return {blocked:Boolean(r?.uncertain||Object.keys(r?.holds||{}).length),reviewPending:Boolean(r?.uncertain),holds:r?.holds||{}};}
