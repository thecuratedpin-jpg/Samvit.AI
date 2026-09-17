// Standard text API rates, USD / million tokens. Reviewed 2026-09-14.
// Provider access still depends on the deployment's credentials.
export const CATALOG_REVIEWED = '2026-09-14';

// Orchestration archetypes (SAMVIT PRO / SAMVIT FLASH) are NOT provider
// models. They are selection policies that delegate to the executable models
// below, so they are kept out of MODEL_CATALOG and handled explicitly by
// selectModel()/modelCombo()/the intelligence router. This keeps every entry
// in MODEL_CATALOG something the server can actually call via PROVIDERS.
export const ARCHETYPES = [
  {
    provider: 'samvit', id: 'samvit-pro', label: 'SAMVIT PRO', tier: 'frontier',
    input: 0, output: 0, context: 1000000, freeTier: false,
    description: 'Maximum reasoning & coding · adaptive multi-model orchestration',
    capabilities: { reasoningLevel: 10, codingLevel: 10, researchLevel: 10, toolUseLevel: 10, visionLevel: 9, longContextLevel: 10, speedLevel: 6, costLevel: 5, verificationLevel: 10 },
    orchestration: true, routingPolicy: 'adaptive-pro'
  },
  {
    provider: 'samvit', id: 'samvit-flash', label: 'SAMVIT FLASH', tier: 'balanced',
    input: 0, output: 0, context: 1048576, freeTier: true,
    description: 'Fast everyday intelligence · fastest suitable model',
    capabilities: { reasoningLevel: 8, codingLevel: 8, researchLevel: 7, toolUseLevel: 8, visionLevel: 8, longContextLevel: 8, speedLevel: 10, costLevel: 10, verificationLevel: 7 },
    orchestration: true, routingPolicy: 'adaptive-flash'
  },
];

export const MODEL_CATALOG = [
  // Base Providers
  {
    provider:'gemini', id:'gemini-3.1-flash-lite', label:'Gemini 3.1 Flash-Lite', tier:'economy', input:0.25, output:1.5, context:1048576, freeTier:true, description:'Free-tier friendly, high-volume everyday tasks', source:'https://ai.google.dev/gemini-api/docs/pricing',
    capabilities: { reasoningLevel: 5, codingLevel: 5, researchLevel: 6, toolUseLevel: 6, visionLevel: 8, longContextLevel: 10, speedLevel: 10, costLevel: 10, verificationLevel: 5 }
  },
  {
    provider:'openai', id:'gpt-5-mini', label:'GPT-5 Mini', tier:'economy', input:0.25, output:2, context:400000, freeTier:false, description:'Low-latency cost-sensitive tasks', source:'https://developers.openai.com/api/docs/models/gpt-5-mini',
    capabilities: { reasoningLevel: 6, codingLevel: 6, researchLevel: 6, toolUseLevel: 7, visionLevel: 7, longContextLevel: 7, speedLevel: 10, costLevel: 9, verificationLevel: 6 }
  },
  {
    provider:'claude', id:'claude-haiku-4-5-20251001', label:'Claude Haiku 4.5', tier:'economy', input:1, output:5, context:200000, description:'Quick writing and lightweight tasks', source:'https://platform.claude.com/docs/en/models/overview',
    capabilities: { reasoningLevel: 7, codingLevel: 6, researchLevel: 7, toolUseLevel: 8, visionLevel: 7, longContextLevel: 6, speedLevel: 10, costLevel: 8, verificationLevel: 7 }
  },
  {
    provider:'gemini', id:'gemini-3.6-flash', label:'Gemini 3.6 Flash', tier:'balanced', input:0.75, output:3.75, futurePrice:{from:'2027-01-01',input:1.5,output:7.5}, context:1048576, freeTier:true, description:'Fast multimodal work with a broad free tier', source:'https://ai.google.dev/gemini-api/docs/pricing',
    capabilities: { reasoningLevel: 8, codingLevel: 8, researchLevel: 7, toolUseLevel: 8, visionLevel: 10, longContextLevel: 10, speedLevel: 9, costLevel: 8, verificationLevel: 7 }
  },
  {
    provider:'openai', id:'gpt-5.1', label:'GPT-5.1', tier:'balanced', input:1.25, output:10, context:400000, freeTier:false, description:'Coding and agentic tasks with configurable reasoning', source:'https://developers.openai.com/api/docs/models/gpt-5.1',
    capabilities: { reasoningLevel: 9, codingLevel: 9, researchLevel: 8, toolUseLevel: 9, visionLevel: 8, longContextLevel: 8, speedLevel: 7, costLevel: 6, verificationLevel: 8 }
  },
  {
    provider:'claude', id:'claude-sonnet-5', label:'Claude Sonnet 5', tier:'balanced', input:2, output:10, context:1000000, description:'Thoughtful writing and code', source:'https://platform.claude.com/docs/en/models/overview',
    capabilities: { reasoningLevel: 9, codingLevel: 9, researchLevel: 9, toolUseLevel: 9, visionLevel: 9, longContextLevel: 10, speedLevel: 8, costLevel: 6, verificationLevel: 9 }
  },
  {
    provider:'grok', id:'grok-4.6', label:'Grok 4.6', tier:'balanced', input:2, output:6, context:500000, freeTier:false, description:'A different perspective on code and analysis', source:'https://docs.x.ai/developers/models',
    capabilities: { reasoningLevel: 8, codingLevel: 8, researchLevel: 8, toolUseLevel: 7, visionLevel: 7, longContextLevel: 8, speedLevel: 8, costLevel: 7, verificationLevel: 7 }
  },
  {
    provider:'openai', id:'gpt-5.1-codex', label:'GPT-5.1 Codex', tier:'frontier', input:1.25, output:10, context:400000, freeTier:false, description:'Agentic coding and professional software work', source:'https://developers.openai.com/api/docs/models',
    capabilities: { reasoningLevel: 9, codingLevel: 10, researchLevel: 8, toolUseLevel: 10, visionLevel: 6, longContextLevel: 8, speedLevel: 7, costLevel: 6, verificationLevel: 8 }
  },
  {
    provider:'claude', id:'claude-opus-5', label:'Claude Opus 5', tier:'frontier', input:5, output:25, context:1000000, description:'Demanding coding and reasoning', source:'https://platform.claude.com/docs/en/models/overview',
    capabilities: { reasoningLevel: 10, codingLevel: 10, researchLevel: 10, toolUseLevel: 10, visionLevel: 9, longContextLevel: 10, speedLevel: 5, costLevel: 4, verificationLevel: 10 }
  },
  {
    provider:'grok', id:'grok-420-reasoning', label:'Grok 4.20 Reasoning', tier:'frontier', input:20, output:80, context:256000, freeTier:false, description:'Expensive reasoning fallback for difficult problems', source:'https://docs.x.ai/developers/rest-api-reference/inference/models',
    capabilities: { reasoningLevel: 10, codingLevel: 9, researchLevel: 9, toolUseLevel: 8, visionLevel: 6, longContextLevel: 7, speedLevel: 4, costLevel: 2, verificationLevel: 9 }
  },
];

