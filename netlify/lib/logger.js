// ==========================================================================
// SAMVIT — STRUCTURED LOGGING
// --------------------------------------------------------------------------
// Real, honest observability for a serverless app: structured JSON lines to
// stdout (which Netlify already captures and shows in the Functions log
// panel — no new infra needed to get real logs), plus an OPTIONAL hook to
// forward errors to Sentry if you set SENTRY_DSN yourself. If SENTRY_DSN
// isn't set, the reporter is a no-op. This deliberately does not draw a
// fake "diagnostic dashboard" — that would be exactly the kind of security
// theater CHANGES.md already removed once.
// ==========================================================================

/**
 * @param {{get(key:string):string|undefined}} env
 * @param {string} scope  e.g. "chat", "auth", "memory"
 */
export function createLogger(env, scope) {
  function line(level, message, fields = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      ...fields,
    };
    const serialized = JSON.stringify(entry);
    if (level === "error") console.error(serialized);
    else if (level === "warn") console.warn(serialized);
    else console.log(serialized);
    return entry;
  }

  return {
    info: (message, fields) => line("info", message, fields),
    warn: (message, fields) => line("warn", message, fields),
    error: (message, fields) => line("error", message, fields),
    /**
     * Reports an error to Sentry via its plain HTTP envelope API — no SDK
     * dependency needed. No-ops if SENTRY_DSN isn't configured. Never
     * throws (a broken error reporter should never break the request).
     */
    async reportError(err, extra = {}) {
      line("error", err?.message || String(err), { stack: err?.stack, ...extra });
      const dsn = env?.get?.("SENTRY_DSN");
      if (!dsn) return;
      try {
        const match = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(.+)$/);
        if (!match) return;
        const [, publicKey, host, projectId] = match;
        const envelopeUrl = `https://${host}/api/${projectId}/envelope/`;
        const eventId = crypto.randomUUID().replace(/-/g, "");
        const header = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() });
        const itemHeader = JSON.stringify({ type: "event" });
        const item = JSON.stringify({
          event_id: eventId,
          timestamp: new Date().toISOString(),
          platform: "javascript",
          level: "error",
          logger: `samvit.${scope}`,
          message: { formatted: err?.message || String(err) },
          exception: err?.stack
            ? { values: [{ type: err.name || "Error", value: err.message, stacktrace: { frames: [] } }] }
            : undefined,
          extra,
        });
        const body = `${header}\n${itemHeader}\n${item}\n`;
        await fetch(envelopeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-sentry-envelope",
            "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=samvit/1.0`,
          },
          body,
        });
      } catch {
        // Reporting failures must never surface to the user.
      }
    },
  };
}
