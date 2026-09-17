import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
export function publicIPv4(ip){if(isIP(ip)!==4)return false;const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
export function publicURL(raw){const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||u.hash||u.hostname.length>253||!u.hostname.includes('.')||/\.(local|internal|localhost)$/i.test(u.hostname)||isIP(u.hostname)&&!publicIPv4(u.hostname)||u.hostname.includes(':'))throw Error('Only public HTTPS URLs without credentials are allowed');return u;}
export async function safeFetch(raw,{signal,resolver=lookup,request=https.request,maxBytes=200000}={}){
 const url=publicURL(raw),records=await resolver(url.hostname,{family:4,all:true});
 if(!records.length||records.some(r=>!publicIPv4(r.address)))throw Error('URL resolves to a private or reserved address');
 signal?.throwIfAborted();
 const response=await new Promise((resolve,reject)=>{
  const req=request(url,{method:'GET',agent:false,signal,headers:{accept:'text/html,text/plain,application/json','accept-encoding':'identity','user-agent':'Samvit/9'},lookup:(_host,opts,cb)=>opts?.all?cb(null,[{address:records[0].address,family:4}]):cb(null,records[0].address,4)},res=>{
   if(res.statusCode<200||res.statusCode>=300){res.destroy();reject(Error('Fetch failed or redirected'));return;}
   const type=String(res.headers['content-type']||'');if(!/^(text\/(plain|html)|application\/json)\b/i.test(type)||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(Error('Unsupported response type'));return;}
   const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){res.destroy(Error('Response too large'));return;}chunks.push(chunk);});res.on('error',reject);res.on('end',()=>resolve({type,body:Buffer.concat(chunks).toString('utf8')}));
  });req.on('error',reject);req.setTimeout(8000,()=>req.destroy(Error('Fetch timeout')));req.end();
 });
 const text=response.type.includes('html')?response.body.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim():response.body;
 return {url:url.href,text:text.slice(0,12000),retrievedAt:Date.now(),truncated:text.length>12000,untrusted:true};
}
