// Node runtime only. Password hashing uses the audited built-in scrypt implementation.
import {scrypt,randomBytes,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const derive=promisify(scrypt);
export const SCRYPT_OPTIONS=Object.freeze({N:131072,r:8,p:1,maxmem:256*1024*1024});
export function validatePassword(password){if(typeof password!=='string'||password.length<12||password.length>128)throw new Error('Use a password between 12 and 128 characters.');}
export async function hashPassword(password){validatePassword(password);const salt=randomBytes(16).toString('hex'),hash=await derive(password,salt,64,SCRYPT_OPTIONS);return {algorithm:'scrypt',N:131072,r:8,p:1,salt,hash:hash.toString('hex')};}
export async function verifyPassword(password,record){if(typeof password!=='string'||password.length>128)return false;const good=record?.algorithm==='scrypt'&&record.N===131072&&record.r===8&&record.p===1&&/^[a-f0-9]{32}$/.test(record.salt)&&/^[a-f0-9]{128}$/.test(record.hash);const salt=good?record.salt:'00000000000000000000000000000000';const result=await derive(password,salt,64,SCRYPT_OPTIONS);return good&&timingSafeEqual(result,Buffer.from(record.hash,'hex'));}
