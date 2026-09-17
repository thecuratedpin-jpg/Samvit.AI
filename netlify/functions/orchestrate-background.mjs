import {authorizeWorker} from '../lib/intelligence/dispatch.js';
import {runJob} from '../lib/intelligence/runtime.js';
import {nodeEnv as env} from '../lib/new-api.js';
// Netlify -background naming provides asynchronous execution. Never rely on the name for authentication.
export default async req=>{let identity;try{identity=await authorizeWorker(req,env);}catch{return new Response(null,{status:401});}await runJob(identity.accountId,identity.id,env);return new Response(null,{status:204});};
