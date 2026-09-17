// Browser outage checks. Only API errors/status responses are mocked; the real frontend is rendered.
import {createRequire} from 'node:module';import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url),{chromium}=process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright'):await import('playwright');
await import('./preview.mjs');await mkdir('qa',{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.SAMVIT_CHROMIUM_PATH||undefined,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
let statusWorks=false;await page.route('**/api/**',r=>new URL(r.request().url()).pathname==='/api/status'&&statusWorks?r.fulfill({json:{authenticated:false,configuredCount:0,providers:{},billing:{enabled:false}}}):r.fulfill({status:503,json:{error:'Forced backend outage'}}));
await page.goto('http://localhost:4173/');await page.locator('#connection').filter({hasText:'Not connected'}).waitFor();assert.equal(await page.locator('#login-dialog').evaluate(d=>d.open),false);
await page.locator('#persistent-signin').click();assert.equal(await page.locator('#login-dialog').evaluate(d=>d.open),true);await page.screenshot({path:'qa/signin-backend-outage-desktop.png'});await page.locator('#explore-demo').click();
await page.goto('http://localhost:4173/#setup');await page.locator('#setup-signin').waitFor();await page.locator('#setup-signin').click();assert.equal(await page.locator('#login-dialog').evaluate(d=>d.open),true);await page.locator('#explore-demo').click();
await page.setViewportSize({width:390,height:844});await page.goto('http://localhost:4173/');await page.locator('#connection').filter({hasText:'Not connected'}).waitFor();await page.locator('#persistent-signin').click();assert.equal(await page.locator('#login-dialog').evaluate(d=>d.open),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.screenshot({path:'qa/signin-backend-outage-mobile.png'});await page.locator('#explore-demo').click();
statusWorks=true;await page.reload();await page.waitForFunction(()=>document.querySelector('#login-dialog').open);assert.deepEqual(errors,[]);
console.log('PASS: desktop/mobile one-click sign-in with status/setup 503, setup catch button, no mobile overflow, automatic unauthenticated sign-in, no browser exceptions.');
await browser.close();process.exit(0);
