import {accountStore} from '../lib/storage/accounts.js';
// ==========================================================================
// SAMVIT — /api/analytics
// --------------------------------------------------------------------------
//   GET /api/analytics                real usage/cost/health, last 7 days
//
// Backs the frontend's Provider Analytics panel with real numbers written
// by orchestrator.js on every chat/council/workflow call — not a mockup.
// Labeled everywhere it's shown: costs are approximate (see providers.js
// estimateCostUsd), and this is a rolling counter, not a metrics platform.
// ==========================================================================
import { getStore } from "@netlify/blobs";
import { requireSession } from "../lib/security.js";
import { getUsageSummary, getHealthSnapshot } from "../lib/orchestrator.js";

const envAdapter = { get: (k) => process.env[k] };

export default async (req) => {
  const auth = await requireSession(req, envAdapter);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const store = accountStore("samvit-analytics",auth.accountId);
  const url = new URL(req.url);
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 7));

  const [usage, health] = await Promise.all([getUsageSummary(store, { days }), getHealthSnapshot(store)]);

  return json({
    windowDays: days,
    usageByProvider: usage,
    healthByProvider: health,
    note: "Approximate, self-reported usage from Samvit's own request logging — not verified against your provider's billing dashboard.",
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export const config = { path: "/api/analytics" };
