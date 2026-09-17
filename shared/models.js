import {TEAM_SIZES} from './teams.js';
// ==========================================================================
// SAMVIT — SHARED MODELS (v3 + v4 Priority 3 + v4 Priority 5 billing)
// --------------------------------------------------------------------------
// Canonical, single-source-of-truth TypeScript-free shapes used by BOTH
// edge functions (Deno) AND regular functions (Node) without a build step.
// Every field here is intentional; nothing is auto-generated.
// ==========================================================================

// -------------------------------------------------------------------------
// Provider IDs (v3) - the closed set this app knows how to talk to
// -------------------------------------------------------------------------
export const PROVIDER_IDS = ["claude", "openai", "gemini", "grok", "samvit"];

// -------------------------------------------------------------------------
// Subscription / Plan data model (v4 Priority 3 + v4 Priority 5 billing)
// -------------------------------------------------------------------------

export const PLAN_IDS = ["free", "pro", "ultra", "ultimate"];
export const SUBSCRIPTION_STATUSES = ["active", "past_due", "canceled"];
export const STUDENT_DISCOUNT_PERCENT = 30;

/**
 * Normalizes a raw subscription record (from storage, from a Stripe webhook
 * mapping, or from the operator's default-plan env vars) into the exact
 * shape the rest of the app expects. Call this EVERY time you read or write
 * a subscription -- it re-derives entitlements/limits/pricing from the
 * CURRENT PLAN_CAPABILITIES below, so a plan definition change instantly
 * applies to all existing records without a migration.
 *
 * @param {object} input  The raw record (may be partial, may have legacy keys)
 * @param {object} [existing]  The previously stored record, if any -- used
 *   to preserve `id` and `createdAt` across re-normalizations. If omitted,
 *   a new `id` is generated and `createdAt` is set to now.
 * @returns {object} A fully-populated, normalized Subscription record.
 */
