import {getStore} from '@netlify/blobs';
const names=['SESSION_SECRET','SAMVIT_KEY_ENCRYPTION_SECRET'];
// Explicit opt-in. Persistent, conditional initialization makes concurrent cold starts agree.
// Secrets never enter static output, browser responses, or logs.
export async function runtimeSecret(env,name){
 if(!names.includes(name))throw new Error('Unsupported secret');
 const explicit=env.get(name);if(explicit)return explicit;
 if(env.get('SAMVIT_AUTO_SECRETS')!=='true')return undefined;
 const store=getStore('samvit-runtime-secrets');
 let record=await store.get(name,{type:'json',consistency:'strong'});
 if(!record){const value=Array.from(crypto.getRandomValues(new Uint8Array(48)),b=>b.toString(16).padStart(2,'0')).join('');await store.setJSON(name,{value,createdAt:Date.now()},{onlyIfNew:true});record=await store.get(name,{type:'json',consistency:'strong'});}
 if(typeof record?.value!=='string'||record.value.length<32)throw new Error('Secret storage unavailable');
 return record.value;
}
