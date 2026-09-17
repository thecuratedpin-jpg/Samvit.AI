// ==========================================================================
// SAMVIT — storage error taxonomy (v4 Priority 6: storage concurrency)
// --------------------------------------------------------------------------
// A small, closed set of error types every storage call site in this app
// can throw/catch consistently, instead of each endpoint inventing its own
// ad-hoc "catch and return some object" shape (which is exactly how the
// read-modify-write races this priority fixes went unnoticed for so long —
// there was no single vocabulary for "this failed because of contention"
// vs. "this failed because the store is unreachable" vs. "this failed
// because the record doesn't exist").
//
// Every error carries a safe, generic `.message` — never a stack trace,
// storage credential, or internal key name beyond the record's own public
// id (see brief section 11: "Never return: Stack traces, Storage
// credentials, Internal keys, Secrets"). `.cause` (the real underlying
// error, e.g. a network failure from Blobs) is attached where available
// for server-side logging ONLY — callers must never put `.cause` in an
// HTTP response body.
// ==========================================================================

export class StorageError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

/** A conditional write lost every retry to sustained contention (the CAS
 * equivalent of security.js's checkRateLimit() exhausting its own retry
 * budget) — genuinely unusual under this app's real traffic patterns, not
 * an expected steady-state outcome. The caller should surface a 409 and
 * let the client retry the whole operation (re-fetch + re-submit), not
 * silently drop the write or silently overwrite. */
export class StorageConflictError extends StorageError {
  constructor(message, options) {
    super("STORAGE_CONFLICT", message, options);
    this.name = "StorageConflictError";
  }
}

/** The store itself could not be read from or written to (Blobs
 * unreachable, threw, etc.) — distinct from "no such record" (see
 * StorageNotFoundError) and from "contention" (see StorageConflictError).
 * The caller should surface a 503 — this is a transient infrastructure
 * problem, not a client mistake. */
export class StorageUnavailableError extends StorageError {
  constructor(message, options) {
    super("STORAGE_UNAVAILABLE", message, options);
    this.name = "StorageUnavailableError";
  }
}

/** The record a caller tried to update/delete genuinely doesn't exist —
 * either it never did, or it was deleted (possibly concurrently, by a
 * request that's exactly what this priority's "update vs delete" section
 * cares about getting right: a stale update must not resurrect a deleted
 * record — see index-list.js / each endpoint's PUT handler). The caller
 * should surface a 404. */
export class StorageNotFoundError extends StorageError {
  constructor(message, options) {
    super("STORAGE_NOT_FOUND", message, options);
    this.name = "StorageNotFoundError";
  }
}

/** An idempotency check found this operation already in progress or
 * already completed, and the caller specifically needs a THIRD outcome
 * beyond plain success/failure to handle it correctly (contrast with
 * StorageConflictError, which means "retry the whole read-modify-write";
 * this means "someone else's read-modify-write already covers this,
 * intentionally do nothing more"). Not used by the generic casUpdate()
 * primitive itself — reserved for call sites layering an explicit
 * idempotency key on top of storage, matching brief section 5. */
export class IdempotencyConflictError extends StorageError {
  constructor(message, options) {
    super("IDEMPOTENCY_CONFLICT", message, options);
    this.name = "IdempotencyConflictError";
  }
}

/** Maps a StorageError to the HTTP status an endpoint should return.
 * Returns `null` for anything that ISN'T one of this module's error
 * types, so callers can tell "a storage error I know how to handle" apart
 * from "an unexpected bug that should propagate/500, not be silently
 * swallowed as if it were a routine storage failure." */
export function storageErrorStatus(err) {
  if (err instanceof StorageConflictError) return 409;
  if (err instanceof StorageNotFoundError) return 404;
  if (err instanceof IdempotencyConflictError) return 409;
  if (err instanceof StorageUnavailableError) return 503;
  return null;
}