export function normalizeSubscription(input = {}, existing = {}) {
  existing ||= {};
  const now = new Date().toISOString();
  const rawPlan = input.planId ?? existing.planId;
  const planId = PLAN_IDS.includes(rawPlan) ? rawPlan : "free";
  const rawStatus = input.status ?? existing.status ?? "active";
  const status = SUBSCRIPTION_STATUSES.includes(rawStatus) ? rawStatus : "past_due";
  const isStudent = typeof input.isStudent === "boolean" ? input.isStudent : Boolean(existing.isStudent);
  const externalCustomerId = input.externalCustomerId || existing.externalCustomerId || null;
  const externalSubscriptionId = input.externalSubscriptionId || existing.externalSubscriptionId || null;
  const currentPeriodStart = input.currentPeriodStart || existing.currentPeriodStart || now;
  const currentPeriodEnd = input.currentPeriodEnd || existing.currentPeriodEnd || null;
  const cancelAtPeriodEnd = typeof input.cancelAtPeriodEnd === "boolean" ? input.cancelAtPeriodEnd : (existing.cancelAtPeriodEnd ?? false);
  const source = input.source || existing.source || "config";

  // Re-derive everything from the current PLAN_CAPABILITIES for this planId
  // This is the single place "what does plan X unlock" lives.
  const caps = PLAN_CAPABILITIES[planId] || PLAN_CAPABILITIES.free;

  return {
    id: existing.id || `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    planId,
    status,
    isStudent,
    externalCustomerId,
    externalSubscriptionId,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd,
    source,
    billingEventCreated: input.billingEventCreated ?? existing.billingEventCreated ?? 0,
    // --- Derived capabilities (computed here, not stored separately) ---
    entitlements: {
      agentTeams: TEAM_SIZES[planId] > 0,
      council: caps.entitlements.council,
      councilCritique: caps.entitlements.councilCritique,
      advancedAnalytics: caps.entitlements.advancedAnalytics,
    },
    limits: {
      teamSize: TEAM_SIZES[planId],
      councilMaxProviders: caps.limits.councilMaxProviders,
      monthlyInputTokens: caps.limits.monthlyInputTokens,
      monthlyOutputTokens: caps.limits.monthlyOutputTokens,
      monthlySpendUsd: caps.limits.monthlySpendUsd,
    },
    pricing: {
      monthlyUsd: caps.pricing.monthlyUsd,
      studentMonthlyUsd: caps.pricing.studentMonthlyUsd,
    },
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

/**
 * Plan capability catalog -- THE authoritative source for what each plan
 * unlocks. If you change a plan's features/limits/pricing, do it HERE.
 * The rest of the app (normalizeSubscription, entitlements.js,
 * council-access.js, the frontend billing display) derives from this.
 */
export const PLAN_CAPABILITIES = {
  free: {
    name: "Free",
    entitlements: {
      council: false,
      councilCritique: false,
      advancedAnalytics: false,
    },
    limits: {
      councilMaxProviders: 0,
      monthlyInputTokens: 10_000,
      monthlyOutputTokens: 10_000,
      monthlySpendUsd: 0,
    },
    pricing: { monthlyUsd: 0, studentMonthlyUsd: 0, studentDiscountPercent: 0 },
  },
  pro: {
    name: "Pro",
    entitlements: {
      council: false,
      councilCritique: false,
      advancedAnalytics: true,
    },
    limits: {
      councilMaxProviders: 0,
      monthlyInputTokens: 100_000,
      monthlyOutputTokens: 100_000,
      monthlySpendUsd: 10,
    },
    pricing: { monthlyUsd: 10, studentMonthlyUsd: 7, studentDiscountPercent: STUDENT_DISCOUNT_PERCENT },
  },
  ultra: {
    name: "Ultra",
    entitlements: {
      council: true,
      councilCritique: true,
      advancedAnalytics: true,
    },
    limits: {
      councilMaxProviders: 4,
      monthlyInputTokens: 500_000,
      monthlyOutputTokens: 500_000,
      monthlySpendUsd: 50,
    },
    pricing: { monthlyUsd: 50, studentMonthlyUsd: 35, studentDiscountPercent: STUDENT_DISCOUNT_PERCENT },
  },
  ultimate: {
    name: "Ultimate",
    entitlements: {
      council: true,
      councilCritique: true,
      advancedAnalytics: true,
    },
    limits: {
      councilMaxProviders: 4,
      monthlyInputTokens: 2_000_000,
      monthlyOutputTokens: 2_000_000,
      monthlySpendUsd: 200,
    },
    pricing: { monthlyUsd: 200, studentMonthlyUsd: 140, studentDiscountPercent: STUDENT_DISCOUNT_PERCENT },
  },
};

// -------------------------------------------------------------------------
// Memory / Project / Mission shapes (v3)
// -------------------------------------------------------------------------

/** Normalizes a raw memory record to the canonical shape. */
export function normalizeMemory(input, existing = {}) {
  existing ||= {};
  const now = new Date().toISOString();
  return {
    id: existing.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text: typeof (input.text ?? input.content) === "string" ? (input.text ?? input.content).slice(0, 5000) : "",
    content: typeof (input.text ?? input.content) === "string" ? (input.text ?? input.content).slice(0, 5000) : "",
    category: ["EPISODIC", "SEMANTIC", "PREFERENCES", "PROJECT", "TASK"].includes(input.category) ? input.category : "EPISODIC",
    pinned: Boolean(input.pinned),
    archived: Boolean(input.archived),
    timestamp: existing.timestamp || now,
    tags: Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === "string").slice(0, 10) : [],
    projectId: typeof input.projectId === "string" ? input.projectId : (existing.projectId || null),
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

/** Normalizes a raw project record to the canonical shape. */
export function normalizeProject(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || `prj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: typeof input.name === "string" ? input.name.slice(0, 120) : "Untitled Project",
    description: typeof input.description === "string" ? input.description.slice(0, 2000) : "",
    status: ["active", "on-hold", "completed", "archived"].includes(input.status) ? input.status : (existing.status || "active"),
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

/** Normalizes a raw mission record to the canonical shape. */
export function normalizeMission(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || `msn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: typeof input.title === "string" ? input.title.slice(0, 160) : "Untitled Plan",
    goal: typeof input.goal === "string" ? input.goal.slice(0, 5000) : "",
    summary: typeof input.summary === "string" ? input.summary.slice(0, 500) : "",
    provider: typeof input.provider === "string" ? input.provider : "claude",
    status: ["draft", "in-progress", "completed", "archived"].includes(input.status) ? input.status : (existing.status || "draft"),
    steps: Array.isArray(input.steps)
      ? input.steps
          .filter((s) => s && typeof s.title === "string")
          .map((s) => ({
            title: s.title.slice(0, 160),
            detail: typeof s.detail === "string" ? s.detail.slice(0, 500) : "",
            estimatedMinutes: typeof s.estimatedMinutes === "number" && Number.isFinite(s.estimatedMinutes) ? Math.max(0, Math.round(s.estimatedMinutes)) : 0,
            completed: Boolean(s.completed),
          }))
      : [],
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

// -------------------------------------------------------------------------
// Analytics shapes (v3)
// -------------------------------------------------------------------------

/** Normalizes an analytics event for storage. */
export function normalizeAnalyticsEvent(input) {
  return {
    ts: new Date().toISOString(),
    endpoint: typeof input.endpoint === "string" ? input.endpoint : "unknown",
    provider: typeof input.provider === "string" ? input.provider : "unknown",
    model: typeof input.model === "string" ? input.model : null,
    usage: input.usage && typeof input.usage === "object"
      ? {
          promptTokens: typeof input.usage.promptTokens === "number" ? input.usage.promptTokens : 0,
          completionTokens: typeof input.usage.completionTokens === "number" ? input.usage.completionTokens : 0,
          totalTokens: typeof input.usage.totalTokens === "number" ? input.usage.totalTokens : 0,
        }
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costUsd: typeof input.costUsd === "number" && Number.isFinite(input.costUsd) ? input.costUsd : 0,
  };
}
export const PLAN_PRICING = Object.fromEntries(Object.entries(PLAN_CAPABILITIES).map(([id, caps]) => [id, caps.pricing]));
