import {paymentRisk} from './payment-risk.js';
// Per-user server-side subscriptions. Storage outages always deny paid access.
import { normalizeSubscription, PLAN_IDS } from "../../shared/models.js";
import { casUpdate } from "./storage/concurrency.js";

export const SUBSCRIPTION_STORE_NAME = "samvit-subscription";

function subscriptionKey(accountId) {
  return `sub:${accountId}`;
}

export function getDefaultPlanFromEnv(env) {
  const rawPlanId = env?.get?.("SAMVIT_DEFAULT_PLAN_ID");
  const planId = PLAN_IDS.includes(rawPlanId) ? rawPlanId : "free";
  const rawStudent = env?.get?.("SAMVIT_DEFAULT_PLAN_IS_STUDENT");
  const isStudent = rawStudent === "true" || rawStudent === "1";
  return { planId, isStudent };
}

export async function getSubscription(store, accountId, env) {
  try {
    if(!store||!accountId)throw new Error('Subscription storage or identity unavailable');
    const record=await store.get(subscriptionKey(accountId),{type:'json',consistency:'strong'});
    if(record){const risk=await paymentRisk(accountId);return normalizeSubscription(risk.blocked?{...record,status:'past_due'}:record,record);}
    return normalizeSubscription(accountId==='samvit-user'?getDefaultPlanFromEnv(env):{planId:'free'});
  } catch {
    const fallback=normalizeSubscription({planId:'free',status:'inactive'});
    Object.defineProperty(fallback,SUBSCRIPTION_SERVICE_UNAVAILABLE_FLAG,{value:true,enumerable:false});
    return fallback;
  }
}

export const SUBSCRIPTION_SERVICE_UNAVAILABLE_FLAG = "_subscriptionServiceUnavailable";

export function isSubscriptionServiceUnavailable(subscription) {
  return Boolean(subscription?.[SUBSCRIPTION_SERVICE_UNAVAILABLE_FLAG]);
}

export async function saveSubscription(store, accountId, input) {
  const key = subscriptionKey(accountId);
  const { value } = await casUpdate(store, key, (current) => {
    if (input.billingEventCreated && current?.billingEventCreated > input.billingEventCreated) return current;
    return normalizeSubscription(input, current);
  });
  return value;
}

export { normalizeSubscription };
