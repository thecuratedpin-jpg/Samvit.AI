import {emailConfig,enqueueEmail} from './email-channel.js';
import {assertOwnerClaim} from './owner-claim.js';
import {normalizeSubscription,getDefaultPlanFromEnv,SUBSCRIPTION_STORE_NAME} from './subscriptions.js';
import {getStore} from '@netlify/blobs';
import {casUpdate} from './storage/concurrency.js';
import {hashPassword,verifyPassword,validatePassword} from './passwords.js';
import {legacyDataExists,migrateLegacy} from './account-migration.js';
import {timingSafeEqual} from './security.js';
export const ACCOUNT_STORE='samvit-accounts';
export function normalizeEmail(value){if(typeof value!=='string'||value.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(value))throw new Error('Enter a valid email address.');return value.trim().toLowerCase();}
export async function emailKey(email){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email));return 'email:'+Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
export async function registerAccount(body,env){
 emailConfig(env);const email=normalizeEmail(body.email);validatePassword(body.password);
 const password=await hashPassword(body.password);
 const gate=env.get('ACCESS_CODE');if(gate&&!timingSafeEqual(body.code||'',gate))throw new Error('A valid registration invitation code is required.');
 const store=getStore(ACCOUNT_STORE),index=await emailKey(email);
 const meta=await store.get('meta',{type:'json',consistency:'strong'});
 if(!meta?.ownerAccountId&&!gate)assertOwnerClaim(env,body.ownerClaim||body.code);
 const id='usr_'+crypto.randomUUID();
 // Email claim stores the resumable account payload. Duplicate registrants never overwrite it.
 const account={id,email,password,sessionVersion:1,createdAt:Date.now(),disabled:false,emailVerified:false,ownerClaimAuthorized:!meta?.ownerAccountId};
 const {value:claimed}=await casUpdate(store,index,r=>r||{id});
 const deleted=await getStore('samvit-account-deletions').get(claimed.id,{type:'json',consistency:'strong'});
 if(!deleted)await casUpdate(store,'account:'+claimed.id,r=>r||{...account,id:claimed.id});
 return enqueueEmail(email,claimed.id,'register',env);
}
export async function finalizeAccount(store,account,env){
 if(await getStore('samvit-account-deletions').get(account.id,{type:'json',consistency:'strong'}))throw new Error('Account unavailable.');
 const current=await store.get('account:'+account.id,{type:'json',consistency:'strong'});if(!current||current.disabled||current.deleting)throw new Error('Email or password is incorrect.');account=current;
 if(!account.emailVerified)return {id:account.id,email:account.email,emailVerified:false,sessionVersion:account.sessionVersion,role:'unverified'};
 const {value:meta}=await casUpdate(store,'meta',m=>{if(m?.ownerAccountId)return m;if(!account.ownerClaimAuthorized)throw new Error('Operator owner-claim authorization is required.');return {ownerAccountId:account.id,migrationComplete:false,createdAt:Date.now()};});
 if(meta.ownerAccountId===account.id)await migrateLegacy(account.id,env);
 await getStore(SUBSCRIPTION_STORE_NAME).setJSON('sub:'+account.id,normalizeSubscription(meta.ownerAccountId===account.id?getDefaultPlanFromEnv(env):{planId:'free'}),{onlyIfNew:true});
 return {id:account.id,email:account.email,emailVerified:true,sessionVersion:account.sessionVersion,role:meta.ownerAccountId===account.id?'owner':'member'};
}
export async function signInAccount(body,env){const email=normalizeEmail(body.email),store=getStore(ACCOUNT_STORE),claim=await store.get(await emailKey(email),{type:'json',consistency:'strong'});const current=claim?await store.get('account:'+claim.id,{type:'json',consistency:'strong'}):null;if(!await verifyPassword(body.password,current?.password)||current.disabled)throw new Error('Email or password is incorrect.');return finalizeAccount(store,current,env);}
