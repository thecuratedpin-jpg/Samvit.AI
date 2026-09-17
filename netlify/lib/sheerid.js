import {getStore} from '@netlify/blobs';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {casUpdate} from './storage/concurrency.js';
import {STUDENT_STORE} from './student-eligibility.js';
const base='https://services.sheerid.com/rest/v2';
const idOK=id=>typeof id==='string'&&/^[a-f0-9]{24}$/i.test(id);
export function sheeridConfig(env){const token=env.get('SHEERID_ACCESS_TOKEN'),programId=env.get('SHEERID_PROGRAM_ID');if(!token||!idOK(programId))throw Object.assign(Error('Student verification needs a configured SheerID access token and published program.'),{status:503});return {token,programId};}
async function call(env,path,body,fetcher=fetch){const {token}=sheeridConfig(env);const response=await fetcher(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('SheerID is unavailable');return response.json();}
export async function beginStudentVerification(accountId,env,{fetcher=fetch,now=Date.now()}={}){
 const {programId}=sheeridConfig(env),store=getStore(STUDENT_STORE),key='student:'+accountId,token=crypto.randomUUID();
 const {value}=await casUpdate(store,key,r=>{if(r?.status==='verified'&&r.expiresAt>now)return r;if(r?.requestLease?.expiresAt>now)throw Error('Verification request in progress');return {...r,accountId,requestLease:{token,expiresAt:now+30000}};});
 if(value.status==='verified'&&value.expiresAt>now)return {message:'Your eligibility is already verified.'};
 try{
  let id=value.reference;
  if(value.verifier!=='SheerID'||!idOK(id)||value.requestedAt+86400000<now){const result=await call(env,'/verification',{programId},fetcher);id=result.verificationId;if(!idOK(id))throw Error('Invalid verification response');}
  await casUpdate(store,'reference:'+id,r=>{if(r&&r.accountId!==accountId)throw Error('Verification already assigned');return {accountId,programId};});
  await casUpdate(store,key,r=>{if(r?.requestLease?.token!==token)throw Error('Verification request lease lost');return {...r,status:'pending',discountRevokedAt:null,verifiedAt:null,verifier:'SheerID',reference:id,programId,requestedAt:now,expiresAt:null,requestLease:null,revision:(r.revision||0)+1};});
  return {url:`https://services.sheerid.com/verify/${programId}/?verificationId=${id}`,message:'Continue with SheerID. Return here and refresh your verification status.'};
 }finally{await casUpdate(store,key,r=>r?.requestLease?.token===token?{...r,requestLease:null}:r);}
}
export async function refreshStudentVerification(accountId,env,{fetcher=fetch,now=Date.now()}={}){
 const store=getStore(STUDENT_STORE),key='student:'+accountId,r=await store.get(key,{type:'json',consistency:'strong'});
 if(r?.revocationLease?.expiresAt>now)throw Error('Discount update in progress');
 if(r?.status==='revoked')return r;
 if(!r||r.verifier!=='SheerID'||!idOK(r.reference))throw Error('Start verification first');
 const {programId}=sheeridConfig(env);if(r.programId!==programId)throw Error('Verification program changed');
 const binding=await store.get('reference:'+r.reference,{type:'json',consistency:'strong'});if(binding?.accountId!==accountId||binding.programId!==programId)throw Error('Verification ownership mismatch');
 const details=await call(env,`/verification/${r.reference}/details`,null,fetcher);
 const account=await getStore('samvit-accounts').get('account:'+accountId,{type:'json',consistency:'strong'});
 if(!account?.emailVerified||account.disabled||account.deleting)throw Error('Active verified account required');
 // Customer PII permission is required; inspect only mailbox binding and do not persist PII or documents.
 const outcome=details.lastResponse?.currentStep;
 if(details.programId!==programId||details.lastResponse?.verificationId!==r.reference||typeof outcome!=='string')throw Error('Incomplete verification details');
 const email=details.personInfo?.email;
 if(outcome==='success'&&(typeof email!=='string'||email.trim().toLowerCase()!==account.email))throw Error('Verification must use your verified Samvit email');
 const status=outcome==='success'?'verified':['error','consolation'].includes(outcome)?'rejected':'pending';
 return (await casUpdate(store,key,current=>{
  if(current?.revocationLease?.expiresAt>now||current?.revision!==r.revision||current.reference!==r.reference)throw Error('Verification changed; refresh again');
  // Replaying or polling an old success never extends its eligibility lifetime.
  const verifiedAt=current.verifiedAt||now,expiresAt=current.expiresAt||verifiedAt+180*86400000;
  return {...current,status:status==='verified'&&expiresAt<=now?'expired':status,verifiedAt:status==='verified'?verifiedAt:current.verifiedAt,expiresAt:status==='verified'?expiresAt:null,lastCheckedAt:now,revision:(current.revision||0)+1};
 })).value;
}
export function verifySheeridWebhook(raw,signature,secret){if(!secret||secret.length<32||!/^([a-f0-9]{64})$/.test(signature||''))return false;return timingSafeEqual(Buffer.from(signature,'hex'),createHmac('sha256',secret).update(raw).digest());}
