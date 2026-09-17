// ==========================================================================
// SAMVIT V11 — WORLD STATE + EXPERIENCE (Phase 5)
// --------------------------------------------------------------------------
// Memory in v9/v10 answered "what did the user say before?". This module
// answers the other half of the question the brief asks for: "what is true
// about the world Samvit is operating in, and what has actually worked?"
//
// Four layers, kept deliberately separate so they can be aged, bounded and
// trusted differently:
//
//   TRANSIENT  short-lived per-mission context. Never persisted here; it
//              lives on the job record and dies with the mission.
//   DURABLE    facts the user or the system established: projects,
//              environments, constraints, decisions, goals. Upserted by
//              (kind, key), so a fact is corrected rather than duplicated.
//   MISSION    per-mission state. Owned by jobs.js/runtime.js — referenced
//              by id, never copied here, so there is exactly one truth.
//   EXPERIENCE outcomes of past strategies. Aggregated by signature, not
//              appended blindly: 40 identical successes become one row with
//              a count, which is what makes the signal usable for planning.
//
// Nothing is stored blindly: every layer has a hard bound, and experience
// rows carry their own attempt counts so a single lucky run cannot
// masquerade as a proven strategy.
// ==========================================================================
import {accountStore} from '../storage/accounts.js';
import {casUpdate} from '../storage/concurrency.js';

export const WORLD_STORE = 'samvit-world';
export const EXPERIENCE_LIMIT = 60;
export const DURABLE_LIMIT = 120;
export const FACT_KINDS = Object.freeze(['project', 'file', 'environment', 'constraint', 'decision', 'goal', 'tool']);

// A signature is the thing experience is actually about: this kind of task,
// at this complexity, attempted with this strategy.
export const experienceSignature = ({capability = 'general', complexity = 'moderate', strategy = 'single'} = {}) =>
  `${String(capability).slice(0, 32)}:${String(complexity).slice(0, 32)}:${String(strategy).slice(0, 32)}`;

const clampText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

// --------------------------------------------------------------------------
// Pure reducers — exported so the aggregation rules are directly testable
// --------------------------------------------------------------------------

/** Fold one mission outcome into the aggregate row for its signature. */
export function mergeExperience(current, entry = {}) {
  const signature = entry.signature || experienceSignature(entry);
  const rows = Array.isArray(current?.rows) ? current.rows : [];
  const index = rows.findIndex(row => row.signature === signature);
  const outcome = ['success', 'partial', 'failure'].includes(entry.outcome) ? entry.outcome : 'failure';
  const score = Number.isFinite(entry.score) ? Math.max(0, Math.min(1, entry.score)) : outcome === 'success' ? 1 : 0;

  const base = index >= 0 ? rows[index] : {signature, attempts: 0, successes: 0, partials: 0, failures: 0, totalScore: 0, models: {}, tools: {}};
  const next = {
    ...base,
    attempts: base.attempts + 1,
    successes: base.successes + (outcome === 'success' ? 1 : 0),
    partials: base.partials + (outcome === 'partial' ? 1 : 0),
    failures: base.failures + (outcome === 'failure' ? 1 : 0),
    totalScore: base.totalScore + score,
    models: {...base.models},
    tools: {...base.tools},
    capability: clampText(entry.capability || signature.split(':')[0], 32),
    complexity: clampText(entry.complexity || signature.split(':')[1], 32),
    strategy: clampText(entry.strategy || signature.split(':')[2], 32),
    lastOutcome: outcome,
    lastAt: Date.now(),
    firstAt: base.firstAt || Date.now()
  };
  // Credit only the model that actually carried a successful step, so a
  // failing model does not accumulate a reputation from other models' work.
  if (entry.model) next.models[clampText(entry.model, 120)] = (base.models?.[clampText(entry.model, 120)] || 0) + (outcome === 'success' ? 1 : 0);
  for (const tool of Array.isArray(entry.tools) ? entry.tools.slice(0, 8) : []) next.tools[clampText(tool, 60)] = (base.tools?.[clampText(tool, 60)] || 0) + 1;

  const merged = index >= 0 ? rows.map((row, i) => (i === index ? next : row)) : [...rows, next];
  // Evict the least-proven rows first: fewest attempts, then least recent.
  const bounded = merged
    .sort((a, b) => (b.attempts - a.attempts) || (b.lastAt - a.lastAt))
    .slice(0, EXPERIENCE_LIMIT);
  return {rows: bounded};
}

