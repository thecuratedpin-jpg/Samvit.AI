import {getStore} from '@netlify/blobs';import {json,nodeEnv as env} from '../lib/new-api.js';import {verifyStripeSignature} from '../lib/billing.js';import {casUpdate} from '../lib/storage/concurrency.js';import {validAccountId} from '../lib/storage/accounts.js';import {STUDENT_STORE} from '../lib/student-eligibility.js';
// Trusted verifier adapter: timestamped HMAC SHA-256 over `${timestamp}.${rawBody}`.
// Separate secret from Stripe. No browser or account-owner self-approval endpoint.
export default async req=>{
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 const secret=env.get('SAMVIT_STUDENT_VERIFIER_SECRET');if(!secret||secret.length<32)return json({error:'Verification service is not configured.'},503);
 const raw=await req.text();if(raw.length>5000)return json({error:'Payload too large.'},413);
 if(!(await verifyStripeSignature(raw,req.headers.get('x-samvit-verifier-signature'),secret)).valid)return json({error:'Invalid verifier signature.'},401);
 try{
  const b=JSON.parse(raw),now=Date.now();if(!validAccountId(b.accountId)||!['verified','rejected','revoked'].includes(b.status)||!Number.isSafeInteger(b.revision)||b.revision<1||typeof b.reference!=='string'||!/^[-a-zA-Z0-9_]{1,160}$/.test(b.reference)||typeof b.verifier!=='string'||b.verifier.length>80)throw new Error('Invalid record');
  if(b.status==='verified'&&(!Number.isFinite(b.expiresAt)||b.expiresAt<=now||b.expiresAt>now+366*86400000))throw new Error('Invalid expiry');
  const account=await getStore('samvit-accounts').get('account:'+b.accountId,{type:'json',consistency:'strong'});if(!account||account.deleting)throw new Error('Unknown account');
  const store=getStore(STUDENT_STORE);await casUpdate(store,'reference:'+b.reference,r=>{if(r&&r.accountId!==b.accountId)throw new Error('Verification reference already used');return {accountId:b.accountId};});
  await casUpdate(store,'student:'+b.accountId,r=>{if((r?.revision||0)>=b.revision)return r;return {accountId:b.accountId,status:b.status,reference:b.reference,verifier:b.verifier,verifiedAt:b.status==='verified'?now:null,expiresAt:b.status==='verified'?b.expiresAt:null,revision:b.revision,updatedAt:now};});return json({received:true});
 }catch{return json({error:'Verification could not be applied. Check the account, reference, revision and expiry.'},400);}
};export const config={path:'/api/student-verification-webhook'};
