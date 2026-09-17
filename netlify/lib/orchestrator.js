// ==========================================================================
// SAMVIT — PROVIDER ORCHESTRATOR (usage + health tracking)
// --------------------------------------------------------------------------
// Real, lightweight usage/cost/health tracking backed by Netlify Blobs.
// This is intentionally NOT a claim to be a full observability platform —
// it's a per-provider rolling counter, which is what's honestly achievable
// without standing up a real metrics backend. Read by analytics.mjs and
// surfaced in the frontend's Provider Analytics panel, clearly labeled as
// self-reported and approximate (see providers.js estimateCostUsd).
//
// Retry/backoff and fallback-across-providers live in providers.js
// (streamFromProviderWithRetry) and chat.js/council.js (candidate list).
// This module's job is strictly recording what happened, not deciding what
// to call — keeping "decide" and "record" separate is what makes both
// independently testable.
//
// v4 Priority 6 (storage concurrency): this is the file the brief's OWN
// canonical unsafe-pattern example (`const data = await get(key); data.
// count++; await set(key, data);`) describes almost verbatim — recordUsage()
// and recordHealthPing() literally read a shared day/health bucket,
// increment nested counters, and write the whole thing back, with no
// protection at all. Under this app's REAL concurrency (several chat/
// council/workflow requests completing around the same moment, every one
// of them calling recordUsage() against the SAME `usage:YYYY-MM-DD` key),
// this reliably drops increments — not a hypothetical, and exactly
// section 12's "100 simultaneous updates -> Expected: 100 preserved"
// scenario. Fixed via casUpdate() (netlify/lib/storage/concurrency.js),
// the same primitive every other storage call site in this pass now uses.
// The outer try/catch is UNCHANGED and deliberately preserved: this stays
// best-effort ("Analytics must never break the primary request" was
// already the rule, and still is) — a genuine storage conflict/outage here
// still just means one call's usage/health data point didn't get recorded,
// never a failed chat/council/workflow response.
// ==========================================================================
import { casUpdate } from "./storage/concurrency.js";

const USAGE_KEY_PREFIX = "usage";
const HEALTH_KEY = "health";
const MAX_USAGE_DAYS_TRACKED = 30;

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Records one completed (or failed) provider call. Best-effort: a tracking
 * failure must never affect the user-facing response.
 */
export async function recordUsage(store, { provider, model, usage, costUsd, endpoint, error = null }) {
  try {
    const key = `${USAGE_KEY_PREFIX}:${dayKey()}`;
    await casUpdate(store, key, (current) => {
      const day = current || { date: dayKey(), byProvider: {} };
      const bucket = day.byProvider[provider] || { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, byEndpoint: {} };
      bucket.calls += 1;
      if (error) bucket.errors += 1;
      bucket.inputTokens += usage?.inputTokens || 0;
      bucket.outputTokens += usage?.outputTokens || 0;
      bucket.costUsd += costUsd || 0;
      bucket.byEndpoint[endpoint] = (bucket.byEndpoint[endpoint] || 0) + 1;
      day.byProvider[provider] = bucket;
      return day;
    });
    await recordHealthPing(store, provider, !error);
  } catch {
    // Analytics must never break the primary request.
  }
}

/** Rolling last-50-calls success/failure ping per provider, for a simple health indicator. */
async function recordHealthPing(store, provider, ok) {
  try {
    await casUpdate(store, HEALTH_KEY, (current) => {
      const health = current || {};
      const entry = health[provider] || { pings: [] };
      entry.pings = [...entry.pings, { ok, ts: Date.now() }].slice(-50);
      health[provider] = entry;
      return health;
    });
  } catch {
    // Same best-effort contract as recordUsage() -- see this module's own
    // header. recordUsage() also wraps its own call to this in a try/catch,
    // so this inner one is defense in depth, not load-bearing on its own,
    // but keeps recordHealthPing() safe to call independently too.
  }
}

/** Aggregated usage across the last N days (default 7). */
export async function getUsageSummary(store, { days = 7 } = {}) {
  const summary = {};
  const today = new Date();
  for (let i = 0; i < Math.min(days, MAX_USAGE_DAYS_TRACKED); i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = `${USAGE_KEY_PREFIX}:${dayKey(d)}`;
    let dayData;
    try {
      dayData = await store.get(key, { type: "json" });
    } catch {
      dayData = null;
    }
    if (!dayData) continue;
    for (const [provider, bucket] of Object.entries(dayData.byProvider || {})) {
      const agg = summary[provider] || { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      agg.calls += bucket.calls;
      agg.errors += bucket.errors;
      agg.inputTokens += bucket.inputTokens;
      agg.outputTokens += bucket.outputTokens;
      agg.costUsd += bucket.costUsd;
      summary[provider] = agg;
    }
  }
  return summary;
}

/** Simple health snapshot: success rate over the last (up to) 50 calls per provider. */
export async function getHealthSnapshot(store) {
  let health;
  try {
    health = (await store.get(HEALTH_KEY, { type: "json" })) || {};
  } catch {
    health = {};
  }
  const snapshot = {};
  for (const [provider, entry] of Object.entries(health)) {
    const pings = entry.pings || [];
    const okCount = pings.filter((p) => p.ok).length;
    snapshot[provider] = {
      sampleSize: pings.length,
      successRate: pings.length ? Math.round((okCount / pings.length) * 1000) / 10 : null,
      lastPingAt: pings.length ? new Date(pings[pings.length - 1].ts).toISOString() : null,
    };
  }
  return snapshot;
}
