import {xaiPrices} from './xai-pricing.js';
import {priceFreshness,DIRECT_PRICE_SOURCES} from '../../shared/pricing-policy.js';
import {MODEL_CATALOG,CATALOG_REVIEWED,modelPrice} from '../../shared/catalog.js';
import {zeroPriceModels} from './free-models.js';
const SOURCE='https://openrouter.ai/api/v1/models',TTL=300000;
let cached=null,retryAfter=0;
export function fallbackModels(now=Date.now()){return MODEL_CATALOG.map(m=>({...m,...modelPrice(m),futurePrice:undefined,pricing:priceFreshness({kind:'static-fallback',checkedAt:Date.parse(CATALOG_REVIEWED),source:m.source,reason:DIRECT_PRICE_SOURCES[m.provider]?.reason},now)}));}
export function parseLiveModels(data,now=Date.now()){
 if(!Array.isArray(data?.data))throw new Error('Invalid model catalog');
 const free=new Set(zeroPriceModels(data).map(m=>m.id));
 return data.data.filter(m=>typeof m.id==='string'&&/^[-a-zA-Z0-9_.:/]+$/.test(m.id)&&m.architecture?.output_modalities?.includes('text')).flatMap(m=>{
  const p=m.pricing; if(!p||!['prompt','completion'].every(k=>p[k]!==null&&p[k]!==''&&p[k]!==undefined&&Number.isFinite(Number(p[k]))&&Number(p[k])>=0))return [];
  // Costs beyond text tokens cannot be safely represented by this reservation model.
  if(Object.entries(p).some(([k,v])=>!['prompt','completion','input_cache_read','input_cache_write'].includes(k)&&(v===null||v===''||!Number.isFinite(Number(v))||Number(v)!==0)))return [];
  const input=Number(p.prompt)*1e6,output=Number(p.completion)*1e6;
  if((input===0||output===0)&&!free.has(m.id))return [];
  return [{provider:'openrouter',id:m.id,label:m.name||m.id,input,output,context:m.context_length,verifiedFree:free.has(m.id),pricing:{kind:'live',checkedAt:now,source:SOURCE}}];
 });
}
export async function getRuntimeCatalog({force=false,fetcher=fetch,now=Date.now()}={}){
 if(!force&&cached&&now-cached.checkedAt<TTL)return {checkedAt:cached.checkedAt,source:SOURCE,models:[...fallbackModels(),...cached.liveModels]};
 if(!force&&now<retryAfter)return {models:fallbackModels(),checkedAt:null,unavailable:true};
 try{const response=await fetcher(SOURCE,{redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Catalog unavailable');const liveModels=parseLiveModels(await response.json(),now);if(!liveModels.length)throw new Error('Empty priced catalog');cached={liveModels,checkedAt:now,source:SOURCE};retryAfter=0;return {models:[...fallbackModels(),...liveModels],checkedAt:now,source:SOURCE};}
 catch{retryAfter=now+30000;return {models:fallbackModels(),checkedAt:null,unavailable:true};}
}
export async function pricedModel(provider,id,custom,{apiKey,fetcher}={}){
 if(provider==='grok'&&apiKey)try{const live=(await xaiPrices(apiKey,{fetcher})).find(m=>m.id===id);if(live)return live;}catch{}
 if(provider==='openrouter'){const live=(await getRuntimeCatalog()).models.find(m=>m.provider===provider&&m.id===id);if(live)return live;if(custom?.verifiedFree)throw new Error('Current zero price could not be verified.');}
 const known=fallbackModels().find(m=>m.provider===provider&&m.id===id);if(known)return known;
 if(custom&&Number.isFinite(custom.input)&&custom.input>0&&Number.isFinite(custom.output)&&custom.output>0)return {...custom,pricing:{kind:'user-estimate',checkedAt:custom.updatedAt||null,source:null}};
 throw new Error('This model has no verified price. Set positive conservative budget estimates.');
}
