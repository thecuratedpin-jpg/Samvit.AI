export const PRICE_REVIEW_DAYS=7;
export const DIRECT_PRICE_SOURCES={
 openai:{adapter:null,reason:'The documented direct models API does not publish token prices. No verified direct pricing feed is integrated.',source:'https://developers.openai.com/api/reference/resources/models/methods/list'},
 claude:{adapter:null,reason:'The documented direct models API does not publish token prices. No verified direct pricing feed is integrated.',source:'https://platform.claude.com/docs/en/api/models/list'},
 gemini:{adapter:null,reason:'The documented models API describes model capabilities, not token prices. No verified direct pricing feed is integrated.',source:'https://ai.google.dev/api/models'},
 grok:{adapter:'xai-language-models',reason:'Authenticated xAI language-model metadata supplies direct text-token prices.',source:'https://docs.x.ai/developers/rest-api-reference/inference/models'}
};
export function priceFreshness(pricing={},now=Date.now()){
 const checkedAt=Number.isFinite(pricing.checkedAt)?pricing.checkedAt:null,ageMs=checkedAt===null?null:Math.max(0,now-checkedAt),reviewAfterMs=pricing.kind==='live'?300000:PRICE_REVIEW_DAYS*86400000;
 return {...pricing,checkedAt,ageMs,ageDays:ageMs===null?null:Math.floor(ageMs/86400000),reviewIntervalDays:pricing.kind==='live'?null:PRICE_REVIEW_DAYS,reviewDueAt:checkedAt===null?null:checkedAt+reviewAfterMs,stale:ageMs===null||ageMs>=reviewAfterMs};
}
export function priceStatusLabel(pricing,now=Date.now()){const p=priceFreshness(pricing,now);return `${p.kind==='live'?'Live provider feed':p.kind==='user-estimate'?'Your estimate':'Static fallback'} · ${p.ageDays===null?'age unknown':p.ageDays+' days old'} · ${p.stale?'REVIEW DUE':p.kind==='live'?'refreshes every 5 min':'review every '+p.reviewIntervalDays+' days'}`;}
