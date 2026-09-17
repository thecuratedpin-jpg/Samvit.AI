import {pricedModel} from './model-catalog.js';
import {getStore} from '@netlify/blobs';
import {PROVIDERS,streamFromProviderWithRetry} from './providers.js';
import {findModel,estimateModelCost} from '../../shared/catalog.js';
import {getSubscription,isSubscriptionServiceUnavailable,SUBSCRIPTION_STORE_NAME} from './subscriptions.js';
import {reserveBudget,settleBudget,reservationFor} from './budget.js';
import {DEFAULT_ACCOUNT_ID,isDevelopmentMode} from './security.js';
import {validAccountId} from './storage/accounts.js';
export async function* streamMetered(provider,apiKey,params) {
  const env = params.env || globalThis.Netlify?.env || {get:k=>globalThis.process?.env[k]};
  let model;try{model=await pricedModel(provider,params.model || PROVIDERS[provider]?.defaultModel,params.modelInfo,{apiKey});}catch(err){yield {error:err.message,retryable:false};return;}
  if (!model || !apiKey) { yield {error:'The selected model is unavailable.',retryable:false}; return; }
  let store, reservation;
  try {
    store = getStore('samvit-budget');
    const account = params.accountId;
    if(!validAccountId(account)&&!(account===DEFAULT_ACCOUNT_ID&&isDevelopmentMode(env)))throw new Error('Authenticated account required');
    if(account!==DEFAULT_ACCOUNT_ID){const user=await getStore('samvit-accounts').get('account:'+account,{type:'json',consistency:'strong'});if(!user?.emailVerified||user.disabled||user.deleting)throw new Error('Verified active account required');}
    const subscription = await getSubscription(getStore(SUBSCRIPTION_STORE_NAME),account,env);
    if (isSubscriptionServiceUnavailable(subscription)) throw new Error('Subscription unavailable');
    if (subscription.status !== 'active') { yield {error:'This workspace subscription is inactive.',retryable:false}; return; }
    // Free is an operator-funded trial, not free API access.
    const planUsd = subscription.planId === 'free' ? 0.10 : subscription.limits.monthlySpendUsd;
    const override = env.get('SAMVIT_MONTHLY_BUDGET_USD');
    const usd = override === undefined || override === null || override === '' ? planUsd : Math.min(planUsd,Number(override));
    if (!Number.isFinite(usd) || usd < 0) throw new Error('Invalid budget configuration');
    reservation = await reserveBudget(store,account,{usd,inputTokens:subscription.limits.monthlyInputTokens,outputTokens:subscription.limits.monthlyOutputTokens},reservationFor(model,params));
  } catch (err) {
    yield {error:err.name === 'Error' && !err.message.startsWith('Monthly') && !err.message.startsWith('Too many') ? 'Usage controls are unavailable. Please try again later.' : err.message,retryable:false}; return;
  }
  let actual = null; let started = false;
  try {
    // No automatic retry of an uncertain billed call. Explicit fallback gets a separate reservation.
    const source = params.transport ? params.transport(apiKey,params) : streamFromProviderWithRetry(provider,apiKey,params,{maxRetries:0});
    for await (const chunk of source) {
      if (chunk.text) started = true;
      if (chunk.rejected && !started) actual = {inputTokens:0,outputTokens:0,microUsd:0};
      if (chunk.done && chunk.usage) {
        const cost = estimateModelCost(model,chunk.usage.inputTokens,chunk.usage.outputTokens);
        if (cost !== null) actual = {inputTokens:chunk.usage.inputTokens,outputTokens:chunk.usage.outputTokens,microUsd:Math.ceil(cost*1e6)};
      }
      yield {...chunk,...(chunk.done?{pricing:model.pricing,meteredCostUsd:chunk.usage?estimateModelCost(model,chunk.usage.inputTokens,chunk.usage.outputTokens):null}:{})};
    }
  } finally {
    try { await settleBudget(store,reservation,actual); } catch { /* keep reservation charged on outage */ }
  }
}
