import {calculate} from './calculator.js';
import {object,text,validate,parseJSON} from './schema.js';

export const verificationSchema = object({
  claims: {
    type: 'array',
    maxItems: 20,
    items: object({
      claim: text(800),
      status: { ...text(), enum: ['supported', 'unsupported', 'conflict'] },
      sourceUrls: { type: 'array', items: text(2000), maxItems: 10 },
      note: text(1000)
    })
  },
  summary: text(2000),
  confidence: { ...text(), enum: ['low', 'medium', 'high', 'certain'] },
  pipeline_stage: { ...text(), enum: ['claim_extraction', 'source_retrieval', 'independent_check', 'conflict_detection', 'confidence_score', 'verified'] }
}, ['claims', 'summary', 'confidence']);

export function verifyClaims(raw, evidence, { freshness = false, level = 'basic' } = {}) {
  if (level === 'none') {
    return { status: 'unverified', confidence: 'medium', claims: [], summary: 'Verification skipped (NONE)', independentlyProven: false };
  }

  const report = validate(typeof raw === 'string' ? parseJSON(raw) : raw, verificationSchema);
  const sources = evidence.flatMap(e => e.sources || e.url ? [...(e.sources || [e])] : []);
  const allowed = new Set(sources.filter(s => s.url && s.retrievedAt && s.text).map(s => s.url));

  report.claims = report.claims.map(c => {
    let status = c.status;
    const isSupported = status === 'supported';
    
    // Check evidence requirements based on level
    if (isSupported) {
      const hasSources = c.sourceUrls.length > 0;
      const allSourcesAllowed = c.sourceUrls.every(u => allowed.has(u));

      if (level === 'deep' || level === 'critical') {
        if (!hasSources || !allSourcesAllowed || c.sourceUrls.length < 2) status = 'unsupported';
      } else if (level === 'standard' || freshness) {
        if (!hasSources || !allSourcesAllowed) status = 'unsupported';
      } else if (level === 'basic') {
        if (hasSources && !allSourcesAllowed) status = 'unsupported'; // If they provide sources, they must be real
      }
    }
    
    return { ...c, status, sourceUrls: c.sourceUrls.filter(u => allowed.has(u)) };
  });

  const unresolved = report.claims.filter(c => c.status !== 'supported').length;
  
  if (!report.claims.length || unresolved || (freshness && !allowed.size)) {
    report.confidence = 'low';
  } else if (unresolved === 0 && (level === 'deep' || level === 'critical')) {
    report.confidence = 'high';
  }

  report.pipeline_stage = 'verified';

  return {
    ...report,
    status: unresolved ? 'unresolved' : (report.claims.length ? 'reviewed' : 'unverified'),
    independentlyProven: unresolved === 0 && level !== 'basic' && report.claims.length > 0
  };
}

export function verifyCalculation(expression, claimed) {
  const actual = calculate(expression).result;
  return { status: Object.is(actual, claimed) ? 'verified' : 'conflict', actual, claimed };
}
