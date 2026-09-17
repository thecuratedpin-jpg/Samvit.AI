import {getStore} from '@netlify/blobs';
import {getSubscription,isSubscriptionServiceUnavailable} from '../subscriptions.js';
import {reserveBudget,settleBudget} from '../budget.js';
export async function chargeToolBudget(accountId,microUsd,env){
 if(!Number.isSafeInteger(microUsd)||microUsd<0)throw Error('Invalid tool price');if(!microUsd)return;
 const sub=await getSubscription(getStore('samvit-subscription'),accountId,env);if(isSubscriptionServiceUnavailable(sub)||sub.status!=='active')throw Error('Tool allowance unavailable');
 const cap=sub.planId==='free'?.1:sub.limits.monthlySpendUsd,override=env.get('SAMVIT_MONTHLY_BUDGET_USD'),usd=override?Math.min(cap,Number(override)):cap;if(!Number.isFinite(usd)||usd<0)throw Error('Invalid allowance');
 const store=getStore('samvit-budget'),amount={inputTokens:0,outputTokens:0,microUsd},reservation=await reserveBudget(store,accountId,{usd,inputTokens:sub.limits.monthlyInputTokens,outputTokens:sub.limits.monthlyOutputTokens},amount);
 // Fixed-price external requests are conservatively charged before dispatch, including uncertain failures.
 await settleBudget(store,reservation,amount);
}
