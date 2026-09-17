import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {safeCSV} from '../netlify/lib/intelligence/csv.js';
import {calculate} from '../netlify/lib/intelligence/calculator.js';
import {verifyClaims} from '../netlify/lib/intelligence/verification.js';
import {executeTool} from '../netlify/lib/intelligence/tools.js';
test('CSV parses embedded commas, quotes and lines before escaping formula cells',()=>{
 assert.equal(safeCSV('name,value\n"a,b","=1+1"\n"a""b","line\nline"'),'"name","value"\r\n"a,b","\'=1+1"\r\n"a""b","line\nline"');
 assert.throws(()=>safeCSV('"unclosed'),/Unterminated/);
 assert.throws(()=>safeCSV('"a"bad'),/Malformed/);
});
test('URL permission blocks invented data-bearing destinations before network use',async()=>{
 await assert.rejects(executeTool({name:'fetch_url',arguments:{url:'https://example.com/?private=secret'}},{accountId:'fixture',env:{get:()=>undefined},grants:['fetch_url'],confirmed:[],allowedUrls:new Set(['https://example.com/']),signal:new AbortController().signal,assertActive:async()=>{},consumeTool:async()=>{}}),/URL must/);
});
test('empty verifier output cannot claim high confidence',()=>{assert.equal(verifyClaims({claims:[],summary:'',confidence:'high'},[]).confidence,'low');});
test('arithmetic handles exponent precedence and rejects skipped tokens',()=>{assert.equal(calculate('-2^2').result,-4);assert.equal(calculate('2^-2').result,.25);assert.throws(()=>calculate('1e + 2'));});
test('release includes assistant entry point and private-store deletion coverage',()=>{
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 assert.match(read('src/app.js'),/renderAssistant\(\{main,api,esc,notify\}\)/);assert.match(read('index.html'),/data-page="assistant"/);
 for(const name of ['samvit-resources','samvit-orchestration','samvit-model-health'])assert.ok(read('netlify/lib/store-inventory.js').includes(name));
});
