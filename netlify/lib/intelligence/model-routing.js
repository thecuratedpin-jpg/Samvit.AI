import {getStore} from '@netlify/blobs';
import {MODEL_CATALOG} from '../../../shared/catalog.js';
import {getApiKeyForProvider} from '../providers.js';
import {readConnections,openKey,CONNECTION_STORE} from '../connection-store.js';
import {accountStore} from '../storage/accounts.js';
import {casUpdate} from '../storage/concurrency.js';

export const MODEL_HEALTH_STORE='samvit-model-health';

// Internal reasoning budgets
export const REASONING_BUDGETS = {
  TRIVIAL: 'TRIVIAL', // Level 0 Fast Path
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  MAX: 'MAX'
};

// LEVEL 1: Semantic Task Classifier
// Maps generic complexity to routing budgets
export function determineBudget(complexity) {
  const c = complexity?.toUpperCase() || 'LOW';
  if (c === "TRIVIAL") return REASONING_BUDGETS.TRIVIAL;
  if (c === "SIMPLE") return REASONING_BUDGETS.LOW;
  if (c === "MODERATE") return REASONING_BUDGETS.MEDIUM;
  if (["COMPLEX", "MISSION"].includes(c)) return REASONING_BUDGETS.HIGH;
  if (c === "CRITICAL") return REASONING_BUDGETS.MAX;
  return REASONING_BUDGETS.MEDIUM;
}

export async function candidates(accountId,env,{capability='general',complexity='low',contextBytes=0,exclude=[], requestedModel=null}={}){
 // LEVEL 0: Deterministic Fast-Path
 const budget = determineBudget(complexity);
 
 // If this is a fast path, attempt to bypass heavy retrieval if requestedModel is flash
 let escalatedBudget = budget;
 if (requestedModel === 'samvit-flash' && (budget === 'HIGH' || budget === 'MAX')) {
   // Intelligent Escalation: samvit-flash encountering a COMPLEX coding task 
   // is automatically routed to use a samvit-pro style budget.
   escalatedBudget = budget; // Stay HIGH/MAX to force capable models
   requestedModel = 'samvit-pro'; // Escalate requested archetype
 } else if (requestedModel === 'samvit-pro' && budget === 'TRIVIAL') {
   // Down-scale trivial requests even if pro is requested to save context/latency
   escalatedBudget = REASONING_BUDGETS.LOW;
 }

 const workspace=await readConnections(getStore(CONNECTION_STORE),accountId);
 
 // LEVEL 3: Candidate Generation
 const direct=MODEL_CATALOG.filter(m=>m.orchestration || getApiKeyForProvider(m.provider,env)).map(m=>({...m,model:m.id,target:`model:${m.provider}:${m.id}`,direct:true}));
 const personal=workspace.connections.filter(c=>c.enabled&&c.cooldownUntil<Date.now()||c.enabled&&!c.cooldownUntil).map(c=>({...c,model:c.model,target:'connection:'+c.id}));
 const health=await accountStore(MODEL_HEALTH_STORE,accountId).get('health',{type:'json',consistency:'strong'})||{};
 
 // LEVEL 4: Filtering
 let result=[...personal,...direct].filter(m=>!exclude.includes(m.target)&&(!m.context||m.context>contextBytes+2048)&&(!health[m.target]?.cooldownUntil||health[m.target].cooldownUntil<Date.now()));
 
 // If an orchestration model is requested but we need concrete backend models, we unpack it.
 // But wait, SAMVIT V10: candidates function itself ranks backend models. 
 // If requested model is not orchestration, we filter down. If it is orchestration (samvit-pro/flash), we do NOT restrict to just that ID, we let the router pick the BEST actual model to back it!
 if (requestedModel && !MODEL_CATALOG.find(m => m.id === requestedModel)?.orchestration) {
   const match = result.filter(m => m.id === requestedModel);
   if (match.length > 0) result = match;
 }
 
 // NOTE: We filter OUT orchestration models from the executable candidate list here because callModel must call a REAL base provider.
 // The orchestration identity is determined by the budget and capabilities we select.
 result = result.filter(m => !m.orchestration);

 // LEVEL 2: Capability Analysis & LEVEL 5: Execution Strategy & LEVEL 6: Evaluation
 for(const m of result){
  const h=health[m.target]||{};
  const capabilities = m.capabilities || { reasoningLevel: 5, codingLevel: 5, researchLevel: 5, toolUseLevel: 5, speedLevel: 5, costLevel: 5, verificationLevel: 5 };
  
  const cost=Number.isFinite(m.input)&&Number.isFinite(m.output)?m.input+m.output:100;
  
  m.metadata={
    capabilities: Object.keys(capabilities),
    toolSupport:'adapter-supported',
    availability:h.successes?'previously-observed':'configured-unverified',
    latencyMs:h.latencyMs??null,
    reliability:h.attempts?h.successes/h.attempts:null,
    contextWindow:m.context??null,
    qualitySource:'v10-capability-matrix'
  };
  
  let baseScore = 0;
  
  // Strategy assignments
  if (capability === 'coding') baseScore += capabilities.codingLevel * 2.5;
  else if (capability === 'research') baseScore += capabilities.researchLevel * 2.5;
  else if (capability === 'writing') baseScore += capabilities.reasoningLevel * 1.5;
  else baseScore += capabilities.reasoningLevel;

  // Level 6: Evaluation Scoring Formulas based on Budget
  if (escalatedBudget === REASONING_BUDGETS.MAX || escalatedBudget === REASONING_BUDGETS.HIGH) {
    baseScore += capabilities.reasoningLevel * 3;
    baseScore -= capabilities.costLevel; // Ignore cost for MISSION/CRITICAL
  } else if (escalatedBudget === REASONING_BUDGETS.LOW || escalatedBudget === REASONING_BUDGETS.TRIVIAL) {
    baseScore += capabilities.speedLevel * 3;
    baseScore += capabilities.costLevel * 2;
  } else {
    // MEDIUM
    baseScore += capabilities.reasoningLevel * 1.5;
    baseScore += capabilities.speedLevel * 1.5;
  }
  
  m.score = baseScore - Math.log1p(cost) - (h.failures||0)*3 - (h.latencyMs||0)/10000;
 }
 
 // Return top candidates (LEVEL 7 Replanning is handled by falling back to next candidate inside callModel)
 return result.sort((a,b)=>b.score-a.score).slice(0,6);
}

export async function candidateKey(m,accountId,env){
 return m.direct?getApiKeyForProvider(m.provider,env):openKey(m.secret,env,accountId+':'+m.id);
}

export async function observeModel(accountId,target,{ok,latencyMs,reason}){
 await casUpdate(accountStore(MODEL_HEALTH_STORE,accountId),'health',r=>{
  const h=r?.[target]||{};
  return {...r,[target]:{attempts:(h.attempts||0)+1,successes:(h.successes||0)+(ok?1:0),failures:ok?0:(h.failures||0)+1,latencyMs:Math.round(latencyMs),lastObservedAt:Date.now(),cooldownUntil:ok?0:Date.now()+(['auth','quota'].includes(reason)?300000:30000)}};
 });
}
