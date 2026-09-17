import {runEmailQueue} from '../lib/email-channel.js';import {nodeEnv as env} from '../lib/new-api.js';
export default async()=>{await runEmailQueue(env);return new Response(null,{status:204});};export const config={schedule:'* * * * *'};
