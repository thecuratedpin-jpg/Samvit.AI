import {emailConfig} from '../lib/email-channel.js';
import {getStore} from '@netlify/blobs';
import {runtimeSecret} from '../lib/runtime-secrets.js';
import {nodeEnv as env,json} from '../lib/new-api.js';
export default async req=>{
 if(req.method!=='GET')return json({error:'Method not allowed.'},405);
 const checks=[];
 for(const [key,purpose]of [['SESSION_SECRET','Signs account sessions.'],['SAMVIT_KEY_ENCRYPTION_SECRET','Encrypts your saved provider keys.']]){let ok=false;try{ok=(await runtimeSecret(env,key))?.length>=32;}catch{}checks.push({key,required:true,ok,message:ok?purpose+' Ready.':purpose+' Set 32+ random characters, or enable SAMVIT_AUTO_SECRETS=true with working Netlify Blobs.'});}
 let storage=false,claimed=false;try{const meta=await getStore('samvit-accounts').get('meta',{type:'json',consistency:'strong'});storage=true;claimed=Boolean(meta?.ownerAccountId);}catch{}
 checks.push({key:'NETLIFY_BLOBS',required:true,ok:storage,message:storage?'Account storage is reachable.':'Connect Netlify Blobs before setting up accounts.'});
 if(!claimed)checks.push({key:'OWNER_CLAIM',required:true,ok:false,message:'Owner setup is incomplete. The operator must register using the invitation code, or configure SAMVIT_OWNER_CLAIM_SECRET (16+ characters) and enter that private code. Registration readiness stays false until ownership is established.'});
 let emailReady=false;try{emailConfig(env);emailReady=true;}catch{}checks.push({key:'EMAIL_DELIVERY',required:true,ok:emailReady,message:emailReady?'Email delivery is configured; verify delivery with the provider.':'Set RESEND_API_KEY, SAMVIT_EMAIL_FROM and HTTPS SAMVIT_PUBLIC_ORIGIN for verification and recovery.'});
 return json({ready:checks.filter(c=>c.required).every(c=>c.ok),checks,demo:'You can explore the interface without signing in. Account setup requires the configured services.'});
};export const config={path:'/api/setup'};