/** Rank stored experience for a task. Pure: takes rows, returns rows. */
export function rankExperience(rows = [], {capability, complexity, limit = 5} = {}) {
  return rows
    .filter(row => !capability || row.capability === capability || row.capability === 'general')
    .map(row => {
      const attempts = Math.max(1, row.attempts || 0);
      const successRate = (row.successes || 0) / attempts;
      const avgScore = (row.totalScore || 0) / attempts;
      const ageDays = Math.max(0, Date.now() - (row.lastAt || 0)) / 86400000;
      return {...row, successRate, avgScore, confidence: Math.min(1, attempts / 4), relevance: (complexity && row.complexity === complexity ? 0.25 : 0) + successRate * 0.6 + avgScore * 0.15 + 0.05 / (1 + ageDays)};
    })
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}

/**
 * Turn experience into concrete planning/routing hints.
 *
 * Deliberately conservative: a strategy is only recommended once it has
 * been attempted at least twice, and a strategy is only discouraged once it
 * has actually failed more often than it succeeded. One bad run is noise.
 */
export function planningHints(rows = [], {capability, complexity, limit = 3} = {}) {
  const ranked = rankExperience(rows, {capability, complexity, limit: EXPERIENCE_LIMIT});
  const proven = ranked.filter(row => row.attempts >= 2 && row.successRate >= 0.6);
  const discouraged = ranked.filter(row => row.attempts >= 2 && row.successRate < 0.34);
  const bestModel = proven
    .flatMap(row => Object.entries(row.models || {}).map(([target, wins]) => ({target, wins})))
    .sort((a, b) => b.wins - a.wins)[0]?.target || null;
  return {
    strategies: proven.slice(0, limit).map(row => ({strategy: row.strategy, successRate: row.successRate, attempts: row.attempts})),
    avoidStrategies: discouraged.slice(0, limit).map(row => ({strategy: row.strategy, successRate: row.successRate, attempts: row.attempts})),
    preferredModel: bestModel,
    evidence: proven.length ? 'learned-from-experience' : 'no-comparable-history'
  };
}

// --------------------------------------------------------------------------
// Store-backed layer
// --------------------------------------------------------------------------
const readDoc = async (accountId, key, fallback) => {
  const value = await accountStore(WORLD_STORE, accountId).get(key, {type: 'json', consistency: 'strong'});
  return value && typeof value === 'object' ? value : fallback;
};

export async function recordExperience(accountId, entry) {
  const {value} = await casUpdate(accountStore(WORLD_STORE, accountId), 'experience', current => mergeExperience(current, entry));
  return value;
}

export async function readExperience(accountId, options) {
  const doc = await readDoc(accountId, 'experience', {rows: []});
  return options ? rankExperience(doc.rows || [], options) : (doc.rows || []);
}

/** Upsert a durable fact by (kind, key) — corrected, never duplicated. */
export async function rememberFact(accountId, {kind, key, value, projectId = null} = {}) {
  if (!FACT_KINDS.includes(kind)) throw Error(`Unknown fact kind. Use one of: ${FACT_KINDS.join(', ')}`);
  if (typeof key !== 'string' || !key.trim()) throw Error('A fact needs a key');
  if (key.length > 160) throw Error('Fact key is too long');
  const {value: doc} = await casUpdate(accountStore(WORLD_STORE, accountId), 'facts', current => {
    const rows = Array.isArray(current?.rows) ? current.rows : [];
    const now = Date.now();
    const existing = rows.find(row => row.kind === kind && row.key === key && (row.projectId || null) === (projectId || null));
    const record = {
      kind,
      key: clampText(key, 160),
      value: clampText(String(value ?? ''), 4000),
      projectId: projectId || null,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    const next = existing ? rows.map(row => (row === existing ? record : row)) : [...rows, record];
    return {rows: next.slice(-DURABLE_LIMIT)};
  });
  return doc.rows;
}

export async function readFacts(accountId, {kind, projectId} = {}) {
  const doc = await readDoc(accountId, 'facts', {rows: []});
  return (doc.rows || []).filter(row => (!kind || row.kind === kind) && (projectId === undefined || (row.projectId || null) === (projectId || null)));
}

/**
 * The single read a planner/runtime needs: the durable state for this
 * project plus the ranked experience and concrete hints for this task.
 */
export async function worldState(accountId, {projectId = null, capability, complexity} = {}) {
  const [facts, experience] = await Promise.all([
    readFacts(accountId, {projectId}),
    readExperience(accountId)
  ]);
  return {
    projectId,
    facts,
    experience: rankExperience(experience, {capability, complexity}),
    hints: planningHints(experience, {capability, complexity}),
    constraints: facts.filter(f => f.kind === 'constraint').map(f => f.value),
    decisions: facts.filter(f => f.kind === 'decision').map(f => f.value)
  };
}
