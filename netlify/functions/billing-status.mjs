import {nodeEnv as env} from '../lib/checkout.js';
// netlify/functions/billing-status.mjs
// Returns current subscription status and entitlements
import { requireSession, DEFAULT_ACCOUNT_ID } from "../lib/security.js";
import { getSubscription, isSubscriptionServiceUnavailable, SUBSCRIPTION_STORE_NAME } from "../lib/subscriptions.js";
import { getEntitlements } from "../lib/entitlements.js";
import { getStore } from "@netlify/blobs";
import { createLogger } from "../lib/logger.js";

export default async (request, context) => {
  const log = createLogger(env, "billing-status");
  
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const auth = await requireSession(request, env);
  if (!auth.ok) {
    return json({ error: auth.message }, auth.status);
  }

  try {
    let subStore;
    try {
      subStore = getStore(SUBSCRIPTION_STORE_NAME);
    } catch (err) {
      log.warn("Subscription store unavailable", { error: err?.message });
    }

    const sub = await getSubscription(subStore, auth.accountId, env);
    if(isSubscriptionServiceUnavailable(sub))return json({error:'Subscription service is unavailable.'},503);
    const entitlements = sub ? getEntitlements(sub) : null;

    log.debug("Fetched billing status", { planId: sub?.planId, status: sub?.status });
    
    return json({
      subscription: sub ? {
        planId: sub.planId,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        isStudent: sub.isStudent,
      } : null,
      entitlements,
    });
  } catch (err) {
    log.error("Error fetching billing status", { error: err?.message });
    return json({ error: err.message }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control":"no-store" } });
}

export const config = { path: "/api/billing/status" };