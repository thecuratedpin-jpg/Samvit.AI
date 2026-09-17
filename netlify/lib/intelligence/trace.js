// ==========================================================================
// SAMVIT V11 — MISSION OBSERVABILITY (Phase 10) + COMPLETION NOTIFICATIONS (Phase 8)
// --------------------------------------------------------------------------
// A mission trace that is useful to a human: what was planned, which model
// and tool were chosen, what was observed, what verification concluded, and
// why the system retried or replanned.
//
// HARD RULE: this module never exposes hidden chain-of-thought. Two
// mechanisms enforce that rather than relying on discipline:
//
//   1. `traceEntry()` only ever emits the fixed field set below. Anything a
//      caller passes that is not in that set is dropped.
//   2. `scrub()` recursively deletes any key that looks like internal
//      reasoning, as a second line of defence if a caller passes a raw
//      provider object through by mistake.
//
// What the user gets instead is a *reasoning summary*: the observable
// decisions and their outcomes, which is auditable and is what the brief
// asks for.
// ==========================================================================
import {LEVEL_NAMES} from './permissions.js';

export const TRACE_LIMIT = 160;
export const TRACE_KINDS = Object.freeze(['plan', 'task', 'model', 'tool', 'action', 'observation', 'verification', 'retry', 'status', 'safety', 'experience']);

// Field set a trace entry may carry. Everything else is discarded.
const ALLOWED_FIELDS = Object.freeze(['at', 'kind', 'status', 'tool', 'model', 'provider', 'action', 'level', 'levelName', 'task', 'reason', 'latencyMs', 'estimatedMicroUsd', 'usage', 'attempt', 'note']);

const FORBIDDEN_KEY = /^(reasoning|reasoning_content|thought|thoughts|thinking|chain_of_thought|chainofthought|scratchpad|cot|internal_monologue|hidden)$/i;

/** Recursively strip anything that looks like internal reasoning. */
export function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) continue;
      out[key] = scrub(item);
    }
    return out;
  }
  return value;
}

const short = (value, max) => (value === undefined || value === null ? null : String(value).slice(0, max));

/** Normalise one trace entry to the fixed, bounded, chain-of-thought-free shape. */
export function traceEntry(entry = {}, now = Date.now()) {
  const clean = scrub(entry);
  const output = {};
  for (const field of ALLOWED_FIELDS) if (clean[field] !== undefined) output[field] = clean[field];
  const kind = TRACE_KINDS.includes(output.kind) ? output.kind : 'action';
  return {
    at: Number.isFinite(output.at) ? output.at : now,
    kind,
    status: short(output.status, 32),
    tool: short(output.tool, 64),
    model: short(output.model, 120),
    provider: short(output.provider, 32),
    action: short(output.action, 80),
    level: Number.isInteger(output.level) ? output.level : null,
    levelName: LEVEL_NAMES.includes(output.levelName) ? output.levelName : null,
    task: short(output.task, 32),
    reason: short(output.reason, 160),
    latencyMs: Number.isFinite(output.latencyMs) ? Math.max(0, Math.round(output.latencyMs)) : null,
    estimatedMicroUsd: Number.isFinite(output.estimatedMicroUsd) ? Math.max(0, Math.round(output.estimatedMicroUsd)) : null,
    attempt: Number.isInteger(output.attempt) ? output.attempt : null,
    note: short(output.note, 240)
  };
}

/** Append to a bounded trace. Pure: returns the new array. */
export function appendTrace(trace, entry, now = Date.now()) {
  const rows = Array.isArray(trace) ? trace : [];
  return [...rows, traceEntry(entry, now)].slice(-TRACE_LIMIT);
}

/**
 * Structured, user-facing account of a mission.
 * This is the single source for both the mission-trace panel and the
 * completion notification, so the two can never disagree.
 */