export function modelPrice(model, now = new Date()) {
  return model.futurePrice && now >= new Date(model.futurePrice.from) ? model.futurePrice : model;
}

export function findModel(provider, id) { return MODEL_CATALOG.find(m => m.provider === provider && m.id === id); }

// Free-tier catalog includes free orchestration archetypes (e.g. SAMVIT FLASH)
// ahead of free provider models, matching the ordering used by modelCombo().
export function freeModelCatalog() {
  return [...MODEL_CATALOG, ...ARCHETYPES]
    .filter(m => m.freeTier)
    .sort((a, b) => (b.orchestration ? 1 : 0) - (a.orchestration ? 1 : 0));
}

export function estimateModelCost(model, inputTokens, outputTokens, now) {
  if (!model || !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || inputTokens < 0 || outputTokens < 0) return null;
  if (model.orchestration) return 0; // Orchestrated models use their submodels' costs, this is a placeholder stub
  const price = modelPrice(model, now);
  if(!Number.isFinite(price.input)||!Number.isFinite(price.output)||price.input<0||price.output<0)return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1e6;
}

// An explicit price preference, not a benchmark or a learned classifier.
export function selectModel({provider, model, tier='balanced', available}) {
  if (!['economy','balanced','frontier'].includes(tier)) throw new Error('Unknown price preference.');
  if (model) {
    const match = findModel(provider, model);
    if (!match) throw new Error('This model is not in the supported catalog.');
    if (!match.orchestration && !available[match.provider]) throw new Error('This provider is not connected.');
    return match;
  }
  const candidates = MODEL_CATALOG.filter(m => (m.orchestration || available[m.provider]) && (!provider || provider === 'auto' || m.provider === provider));
  const preferred = candidates.filter(m => m.tier === tier);
  // Break ties randomly when cost is identical (like orchestration models that report 0)
  const selected = (preferred.length ? preferred : candidates).sort((a,b) => {
    const costA = estimateModelCost(a, 1000, 1000) ?? 0;
    const costB = estimateModelCost(b, 1000, 1000) ?? 0;
    return costA - costB;
  })[0];
  if (!selected) throw new Error('No provider is connected for this selection.');
  return selected;
}

export function modelCombo({tier='balanced', available={}, maxCandidates=3}={}) {
  // Archetypes are orchestration policies, always available; provider models
  // only when their provider is connected. Zero-cost archetypes sort first.
  const connected = [...MODEL_CATALOG, ...ARCHETYPES].filter(m => m.orchestration || available[m.provider]);
  const preferred = connected.filter(m => m.tier === tier);
  return (preferred.length ? preferred : connected)
    .sort((a,b) => {
      const costA = estimateModelCost(a, 1000, 1000) ?? 0;
      const costB = estimateModelCost(b, 1000, 1000) ?? 0;
      return costA - costB;
    })
    .slice(0,maxCandidates);
}
