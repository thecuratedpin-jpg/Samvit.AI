import {execFileSync} from 'node:child_process';
import {readdir,readFile,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
let failures=0,checked=0;
async function walk(dir) {for(const entry of await readdir(dir,{withFileTypes:true})) {
 const path=resolve(dir,entry.name);
 if(entry.isDirectory()) await walk(path);
 else if(/\.(m?js)$/.test(path)) {
   checked++;
   try {await import(pathToFileURL(path));} catch(err) {console.error(path,err.message);failures++;}
 }
}}
for(const dir of ['shared','netlify','agent']) await walk(dir);
for(const entry of await readdir('src'))if(entry.endsWith('.js')){try{execFileSync(process.execPath,['--check',resolve('src',entry)],{stdio:'pipe'});}catch(err){console.error('Frontend syntax:',entry,err.stderr?.toString());failures++;}}
const html=await readFile('index.html','utf8');
for(const [,asset] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
 if(/^(https?:|data:)/.test(asset)) continue;
 try {await access(resolve(asset));} catch {console.error('Missing asset:',asset);failures++;}
}
console.log(`${checked} server/shared modules checked; ${failures} errors.`);process.exitCode=failures?1:0;
