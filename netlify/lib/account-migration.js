import {getStore} from '@netlify/blobs';
import {scopedStore} from './storage/accounts.js';
import {openKey,sealKey} from './connection-store.js';
import {casUpdate} from './storage/concurrency.js';
const recordStores=['samvit-conversations','samvit-memories','samvit-projects','samvit-missions','samvit-analytics'];
async function* keys(store){for await(const page of store.list({paginate:true})){for(const blob of page.blobs||[])yield blob.key;}}
export async function legacyDataExists(){
 for(const name of recordStores){const store=getStore(name);for await(const key of keys(store))if(!key.startsWith('accounts/'))return true;}
 for(const [name,key]of [['samvit-connections','workspace:samvit-user'],['samvit-subscription','sub:samvit-user'],['samvit-users','user:samvit-user']])if(await getStore(name).get(key,{type:'json'}))return true;
 for await(const key of keys(getStore('samvit-budget')))if(key.startsWith('budget:samvit-user:'))return true;
 return false;
}
async function copy(store,key,value){if(value!==null&&value!==undefined)await store.setJSON(key,value,{onlyIfNew:true});}
export async function migrateLegacy(accountId,env){
 const accounts=getStore('samvit-accounts'),meta=await accounts.get('meta',{type:'json',consistency:'strong'});
 if(meta?.ownerAccountId!==accountId||meta.migrationComplete)return;
 for(const name of recordStores){const source=getStore(name),target=scopedStore(source,accountId);for await(const key of keys(source)){if(key.startsWith('accounts/'))continue;await copy(target,key,await source.get(key,{type:'json',consistency:'strong'}));}}
 const cs=getStore('samvit-connections'),old=await cs.get('workspace:samvit-user',{type:'json',consistency:'strong'});
 if(old){const connections=[];for(const c of old.connections||[]){const plain=await openKey(c.secret,env,'samvit-user:'+c.id);connections.push({...c,secret:await sealKey(plain,env,accountId+':'+c.id)});}await copy(cs,'workspace:'+accountId,{...old,connections});}
 const subscriptions=getStore('samvit-subscription');await copy(subscriptions,'sub:'+accountId,await subscriptions.get('sub:samvit-user',{type:'json',consistency:'strong'}));
 const budget=getStore('samvit-budget');for await(const key of keys(budget)){if(key.startsWith('budget:samvit-user:'))await copy(budget,key.replace('budget:samvit-user:','budget:'+accountId+':'),await budget.get(key,{type:'json',consistency:'strong'}));}
 const users=getStore('samvit-users'),billing=await users.get('user:samvit-user',{type:'json',consistency:'strong'});await copy(users,'user:'+accountId,billing?{...billing,ownerAccountId:accountId}:null);
 if(billing?.stripeCustomerId)await copy(getStore('samvit-billing-customers'),billing.stripeCustomerId,{accountId});
 await casUpdate(accounts,'meta',m=>{if(m?.ownerAccountId!==accountId)throw new Error('Migration ownership changed.');return {...m,migrationComplete:true,migratedAt:Date.now()};});
}
