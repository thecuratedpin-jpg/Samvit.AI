// Static preview only: never fabricates model output or account data.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const root=resolve('dist');
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
 try {
  const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(path.startsWith('/api/')){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Static preview: backend not connected.'}));return;}
  const file=resolve(root,'.'+(path==='/'?'/index.html':path));
  if(!file.startsWith(root+'/')){res.writeHead(403);res.end();return;}
  const bytes=await readFile(file);res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(bytes);
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(4173,'127.0.0.1',()=>console.log('Static preview: http://127.0.0.1:4173'));
