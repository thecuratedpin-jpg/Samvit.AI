import {RISK_EVENTS,riskCustomer,reconcilePaymentRisk} from '../lib/payment-risk.js';
import {getStore} from '@netlify/blobs';
import {billingEnabled,priceMap,stripeClient,nodeEnv as env} from '../lib/checkout.js';
import {json} from '../lib/new-api.js';
import {SUBSCRIPTION_STORE_NAME} from '../lib/subscriptions.js';
import {getStudentRecord,studentDiscountCoupon} from '../lib/student-eligibility.js';
import {reconcileBilling} from '../lib/billing-reconciliation.js';
import {verifyStripeSignature,claimBillingEventForProcessing,markBillingEventApplied,markBillingEventFailed,BILLING_EVENTS_STORE_NAME,BILLING_EVENT_TYPES} from '../lib/billing.js';
const supported=new Set(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed','invoice.paid','invoice.payment_failed','invoice.payment_action_required','invoice.voided','invoice.marked_uncollectible','customer.deleted']);
export default async req=>{
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 if(!billingEnabled(env)||!env.get('STRIPE_WEBHOOK_SECRET'))return json({error:'Billing webhook is disabled.'},501);
 if(Number(req.headers.get('content-length'))>1000000)return json({error:'Event too large.'},413);
 const raw=await req.text();if(raw.length>1000000)return json({error:'Event too large.'},413);
 if(!(await verifyStripeSignature(raw,req.headers.get('stripe-signature'),env.get('STRIPE_WEBHOOK_SECRET'))).valid)return json({error:'Invalid signature.'},400);
 let event;try{event=JSON.parse(raw);}catch{return json({error:'Invalid event.'},400);}
 if(!event?.id||!Number.isFinite(event.created)||event.livemode!==false)return json({error:'Invalid event or live billing disabled.'},400);
 if(!supported.has(event.type)&&!RISK_EVENTS.has(event.type))return json({received:true,handled:false}); // checkout completion never grants access
 const object=event.data?.object;let customerId=event.type==='customer.deleted'?object?.id:typeof object?.customer==='string'?object.customer:object?.customer?.id;
 let events,claim;
 try{
  const stripe=stripeClient(env);if(RISK_EVENTS.has(event.type))customerId=(await riskCustomer(event,stripe)).customerId;
  const mapping=await getStore('samvit-billing-customers').get(customerId,{type:'json',consistency:'strong'});if(!mapping)return json({received:true,handled:false});
  const account=await getStore('samvit-accounts').get('account:'+mapping.accountId,{type:'json',consistency:'strong'});if(!account||account.deleting)return json({received:true,handled:false});
  const user=await getStore('samvit-users').get('user:'+mapping.accountId,{type:'json',consistency:'strong'});
  if(user?.ownerAccountId!==mapping.accountId||user.stripeCustomerId!==customerId)throw new Error('Billing ownership mismatch');
  events=getStore(BILLING_EVENTS_STORE_NAME);claim=await claimBillingEventForProcessing(events,event.id,{accountId:mapping.accountId,eventType:event.type});
  if(!claim.claimed)return claim.status==='applied'?json({received:true,duplicate:true}):json({error:'Event processing; retry.'},409);
  if(RISK_EVENTS.has(event.type))await reconcilePaymentRisk({accountId:mapping.accountId,customerId,event,stripe});
  await reconcileBilling({store:getStore(SUBSCRIPTION_STORE_NAME),accountId:mapping.accountId,customerId,event,stripe:stripeClient(env),priceMap:priceMap(env),student:await getStudentRecord(mapping.accountId),couponId:studentDiscountCoupon(env)});
  if(!await markBillingEventApplied(events,event.id,claim.etag))throw new Error('Event settlement failed');
  return json({received:true,handled:true});
 }catch{if(claim?.claimed)try{await markBillingEventFailed(events,event.id,claim.etag);}catch{}return json({error:'Billing reconciliation unavailable; retry.'},503);}
};
export const config={path:'/api/billing-webhook'};export {BILLING_EVENT_TYPES};
