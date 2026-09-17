import Stripe from 'stripe';
import {PLAN_IDS} from '../../shared/models.js';
import {hasVerifiedStudentEligibility, studentDiscountCoupon} from './student-eligibility.js';
export const nodeEnv={get:key=>process.env[key]};
export function priceMap(env) {
  let map;try {map=JSON.parse(env.get('STRIPE_PRICE_ID_MAP') || '{}');} catch {throw new Error('Invalid price configuration.');}
  if(!map || Array.isArray(map) || typeof map!=='object') throw new Error('Invalid price configuration.');
  return Object.fromEntries(Object.entries(map).filter(([price,plan])=>/^price_[a-zA-Z0-9]+$/.test(price)&&PLAN_IDS.includes(plan)&&plan!=='free'));
}
export function billingEnabled(env) {
  return env.get('SAMVIT_BILLING_ENABLED')==='true' && (env.get('STRIPE_SECRET_KEY') || '').startsWith('sk_test_');
}
export function validateCheckout(payload,request,env,studentRecord=null) {
  const map=priceMap(env);
  if(!payload || !Object.hasOwn(map,payload.priceId)) throw new Error('Select a configured plan price.');
  const accountId=payload.accountId;
  const wantsStudentDiscount=payload.studentDiscount===true;
  if(wantsStudentDiscount && !hasVerifiedStudentEligibility(accountId,studentRecord)) throw new Error('Student discount requires verified eligibility.');
  const coupon=wantsStudentDiscount ? studentDiscountCoupon(env) : null;
  if(wantsStudentDiscount && !coupon) throw new Error('Student discount is not configured for checkout yet.');
  const origin=new URL(request.url).origin;
  if(request.headers.get('origin') && request.headers.get('origin')!==origin) throw new Error('Invalid request origin.');
  return {priceId:payload.priceId,planId:map[payload.priceId],successUrl:`${origin}/?checkout=success#plans`,cancelUrl:`${origin}/#plans`,coupon,studentDiscount:wantsStudentDiscount};
}
export function stripeClient(env) {return new Stripe(env.get('STRIPE_SECRET_KEY'),{apiVersion:'2025-02-24.acacia',timeout:20000,maxNetworkRetries:1});}