export function summarizeMission(job = {}) {
  const trace = Array.isArray(job.trace) ? job.trace : [];
  const tasks = Array.isArray(job.tasks) ? job.tasks : [];
  const models = [...new Set(trace.filter(e => e.kind === 'model' && e.model).map(e => e.model))];
  const tools = [...new Set(trace.filter(e => e.kind === 'tool' && e.tool).map(e => e.tool))];
  const actions = trace.filter(e => e.kind === 'action' || e.kind === 'tool');
  const retries = trace.filter(e => e.kind === 'retry' || e.status === 'retry');
  const failures = tasks.filter(task => task.status === 'failed');
  const completedTasks = tasks.filter(task => task.status === 'completed');

  const warnings = [];
  if (failures.length) warnings.push(`${failures.length} subtask(s) did not complete`);
  if ((job.replans || 0) > 0) warnings.push(`Replanned ${job.replans} time(s) after a failed step`);
  if (job.verification?.status && !['verified', 'reviewed'].includes(job.verification.status)) warnings.push(`Verification status: ${job.verification.status}`);
  if (job.status === 'partial') warnings.push('Some objectives were left unresolved');
  // Phase 9: a promised environment change that was never observed is a
  // concrete, verifiable failure — surfaced rather than buried.
  const environment = job.verification?.environment || null;
  if (environment?.status === 'unresolved') warnings.push(`${environment.missing?.length || 0} promised file change(s) were not observed in the environment`);
  if (environment?.unexpected?.length) warnings.push(`${environment.unexpected.length} environment change(s) were not requested by any action`);

  return {
    requested: short(job.goal, 4000),
    projectId: job.projectId || null,
    finalStatus: job.status || 'unknown',
    plan: {
      phases: job.spec?.phases || [],
      subMissions: job.spec?.sub_missions || [],
      strategy: job.spec?.strategy || 'single',
      complexity: job.spec?.complexity || null,
      risk: job.spec?.risk || null,
      successCriteria: Array.isArray(job.spec?.success_criteria) ? job.spec.success_criteria : [],
      tasks: tasks.map(task => ({id: task.id, kind: task.kind, status: task.status, attempts: task.attempts || 0, capability: task.capability || null, dependencies: task.dependencies || [], error: short(task.error, 300)}))
    },
    progress: {tasks: tasks.length, completed: completedTasks.length, failed: failures.length},
    models,
    tools,
    actions: actions.slice(-40).map(e => ({at: e.at, kind: e.kind, action: e.action, tool: e.tool, status: e.status, levelName: e.levelName, reason: e.reason})),
    verification: job.verification || {status: 'unverified'},
    environment,
    retries: retries.slice(-10).map(e => ({at: e.at, reason: e.reason, status: e.status})),
    budget: {modelCalls: job.modelCalls || 0, toolCalls: job.toolCalls || 0, spentUsd: Number(((job.spentMicroUsd || 0) / 1e6).toFixed(6)), activeMs: job.activeMs || 0},
    warnings,
    output: short(job.output, 20000),
    // Truthful by construction: a mission is only "verified" when a verifier
    // task actually produced a verification record. File operations are the
    // one thing checked against real state, so they are reported separately
    // and never used to inflate the mission-level claim.
    evidence: {verificationRecords: Array.isArray(job.verification?.reports) ? job.verification.reports.length : 0, independentlyProven: job.verification?.independentlyProven === true, environmentIndependentlyProven: environment?.independentlyProven === true}
  };
}

/**
 * Concise prose summary for the user. Never claims success without the
 * evidence the mission itself recorded.
 */
export function reasoningSummary(job = {}) {
  const summary = summarizeMission(job);
  const lines = [`Goal: ${summary.requested || '(none recorded)'}`];
  if (summary.plan.tasks.length) {
    lines.push(`Plan: ${summary.plan.tasks.length} task(s) via ${summary.plan.strategy} strategy (${summary.plan.complexity || 'unclassified'}).`);
  }
  lines.push(`Progress: ${summary.progress.completed}/${summary.progress.tasks} task(s) completed.`);
  if (summary.models.length) lines.push(`Models used: ${summary.models.join(', ')}.`);
  if (summary.tools.length) lines.push(`Tools used: ${summary.tools.join(', ')}.`);
  if (summary.retries.length) lines.push(`Recovery: retried or replanned ${summary.retries.length} time(s).`);
  lines.push(`Verification: ${summary.verification.status}${summary.evidence.independentlyProven ? ' (independently proven)' : ' (not independently proven)'}.`);
  if (summary.environment) {
    const env = summary.environment;
    lines.push(`Environment: ${env.checked} change(s) checked against real state, ${env.matched} confirmed${env.missing?.length ? `, ${env.missing.length} not observed` : ''}${summary.evidence.environmentIndependentlyProven ? ' (independently proven)' : ''}.`);
  }
  for (const warning of summary.warnings) lines.push(`Warning: ${warning}.`);
  lines.push(`Outcome: ${summary.finalStatus}.`);
  return lines.join('\n');
}

/**
 * Phase 8 completion notification: what was requested, what completed,
 * what changed, what failed, and how it was verified.
 */
export function completionNotification(job = {}) {
  const summary = summarizeMission(job);
  const headline = {
    completed: 'Mission completed',
    partial: 'Mission finished with unresolved work',
    failed: 'Mission needs attention',
    cancelled: 'Mission cancelled',
    paused: 'Mission paused',
    running: 'Mission still running',
    queued: 'Mission queued'
  }[summary.finalStatus] || 'Mission updated';

  const changes = summary.actions
    .filter(entry => entry.kind === 'tool' && entry.status === 'completed')
    .map(entry => entry.tool)
    .filter(Boolean);
  const uniqueChanges = [...new Set(changes)].slice(0, 8);

  return {
    headline,
    requested: summary.requested,
    completed: `${summary.progress.completed} of ${summary.progress.tasks} planned task(s) completed`,
    changes: uniqueChanges,
    failures: summary.plan.tasks.filter(task => task.status === 'failed').map(task => ({id: task.id, error: task.error})),
    warnings: summary.warnings,
    verification: summary.verification.status,
    verified: ['verified', 'reviewed'].includes(summary.verification.status),
    environment: summary.environment
      ? {status: summary.environment.status, checked: summary.environment.checked, matched: summary.environment.matched, missing: summary.environment.missing?.length || 0, independentlyProven: summary.evidence.environmentIndependentlyProven}
      : null,
    spendUsd: summary.budget.spentUsd,
    finalStatus: summary.finalStatus,
    // Stated explicitly so a notification can never imply more than the
    // mission actually established. File operations are the one thing checked
    // against real state, so that distinction is spelled out rather than
    // rounded up into a general "verified" claim.
    honestCaveat: summary.evidence.independentlyProven
      ? null
      : summary.evidence.environmentIndependentlyProven
        ? 'File operations were verified against real state; the model-written content itself was not independently proven.'
        : 'Model review is not a guarantee of correctness; this result was not independently proven.'
  };
}
