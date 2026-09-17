import { casUpdate } from './storage/concurrency.js';
import { estimateModelCost } from '../../shared/catalog.js';
export class BudgetError extends Error {}
const units = usd => Math.ceil(usd * 1e6);
export function reservationFor(model, params) {
  // Conservative UTF-8 byte count plus message framing; not a tokenizer.
  const inputTokens = new TextEncoder().encode(params.system || '').length + (params.messages || []).reduce((n,m)=> n + new TextEncoder().encode(m.content).length + 32, 64);
  const outputTokens = params.maxTokens || 2048;
  const cost=estimateModelCost(model,inputTokens,outputTokens);
  if(cost===null||!Number.isFinite(cost)||(cost===0&&!model?.verifiedFree&&!model?.orchestration))throw new BudgetError('Model pricing is unknown or zero pricing is unverified.');
  return {inputTokens, outputTokens, microUsd:units(cost)};
}
export async function reserveBudget(store, account, limits, amount, now = new Date()) {
  const key = `budget:${account}:${now.toISOString().slice(0,7)}`;
  const id = crypto.randomUUID();
  await casUpdate(store,key,current=> {
    const record = current || {inputTokens:0,outputTokens:0,microUsd:0,reservations:{}};
    if (record.inputTokens + amount.inputTokens > limits.inputTokens || record.outputTokens + amount.outputTokens > limits.outputTokens || record.microUsd + amount.microUsd > units(limits.usd)) throw new BudgetError('Monthly workspace allowance reached. Choose a lower-cost model or wait for the next month.');
    if (Object.keys(record.reservations).length >= 100) throw new BudgetError('Too many outstanding requests. Try again later.');
    return {...record,inputTokens:record.inputTokens+amount.inputTokens,outputTokens:record.outputTokens+amount.outputTokens,microUsd:record.microUsd+amount.microUsd,reservations:{...record.reservations,[id]:amount}};
  });
  return {key,id};
}
export async function settleBudget(store, reservation, actual) {
  await casUpdate(store,reservation.key,current=> {
    const held = current?.reservations?.[reservation.id];
    if (!held) return current; // idempotent settlement
    const reservations = {...current.reservations}; delete reservations[reservation.id];
    const charged = actual || held; // retain full estimate for interrupted/unknown usage
    return {...current,reservations,inputTokens:Math.max(0,current.inputTokens-held.inputTokens+charged.inputTokens),outputTokens:Math.max(0,current.outputTokens-held.outputTokens+charged.outputTokens),microUsd:Math.max(0,current.microUsd-held.microUsd+charged.microUsd)};
  });
}
