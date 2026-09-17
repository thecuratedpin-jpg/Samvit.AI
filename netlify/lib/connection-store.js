import {pricedModel,fallbackModels} from './model-catalog.js';
import {runtimeSecret} from './runtime-secrets.js';
import {casUpdate} from './storage/concurrency.js';
import {providerDefinition,validateCombo} from '../../shared/connections.js';
import {findModel} from '../../shared/catalog.js';
export const CONNECTION_STORE='samvit-connections';
const keyFor=account=>'workspace:'+encodeURIComponent(account);
export async function readConnections(store,account) {return await store.get(keyFor(account),{type:'json',consistency:'strong'})||{connections:[],combos:[]};}
async function cryptKey(env){const raw=await runtimeSecret(env,'SAMVIT_KEY_ENCRYPTION_SECRET');if(!raw||raw.length<32)throw new Error('Connection storage needs a server encryption secret of at least 32 characters.');return crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)).then(b=>crypto.subtle.importKey('raw',b,'AES-GCM',false,['encrypt','decrypt']));}
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
export async function sealKey(value,env,scope){const iv=crypto.getRandomValues(new Uint8Array(12));const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(scope)},await cryptKey(env),new TextEncoder().encode(value));return {iv:b64(iv),value:b64(encrypted)};}
export async function openKey(envelope,env,scope){const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(envelope.iv),additionalData:new TextEncoder().encode(scope)},await cryptKey(env),unb64(envelope.value));return new TextDecoder().decode(bytes);}
export const publicConnection=c=>({id:c.id,name:c.name,provider:c.provider,model:c.model,label:c.label,input:c.input,output:c.output,verifiedFree:Boolean(c.verifiedFree),keyHint:c.keyHint,enabled:c.enabled,status:c.status||'untested',cooldownUntil:c.cooldownUntil||0,updatedAt:c.updatedAt,pricing:c.pricing||{kind:'static-fallback',checkedAt:c.updatedAt}});
export async function saveConnection(store,account,env,input,freeModels=[]) {
 const def=providerDefinition(input?.provider);
 if(!def)throw new Error('Select a supported provider.');
 if(typeof input.name!=='string'||!input.name.trim()||input.name.length>60)throw new Error('Name the connection (up to 60 characters).');
 if(typeof input.model!=='string'||!input.model.trim()||input.model.length>180||!/^[-a-zA-Z0-9_.:/]+$/.test(input.model))throw new Error('Enter a valid model or gateway combo ID.');
 if(typeof input.apiKey!=='string'||input.apiKey.length<8||input.apiKey.length>4096||/\s/.test(input.apiKey))throw new Error('Enter a valid provider API key.');
 let model=fallbackModels().find(m=>m.provider===def.id&&m.id===input.model);if((def.id==='openrouter'&&!freeModels.some(m=>m.id===input.model))||def.id==='grok')try{model=await pricedModel(def.id,input.model,null,{apiKey:input.apiKey});}catch{}
 const free=def.id==='openrouter'?freeModels.find(m=>m.id===input.model):null;
 const inputRate=free?0:model?model.input:Number(input.input),outputRate=free?0:model?model.output:Number(input.output);
 if(!Number.isFinite(inputRate)||!Number.isFinite(outputRate)||inputRate<0||outputRate<0||inputRate>10000||outputRate>10000)throw new Error('Enter valid estimated input and output rates per million tokens.');
 if(!model&&!free&&(inputRate===0||outputRate===0))throw new Error('Use positive budget estimates for custom models. Only verified zero-price models can use zero rates.');
 const id=input.id||crypto.randomUUID();
 if(!/^[a-zA-Z0-9-]{1,60}$/.test(id))throw new Error('Invalid connection ID.');
 const secret=await sealKey(input.apiKey,env,account+':'+id);
 const connection={id,name:input.name.trim(),provider:def.id,model:input.model,label:model?.label||free?.label||input.model,input:inputRate,output:outputRate,verifiedFree:Boolean(free||model?.verifiedFree),pricing:model?.pricing||{kind:free?'live':'user-estimate',checkedAt:Date.now()},secret,keyHint:'••••'+input.apiKey.slice(-4),enabled:true,status:'untested',cooldownUntil:0,updatedAt:Date.now()};
 await casUpdate(store,keyFor(account),r=>{r||={connections:[],combos:[]};if(input.id&&!r.connections.some(c=>c.id===id))throw new Error('Connection no longer exists.');if(!input.id&&r.connections.length>=24)throw new Error('This workspace supports up to 24 connections.');return {...r,connections:[...r.connections.filter(c=>c.id!==id),connection]};});
 return publicConnection(connection);
}
export async function saveCombo(store,account,input){const id=input.id||crypto.randomUUID();if(!/^[a-zA-Z0-9-]{1,60}$/.test(id))throw new Error('Invalid combo ID.');await casUpdate(store,keyFor(account),r=>{r||={connections:[],combos:[]};const combo=validateCombo(input,r.connections);if(input.id&&!r.combos.some(c=>c.id===id))throw new Error('Combo no longer exists.');if(!input.id&&r.combos.length>=12)throw new Error('This workspace supports up to 12 combos.');return {...r,combos:[...r.combos.filter(c=>c.id!==id),{...combo,id,cursor:0}]};});return id;}
export async function deleteConnection(store,account,id,combo=false){await casUpdate(store,keyFor(account),r=>{r||={connections:[],combos:[]};if(!combo&&r.combos.some(c=>c.members.includes(id)))throw new Error('Delete combos using this connection first.');return {...r,[combo?'combos':'connections']:r[combo?'combos':'connections'].filter(c=>c.id!==id)};});}
export async function markConnection(store,account,id,patch,expectedVersion,forceRecovery=false){await casUpdate(store,keyFor(account),r=>r?{...r,connections:r.connections.map(c=>c.id===id&&(!expectedVersion||c.updatedAt===expectedVersion)&&(c.enabled!==false||forceRecovery||patch.enabled===false)?{...c,...patch}:c)}:r);}
export async function nextComboOrder(store,account,combo){if(combo.strategy!=='round-robin')return combo.members;let start=0;await casUpdate(store,keyFor(account),r=>{const current=r?.combos.find(c=>c.id===combo.id);if(!current)throw new Error('Combo no longer exists.');start=current.cursor||0;return {...r,combos:r.combos.map(c=>c.id===combo.id?{...c,cursor:(start+1)%c.members.length}:c)};});return [...combo.members.slice(start),...combo.members.slice(0,start)];}
