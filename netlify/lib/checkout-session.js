import {casUpdate} from './storage/concurrency.js';
// One open checkout per account. The Stripe expiry matches the local hold.
export async function beginCheckout(store,key,accountId,selection,now=Date.now()){
 const token=crypto.randomUUID(),expiresAt=now+1860000;
 const {value}=await casUpdate(store,key,r=>{
  if(r?.ownerAccountId!==accountId)throw new Error('Billing ownership changed');
  if(r.checkout?.expiresAt>now)return r;
  return {...r,checkout:{token,expiresAt,priceId:selection.priceId,studentDiscount:selection.studentDiscount}};
 });
 const hold=value.checkout;
 if(hold.token!==token){if(hold.priceId!==selection.priceId||hold.studentDiscount!==selection.studentDiscount)throw new Error('An open checkout already exists. Finish it or wait for its 31-minute expiry before changing plans.');if(hold.url)return {existing:hold};throw new Error('Checkout is being prepared. Retry shortly; an uncertain request stays held until expiry.');}
 return {token,expiresAt};
}
export async function finishCheckout(store,key,token,session){await casUpdate(store,key,r=>{if(r?.checkout?.token!==token)throw new Error('Checkout ownership changed');return {...r,checkout:{...r.checkout,url:session.url,sessionId:session.id}};});}
