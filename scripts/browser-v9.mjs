// Real frontend; deterministic API fixtures. No fixture output ships in the app.
import {createRequire} from 'node:module';import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url),{chromium}=process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright'):await import('playwright');
await import('./preview.mjs');await mkdir('qa',{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.SAMVIT_CHROMIUM_PATH||undefined,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[],actions=[];let job;
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/**',async route=>{
 const req=route.request(),url=new URL(req.url());let result={};
 if(url.pathname==='/api/status')result={authenticated:true,configuredCount:0,providers:{},account:{id:'usr_browser',emailVerified:true},subscription:{planId:'pro'},billing:{enabled:false}};
 else if(url.pathname==='/api/resources')result={resources:[]};
 else if(url.pathname==='/api/projects')result={projects:[]};
 else if(url.pathname==='/api/connections')result={connections:[],combos:[],providers:[]};
 else if(url.pathname==='/api/model-catalog')result={models:[]};
 else if(url.pathname==='/api/conversations')result={conversations:[]};
 else if(url.pathname==='/api/orchestration'){
  if(req.method()==='POST'){const body=req.postDataJSON();actions.push(body.action);
   if(body.action==='create'){assert.equal(body.goal,'Explain gravity');assert.ok(body.requestId);assert.equal(body.allowWeb,false);job={id:body.requestId,goal:body.goal,status:'queued',tasks:[],modelCalls:0,toolCalls:0,spentMicroUsd:0};}
   else job.status={pause:'paused',resume:'queued',cancel:'cancelled'}[body.action];result={job};
  }else result=url.searchParams.has('id')?{job}:{jobs:job?[job]:[]};
 }
 await route.fulfill({json:result});
});
await page.goto('http://localhost:4173/');await page.locator('#universal-goal').fill('Explain gravity');await page.locator('#universal-form button[type=submit]').click();
await page.locator('[data-control=pause]').click();await page.locator('[data-control=resume]').click();await page.locator('[data-control=cancel]').click();await page.locator('#universal-progress h2').filter({hasText:'cancelled'}).waitFor();
assert.deepEqual(actions,['create','pause','resume','cancel']);
job.status='completed';job.output='<img src=x onerror=alert(1)> '+('A'.repeat(300));
await page.locator('[data-job]').first().click();await page.locator('.mission-output').waitFor();assert.equal(await page.locator('.mission-output img').count(),0);
await page.screenshot({path:'qa/v9-assistant-desktop.png'});
await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'qa/v9-assistant-mobile.png'});
await page.goto('http://localhost:4173/#agents');await page.waitForFunction(()=>!document.querySelector('#universal-form'));assert.deepEqual(errors,[]);
console.log('PASS: default assistant, create/pause/resume/cancel, escaped result, mobile layout, legacy navigation, no browser errors.');await browser.close();process.exit(0);
