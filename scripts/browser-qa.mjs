// Optional browser verification. Install Playwright separately; no provider calls.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright'):await import('playwright');
await import('./preview.mjs');
await mkdir('docs',{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.SAMVIT_CHROMIUM_PATH||undefined,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
let saved=null;const requests=[];const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('503'))errors.push(message.text());});
try {
 await page.goto('http://127.0.0.1:4173');await page.waitForFunction(()=>document.querySelector('#connection').textContent==='Not connected');
 await page.screenshot({path:'docs/preview-desktop.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.getByRole('button',{name:'Make something yours'}).click();assert.ok((await page.locator('#prompt').inputValue()).includes('first draft'));
 await page.locator('[data-tier="economy"]').click();assert.equal(await page.locator('[data-tier="economy"]').getAttribute('aria-pressed'),'true');
 await page.locator('a[data-page="models"]').click();await page.waitForSelector('#model-grid .card');assert.equal(await page.locator('#model-grid .card').count(),10);
 await page.locator('#model-search').fill('haiku');assert.equal(await page.locator('#model-grid .card').count(),1);
 await page.locator('#model-search').fill('not-a-model');assert.equal(await page.locator('#model-grid .card').count(),0);
 for(const route of ['council','memory','projects','missions','analytics','plans','settings']){await page.goto(`http://127.0.0.1:4173/#${route}`);await page.waitForSelector('.page');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 await page.goto('http://127.0.0.1:4173/#chat');await page.locator('#theme-toggle').click();assert.equal(await page.locator('body').getAttribute('class'),'dark');assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(32, 30, 36)');assert.equal(await page.locator('h1').evaluate(el=>getComputedStyle(el).color),'rgb(238, 231, 243)');await page.screenshot({path:'docs/preview-dark.png',fullPage:true});await page.locator('#theme-toggle').click();
 await page.locator('#new-chat').click();await page.setViewportSize({width:390,height:844});await page.screenshot({path:'docs/preview-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.locator('#menu-toggle').click();assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'true');await page.locator('a[data-page="models"]').click();await page.waitForSelector('#model-grid');assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'false');
 // Simulated API contract for browser integration, never a shipped demo response.
 saved=null;
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()),body=route.request().postDataJSON();requests.push([url.pathname,route.request().method()]);
  if(url.pathname==='/api/status')return route.fulfill({json:{authenticated:true,protectedApp:true,configuredCount:1,providers:{openai:true},subscription:{planId:'pro',entitlements:{council:false}},billing:{enabled:false}}});
  if(url.pathname==='/api/chat')return route.fulfill({contentType:'text/event-stream',body:'data: {"selected":true,"provider":"openai","model":"gpt-5-mini"}\n\ndata: {"delta":"Safe <script>alert(1)</script> text"}\n\ndata: {"done":true,"provider":"openai","model":"gpt-5-mini","costUsd":0.001}\n\n'});
  if(url.pathname==='/api/conversations'&&route.request().method()==='POST'){saved={...body,id:'browser-test'};return route.fulfill({json:{conversation:saved}});}
  if(url.pathname==='/api/conversations')return route.fulfill({json:{conversations:saved?[saved]:[]}});
  return route.fulfill({json:{}});
 });
 await page.goto('http://127.0.0.1:4173/#chat');await page.reload();await page.waitForFunction(()=>document.querySelector('#connection').textContent==='1 connected');
 await page.locator('#prompt').fill('Test message');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#history').textContent.includes('Test message'),null,{timeout:7000});
 assert.ok(saved.messages[1].complete);assert.equal(await page.locator('.message-content script').count(),0);assert.ok((await page.locator('.message-content').last().innerText()).includes('<script>'));
 assert.deepEqual(errors,[]);console.log('PASS: desktop/mobile layout, all nine routes, filters, draft, price preference, theme, mobile navigation, streamed chat, persistence, and inert HTML output. No page or CSP errors.');
} catch(error) {console.error({error:error.message,errors,requests,saved,connection:await page.locator('#connection').textContent(),notice:await page.locator('#notice').textContent(),body:(await page.locator('body').innerText()).slice(-2500)});throw error;} finally {await browser.close();}
process.exit(0);
