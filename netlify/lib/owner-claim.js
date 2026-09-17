import {timingSafeEqual} from './security.js';
export function assertOwnerClaim(env,code){const secret=env.get('SAMVIT_OWNER_CLAIM_SECRET');if(typeof secret!=='string'||secret.length<16||!timingSafeEqual(typeof code==='string'?code:'',secret))throw new Error('The first account requires the operator owner-claim code. Configure SAMVIT_OWNER_CLAIM_SECRET with at least 16 characters.');}
