import {beginCheckout,finishCheckout} from '../lib/checkout-session.js';
import {ownBillingAccount,bindCustomer} from '../lib/billing-ownership.js';
import {getStudentRecord} from '../lib/student-eligibility.js';
import {retrieveCustomerSubscriptions} from '../lib/billing-reconciliation.js';
import {getStore} from '@netlify/blobs';
import {requireSession} from '../lib/security.js';
import {nodeEnv as env,billingEnabled,validateCheckout,stripeClient} from '../lib/checkout.js';
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export default async request=> {
  if(request.method!=='POST') return json({error:'Method not allowed'},405);
  const auth=await requireSession(request,env);if(!auth.ok) return json({error:auth.message},auth.status);
  if(!billingEnabled(env)) return json({error:'Checkout is disabled. This release supports owner-operated Stripe test mode only.'},501);
  if(auth.open)return json({error:'Sign in as the owner of your billing account.'},403);
  let selection;try {selection=validateCheckout({...await request.json(),accountId:auth.accountId},request,env,await getStudentRecord(auth.accountId));} catch(err) {return json({error:err.message},400);}
  try {
    const stripe=stripeClient(env),{store,key,record}=await ownBillingAccount(auth,{create:true});
    let user=record;
    if(!user.stripeCustomerId){const customer=await stripe.customers.create({metadata:{samvitAccountId:auth.accountId}},{idempotencyKey:`samvit-customer-${auth.accountId}`});user=await bindCustomer(store,key,auth.accountId,customer.id);}
    const existing=await retrieveCustomerSubscriptions(stripe,user.stripeCustomerId);
    if(existing.some(s=>!['canceled','incomplete_expired'].includes(s.status)))return json({error:'Manage your existing subscription in the billing portal before starting another.'},409);
    if(selection.coupon){const coupon=await stripe.coupons.retrieve(selection.coupon);if(!coupon.valid||coupon.percent_off!==30||coupon.amount_off||coupon.duration!=='forever'||coupon.applies_to)throw new Error('Student coupon must be a valid unrestricted recurring 30 percent discount');}
    const hold=await beginCheckout(store,key,auth.accountId,selection);if(hold.existing)return json({sessionId:hold.existing.sessionId,url:hold.existing.url});
    const session=await stripe.checkout.sessions.create({
      expires_at:Math.floor(hold.expiresAt/1000),
      customer:user.stripeCustomerId,
      mode:'subscription',
      line_items:[{price:selection.priceId,quantity:1}],
      discounts:selection.coupon ? [{coupon:selection.coupon}] : undefined,
      success_url:selection.successUrl,
      cancel_url:selection.cancelUrl,
      client_reference_id:auth.accountId,
      subscription_data:{metadata:{samvitAccountId:auth.accountId,planId:selection.planId,studentDiscount:selection.studentDiscount ? 'true' : 'false'}}
    },{idempotencyKey:`samvit-checkout-${auth.accountId}-${hold.token}`});
    await finishCheckout(store,key,hold.token,session);
    return json({sessionId:session.id,url:session.url});
  } catch {return json({error:'Checkout is temporarily unavailable.'},503);}
};
export const config={path:'/api/billing/create-checkout'};
