// tests/billing.test.js
import test from 'node:test';
import assert from 'node:assert';
import { normalizeSubscription, PLAN_CAPABILITIES, PLAN_IDS, SUBSCRIPTION_STATUSES } from '../shared/models.js';
import { getDefaultPlanFromEnv, normalizeSubscription as normalizeSub, getSubscription, saveSubscription, SUBSCRIPTION_STORE_NAME, SUBSCRIPTION_SERVICE_UNAVAILABLE_FLAG, isSubscriptionServiceUnavailable } from '../netlify/lib/subscriptions.js';
import { mapStripeEventToSubscriptionInput, BILLING_EVENT_TYPES, verifyStripeSignature, claimBillingEventForProcessing, markBillingEventApplied, markBillingEventFailed, wasBillingEventProcessed, BILLING_EVENT_STATUS } from '../netlify/lib/billing.js';
import { getEntitlements, isSubscriptionActive, planIncludesCouncil, canUseCouncil, getCouncilEntitlements } from '../netlify/lib/entitlements.js';
import { casUpdate } from '../netlify/lib/storage/concurrency.js';
import { getStore } from '@netlify/blobs';

// Mock store for testing
function createMockStore() {
  const data = new Map();
  const metadata = new Map();
  return {
    async get(key, { type } = {}) {
      const value = data.get(key);
      if (value === undefined) return null;
      if (type === 'json') return JSON.parse(value);
      return value;
    },
    async getWithMetadata(key, { type } = {}) {
      const value = data.get(key);
      if (value === undefined) return null;
      const meta = metadata.get(key) || { etag: 'test-etag' };
      if (type === 'json') return { data: JSON.parse(value), etag: meta.etag };
      return { data: value, etag: meta.etag };
    },
    async setJSON(key, value, options = {}) {
      const existing = data.get(key);
      if (options.onlyIfNew && existing !== undefined) {
        return { modified: false };
      }
      if (options.onlyIfMatch) {
        const meta = metadata.get(key);
        if (!meta || meta.etag !== options.onlyIfMatch) {
          return {modified:false};
        }
      }
      const newEtag = `etag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      data.set(key, JSON.stringify(value));
      metadata.set(key, { etag: newEtag });
      return { modified: true, etag: newEtag };
    },
    async delete(key) {
      data.delete(key);
      metadata.delete(key);
    },
    _data: data,
    _metadata: metadata,
  };
}

const mockEnv = {
  get: (key) => {
    if (key === 'SAMVIT_DEFAULT_PLAN_ID') return 'pro';
    if (key === 'SAMVIT_DEFAULT_PLAN_IS_STUDENT') return 'true';
    return undefined;
  }
};

// Shared models tests
test('shared/models - PLAN_CAPABILITIES has all required plans', () => {
  assert.ok(PLAN_CAPABILITIES.free);
  assert.ok(PLAN_CAPABILITIES.pro);
  assert.ok(PLAN_CAPABILITIES.ultra);
  assert.ok(PLAN_CAPABILITIES.ultimate);
});

test('shared/models - PLAN_IDS includes all plans', () => {
  assert.deepStrictEqual(PLAN_IDS.sort(), ['free', 'pro', 'ultra', 'ultimate'].sort());
});

test('shared/models - SUBSCRIPTION_STATUSES includes all statuses', () => {
  assert.deepStrictEqual(SUBSCRIPTION_STATUSES.sort(), ['active', 'canceled', 'past_due'].sort());
});

test('shared/models - normalizeSubscription creates valid subscription', () => {
  const sub = normalizeSubscription({ planId: 'ultra', status: 'active' });
  assert.strictEqual(sub.planId, 'ultra');
  assert.strictEqual(sub.status, 'active');
  assert.ok(sub.id.startsWith('sub_'));
  assert.ok(sub.entitlements.council);
  assert.strictEqual(sub.entitlements.councilCritique, true);
  assert.strictEqual(sub.limits.councilMaxProviders, 4);
});

test('shared/models - normalizeSubscription preserves existing id and createdAt', () => {
  const existing = {
    id: 'sub_existing_123',
    createdAt: '2024-01-01T00:00:00.000Z',
    planId: 'free',
    status: 'active',
  };
  const sub = normalizeSubscription({ planId: 'pro', status: 'active' }, existing);
  assert.strictEqual(sub.id, 'sub_existing_123');
  assert.strictEqual(sub.createdAt, '2024-01-01T00:00:00.000Z');
  assert.strictEqual(sub.planId, 'pro');
});

test('shared/models - normalizeSubscription falls back to free for invalid planId', () => {
  const sub = normalizeSubscription({ planId: 'invalid', status: 'active' });
  assert.strictEqual(sub.planId, 'free');
});

test('shared/models - normalizeSubscription fails closed for invalid status', () => {
  const sub = normalizeSubscription({ planId: 'free', status: 'invalid' });
  assert.strictEqual(sub.status, 'past_due');
});

// Subscriptions tests
test('subscriptions - getDefaultPlanFromEnv reads from env', () => {
  const plan = getDefaultPlanFromEnv(mockEnv);
  assert.strictEqual(plan.planId, 'pro');
  assert.strictEqual(plan.isStudent, true);
});

test('subscriptions - getDefaultPlanFromEnv falls back to free', () => {
  const plan = getDefaultPlanFromEnv({ get: () => undefined });
  assert.strictEqual(plan.planId, 'free');
  assert.strictEqual(plan.isStudent, false);
});

test('subscriptions - getSubscription fails closed when no store', async () => {
  const sub = await getSubscription(null, 'test-account', mockEnv);
  assert.strictEqual(sub.planId, 'free');
  assert.strictEqual(sub.isStudent, false);
});

test('subscriptions - getSubscription marks service unavailable on store error', async () => {
  const failingStore = {
    async get() { throw new Error('Store unavailable'); }
  };
  const sub = await getSubscription(failingStore, 'test-account', mockEnv);
  assert.strictEqual(sub.planId, 'free');
  assert.ok(isSubscriptionServiceUnavailable(sub));
});

test('subscriptions - saveSubscription uses casUpdate', async () => {
  const mockStore = createMockStore();
  const saved = await saveSubscription(mockStore, 'test-account', { planId: 'ultra', status: 'active' });
  assert.strictEqual(saved.planId, 'ultra');
  assert.strictEqual(saved.status, 'active');
});

// Entitlements tests
test('entitlements - isSubscriptionActive returns true for active', () => {
  assert.ok(isSubscriptionActive({ status: 'active' }));
  assert.ok(!isSubscriptionActive({ status: 'past_due' }));
  assert.ok(!isSubscriptionActive({ status: 'canceled' }));
  assert.ok(!isSubscriptionActive(null));
});

test('entitlements - planIncludesCouncil checks entitlements', () => {
  assert.ok(planIncludesCouncil({ entitlements: { council: true } }));
  assert.ok(!planIncludesCouncil({ entitlements: { council: false } }));
  assert.ok(!planIncludesCouncil({}));
});

test('entitlements - canUseCouncil requires both active and council entitlement', () => {
  const activeUltra = { status: 'active', entitlements: { council: true } };
  const pastDueUltra = { status: 'past_due', entitlements: { council: true } };
  const activeFree = { status: 'active', entitlements: { council: false } };
  
  assert.ok(canUseCouncil(activeUltra));
  assert.ok(!canUseCouncil(pastDueUltra));
  assert.ok(!canUseCouncil(activeFree));
});

test('entitlements - getCouncilEntitlements returns zeroed limits when not allowed', () => {
  const ent = getCouncilEntitlements({ status: 'past_due', entitlements: { council: true }, limits: { councilMaxProviders: 4 } });
  assert.strictEqual(ent.council, false);
  assert.strictEqual(ent.maxProviders, 0);
  assert.strictEqual(ent.maxCritiqueRounds, 0);
  
  const allowed = getCouncilEntitlements({ status: 'active', entitlements: { council: true, councilCritique: true }, limits: { councilMaxProviders: 4 } });
  assert.strictEqual(allowed.council, true);
  assert.strictEqual(allowed.councilCritique, true);
  assert.strictEqual(allowed.maxProviders, 4);
  assert.strictEqual(allowed.maxCritiqueRounds, 1);
});

test('entitlements - getEntitlements derives from plan capabilities', () => {
  const ent = getEntitlements('ultra');
  assert.strictEqual(ent.features.council, true);
  assert.strictEqual(ent.features.councilCritique, true);
  assert.strictEqual(ent.features.advanced_analytics, true);
  assert.strictEqual(ent.limits.councilMaxProviders, 4);
});

// Billing tests
test('billing - BILLING_EVENT_TYPES has expected events', () => {
  assert.strictEqual(BILLING_EVENT_TYPES.CHECKOUT_COMPLETED, 'checkout.session.completed');
  assert.strictEqual(BILLING_EVENT_TYPES.SUBSCRIPTION_CREATED, 'customer.subscription.created');
  assert.strictEqual(BILLING_EVENT_TYPES.SUBSCRIPTION_UPDATED, 'customer.subscription.updated');
  assert.strictEqual(BILLING_EVENT_TYPES.SUBSCRIPTION_DELETED, 'customer.subscription.deleted');
  assert.strictEqual(BILLING_EVENT_TYPES.INVOICE_PAYMENT_FAILED, 'invoice.payment_failed');
});

test('billing - mapStripeEventToSubscriptionInput maps subscription created', () => {
  const event = {
    type: BILLING_EVENT_TYPES.SUBSCRIPTION_CREATED,
    data: {
      object: {
        customer: 'cus_test',
        id: 'sub_test',
        status: 'active',
        current_period_start: 1700000000,
        current_period_end: 1700000000 + 86400 * 30,
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_ultra' } }] },
      }
    }
  };
  const input = mapStripeEventToSubscriptionInput(event, { priceIdToPlanId: { price_ultra: 'ultra' } });
  assert.ok(input);
  assert.strictEqual(input.planId, 'ultra');
  assert.strictEqual(input.status, 'active');
  assert.strictEqual(input.externalCustomerId, 'cus_test');
  assert.strictEqual(input.externalSubscriptionId, 'sub_test');
});

test('billing - mapStripeEventToSubscriptionInput maps subscription updated', () => {
  const event = {
    type: BILLING_EVENT_TYPES.SUBSCRIPTION_UPDATED,
    data: {
      object: {
        customer: 'cus_test',
        id: 'sub_test',
        status: 'past_due',
        current_period_start: 1700000000,
        current_period_end: 1700000000 + 86400 * 30,
        cancel_at_period_end: true,
        items: { data: [{ price: { id: 'price_pro' } }] },
      }
    }
  };
  const input = mapStripeEventToSubscriptionInput(event, { priceIdToPlanId: { price_pro: 'pro' } });
  assert.ok(input);
  assert.strictEqual(input.planId, 'pro');
  assert.strictEqual(input.status, 'past_due');
  assert.strictEqual(input.cancelAtPeriodEnd, true);
});

test('billing - mapStripeEventToSubscriptionInput maps subscription deleted', () => {
  const event = {
    type: BILLING_EVENT_TYPES.SUBSCRIPTION_DELETED,
    data: {
      object: {
        customer: 'cus_test',
        id: 'sub_test',
        status: 'canceled',
        current_period_end: 1700000000 + 86400 * 30,
        items: { data: [{ price: { id: 'price_ultra' } }] },
      }
    }
  };
  const input = mapStripeEventToSubscriptionInput(event, { priceIdToPlanId: { price_ultra: 'ultra' } });
  assert.ok(input);
  assert.strictEqual(input.planId, 'ultra');
  assert.strictEqual(input.status, 'canceled');
  assert.strictEqual(input.cancelAtPeriodEnd, undefined);
});

test('billing - mapStripeEventToSubscriptionInput returns null for invoice events', () => {
  const event = {
    type: BILLING_EVENT_TYPES.INVOICE_PAYMENT_FAILED,
    data: { object: {} }
  };
  const input = mapStripeEventToSubscriptionInput(event);
  assert.strictEqual(input, null);
});

test('billing - verifyStripeSignature validates correct signature', async () => {
  const secret = 'whsec_test123';
  const rawBody = '{"id":"evt_test"}';
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const signature = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const signatureHeader = `t=${timestamp},v1=${signature}`;
  
  const result = await verifyStripeSignature(rawBody, signatureHeader, secret);
  assert.strictEqual(result.valid, true);
});

test('billing - verifyStripeSignature rejects invalid signature', async () => {
  const result = await verifyStripeSignature('{"id":"evt_test"}', 't=123,v1=invalid', 'whsec_test');
  assert.strictEqual(result.valid, false);
});

test('billing - claimBillingEventForProcessing claims new event', async () => {
  const store = createMockStore();
  const result = await claimBillingEventForProcessing(store, 'evt_new');
  assert.strictEqual(result.claimed, true);
  assert.ok(result.etag);
});

test('billing - claimBillingEventForProcessing rejects already applied', async () => {
  const store = createMockStore();
  await store.setJSON('evt:evt_applied', { status: 'applied', appliedAt: new Date().toISOString() });
  const result = await claimBillingEventForProcessing(store, 'evt_applied');
  assert.strictEqual(result.claimed, false);
  assert.strictEqual(result.status, 'applied');
});

test('billing - claimBillingEventForProcessing reclaims failed', async () => {
  const store = createMockStore();
  await store.setJSON('evt:evt_failed', { status: 'failed', failedAt: new Date().toISOString() }, { onlyIfNew: true });
  const result = await claimBillingEventForProcessing(store, 'evt_failed');
  assert.strictEqual(result.claimed, true);
});

test('billing - markBillingEventApplied marks as applied', async () => {
  const store = createMockStore();
  await claimBillingEventForProcessing(store, 'evt_mark');
  const result = await markBillingEventApplied(store, 'evt_mark');
  assert.strictEqual(result, true);
  const check = await wasBillingEventProcessed(store, 'evt_mark');
  assert.strictEqual(check, true);
});

test('billing - markBillingEventFailed marks as failed', async () => {
  const store = createMockStore();
  await claimBillingEventForProcessing(store, 'evt_fail');
  const result = await markBillingEventFailed(store, 'evt_fail');
  assert.strictEqual(result, true);
  const check = await wasBillingEventProcessed(store, 'evt_fail');
  assert.strictEqual(check, false);
});

// Storage concurrency tests
test('storage - casUpdate handles concurrent updates', async () => {
  const store = createMockStore();
  await store.setJSON('counter', { count: 0 });
  
  // Simulate concurrent increments
  const results = await Promise.all(
    Array(10).fill().map(() => casUpdate(store, 'counter', (current) => {
      const data = current || {count:0};
      return {count:data.count+1};
    }))
  );
  
  const final = await store.get('counter', { type: 'json' });
  assert.strictEqual(final.count, 10);
});

test('storage - stale conditional writes do not overwrite newer data', async () => {
  const store=createMockStore();await store.setJSON('key',{value:1});
  const old=await store.getWithMetadata('key');
  await casUpdate(store,'key',()=>({value:2}));
  assert.strictEqual((await store.setJSON('key',{value:3},{onlyIfMatch:old.etag})).modified,false);
  assert.strictEqual((await store.get('key',{type:'json'})).value,2);
});

// Edge case tests
test('entitlements - getEntitlements handles unknown plan', () => {
  const ent = getEntitlements('unknown');
  assert.strictEqual(ent.features.council, false);
  assert.strictEqual(ent.limits.councilMaxProviders, 0);
});

test('subscriptions - SUBSCRIPTION_SERVICE_UNAVAILABLE_FLAG is non-enumerable', async () => {
  const sub = await getSubscription(null, 'test', mockEnv);
  const keys = Object.keys(sub);
  assert.ok(!keys.includes(SUBSCRIPTION_SERVICE_UNAVAILABLE_FLAG));
  assert.ok(!keys.includes('_subscriptionServiceUnavailable'));
});

