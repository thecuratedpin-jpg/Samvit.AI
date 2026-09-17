import {getStore} from '@netlify/blobs';
export const validAccountId=id=>typeof id==='string'&&/^usr_[a-f0-9-]{36}$/.test(id);
export function scopedStore(store,accountId){
 // The legacy ID is reserved exclusively for explicit local DEV_MODE sessions.
 if(accountId==='samvit-user')return store;
 if(!validAccountId(accountId))throw new Error('A valid authenticated account is required.');
 const prefix=`accounts/${accountId}/`,key=k=>prefix+String(k);
 return {get:(k,o)=>store.get(key(k),o),getWithMetadata:(k,o)=>store.getWithMetadata(key(k),o),setJSON:(k,v,o)=>store.setJSON(key(k),v,o),delete:k=>store.delete(key(k))};
}
export const accountStore=(name,accountId)=>scopedStore(getStore(name),accountId);
