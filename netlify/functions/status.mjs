import {billingEnabled,priceMap} from '../lib/checkout.js';
import {studentDiscountStatus} from '../lib/student-eligibility.js';
// ==========================================================================
// SAMVIT — /api/status
// --------------------------------------------------------------------------
// Replaces the original prototype's hardcoded "AI Security Guardrails:
// ACTIVE" panel (which was always green regardless of reality) with a
// status endpoint that reports what's ACTUALLY configured. Never returns
// the key values themselves — only whether each is present.
// ==========================================================================
import { getStore } from "@netlify/blobs";
import { requireSession, AUTHENTICATION_UNAVAILABLE } from "../lib/security.js";
import { getModelCatalog, getProviderDiagnostics } from "../lib/providers.js";
import { freeModelCatalog } from "../../shared/catalog.js";
import { getSubscription, SUBSCRIPTION_STORE_NAME } from "../lib/subscriptions.js";
import { getCouncilEntitlements } from "../lib/entitlements.js";
import { PLAN_PRICING, PROVIDER_IDS } from "../../shared/models.js";

const envAdapter = { get: (k) => process.env[k] };

export default async (req) => {
  // v4 Priority 5 (production hardening): this USED TO independently
  // re-derive "is the app open" from `Boolean(ACCESS_CODE)` alone -- its
  // own separate copy of exactly the inference security.js's
  // requireSession() used to make, and that CHANGES-V4-PRIORITIES.md's
  // production-hardening pass fixed there (see isDevelopmentMode()): a
  // production deployment that forgot to set ACCESS_CODE is a
  // misconfiguration, not "intentionally open." Keeping a second,
  // independent copy of that inference here would have silently drifted
  // from the real enforcement path the moment that fix landed -- this
  // endpoint would keep telling the frontend "Council is open, no auth
  // needed" while /api/council itself now fails closed with a 500. Calling
  // requireSession() unconditionally instead means there is exactly ONE
  // place that decides "open vs protected vs misconfigured", and every
  // endpoint (including this reporting one) agrees with it by construction.
  const auth = await requireSession(req, envAdapter);
  const misconfigured = !auth.ok && auth.code === AUTHENTICATION_UNAVAILABLE;
  const protectedApp = !auth.open; // true for both "normal protected mode" and "misconfigured production" -- both fail closed, neither is "open"
  const authenticated = auth.ok;
  const accountId = auth.accountId || null;

  // v4 Priority 5: real, server-computed Council entitlements -- read-only
  // here (this is the UI-convenience surface the brief's section 7 calls
  // for), never re-derived on the frontend. Three distinct shapes, not
  // one reused default, so this stays honest in each case:
  //  - unenforced (open mode): Council genuinely IS usable -- matches
  //    council.js's real `auth.open` bypass.
  //  - not authenticated yet (protected mode): fails closed to "no
  //    entitlements" in the DISPLAY too, not just in enforcement --
  //    boot.js never actually reaches the Council UI in this state (the
  //    access-gate screen shows instead), but this endpoint shouldn't
  //    claim Council access for a caller it can't identify regardless.
  //  - authenticated (protected mode): the real computed answer, below.
  let subscription = protectedApp
    ? { enforced: true, planId: null, isStudent: false, entitlements: { council: false, councilCritique: false }, limits: { councilMaxProviders: 0 } }
    : { enforced: false, planId: null, isStudent: false, entitlements: { council: true, councilCritique: true }, limits: { councilMaxProviders: PROVIDER_IDS.length } };
  if (protectedApp && authenticated && accountId) {
    // getStore() itself throws synchronously if Blobs isn't available --
    // guard it the same way council.js does. A missing/broken store still
    // resolves to a real answer: getSubscription() fails closed to the
    // env-configured default plan on an undefined/broken store (see its
    // own comment), it never throws.
    let store;
    try { store = getStore(SUBSCRIPTION_STORE_NAME); } catch { /* getSubscription() below fails closed on an undefined store */ }
    const record = await getSubscription(store, accountId, envAdapter);
    const entitlements = getCouncilEntitlements(record);
    subscription = {
      enforced: true,
      planId: record.planId,
      status: record.status,
      teamSize: record.limits.teamSize,
      isStudent: record.isStudent,
      entitlements: { council: entitlements.council, councilCritique: entitlements.councilCritique },
      limits: { councilMaxProviders: entitlements.maxProviders },
    };
  }

  const providers = {
    claude: Boolean(envAdapter.get("ANTHROPIC_API_KEY")),
    openai: Boolean(envAdapter.get("OPENAI_API_KEY")),
    gemini: Boolean(envAdapter.get("GEMINI_API_KEY")),
    grok: Boolean(envAdapter.get("XAI_API_KEY")),
  };
  const configuredCount = Object.values(providers).filter(Boolean).length;

  return new Response(
    JSON.stringify({
      protectedApp,
      authenticated,
      account: authenticated ? {id:accountId,email:auth.email,role:auth.role,emailVerified:auth.emailVerified} : null,
      providers,
      configuredCount,
      rateLimitPerMinute: Number(envAdapter.get("RATE_LIMIT_PER_MINUTE")) || 20,
      councilRateLimitPerMinute: Number(envAdapter.get("RATE_LIMIT_COUNCIL_PER_MINUTE")) || 5,
      modelCatalog: getModelCatalog(),
      freeModelCatalog: freeModelCatalog(),
      providerDiagnostics: getProviderDiagnostics(envAdapter),
      subscription,
      planPricing: PLAN_PRICING,
      billing: {enabled:billingEnabled(envAdapter), mode:"test", prices:billingEnabled(envAdapter) ? priceMap(envAdapter) : {}, studentDiscount:await studentDiscountStatus(accountId,envAdapter)},
    }),
    { status: 200, headers: { "content-type": "application/json", "cache-control":"no-store" } }
  );
};

export const config = { path: "/api/status" };
