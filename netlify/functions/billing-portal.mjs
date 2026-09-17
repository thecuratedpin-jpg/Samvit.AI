import {ownBillingAccount} from '../lib/billing-ownership.js';
import {getStore} from '@netlify/blobs';
import {requireSession} from '../lib/security.js';
import {nodeEnv as env,billingEnabled,stripeClient} from '../lib/checkout.js';
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export default async request=> {
  if(request.method!=='POST') return json({error:'Method not allowed'},405);
  const auth=await requireSession(request,env);if(!auth.ok) return json({error:auth.message},auth.status);
  if(!billingEnabled(env)) return json({error:'Billing management is disabled.'},501);
  const origin=new URL(request.url).origin;
  if(request.headers.get('origin')&&request.headers.get('origin')!==origin) return json({error:'Invalid request origin.'},403);
  try {
    const {record:user}=await ownBillingAccount(auth);
    if(!user?.stripeCustomerId) return json({error:'No billing account exists yet.'},404);
    const session=await stripeClient(env).billingPortal.sessions.create({customer:user.stripeCustomerId,return_url:`${origin}/#plans`});
    return json({url:session.url});
  } catch {return json({error:'Billing management is temporarily unavailable.'},503);}
};
export const config={path:'/api/billing/portal'};
