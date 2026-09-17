// UI integration checks use explicit test fixtures; no provider credentials or paid calls.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright'):await import('playwright');
await import('./preview.mjs');
const browser=await chromium.launch({headless:true,executablePath:process.env.SAMVIT_CHROMIUM_PATH||undefined,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1050},reducedMotion:'reduce'});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('503'))errors.push(m.text());});
let plan='pro',teamBody=null,savedChat=null,connections=[],combos=[];
const event=o=>'data: '+JSON.stringify(o)+'\n\n';
await page.route('**/api/**',async route=>{
 const request=route.request(),path=new URL(request.url()).pathname,body=request.postDataJSON();
 if(path==='/api/status')return route.fulfill({json:{authenticated:true,protectedApp:true,configuredCount:1,providers:{openai:true},subscription:{planId:plan,status:'active',entitlements:{}},billing:{enabled:false}}});
 if(path==='/api/billing/status')return route.fulfill({json:{subscription:{planId:plan,status:'active'}}});
 if(path==='/api/connections'&&request.method()==='GET')return route.fulfill({json:{connections,combos,environmentTargets:[{id:'model:openai:gpt-5-mini',label:'GPT-5 Mini'}],managementConfigured:true}});
 if(path==='/api/connections'){
  assert.equal(request.headers()['x-samvit-admin-code'],'owner-code-for-test');
  if(body.action==='save'){connections.push({...body,id:'conn-'+connections.length,keyHint:'••••1234',label:body.model,enabled:true,status:'ready',verifiedFree:body.model.endsWith(':free')});delete connections.at(-1).apiKey;}
  if(body.action==='combo')combos.push({...body,id:'combo-1'});
  if(body.action==='delete')connections=connections.filter(c=>c.id!==body.id);
  return route.fulfill({json:{ok:true,message:'Saved'}});
 }
 if(path==='/api/free-models')return route.fulfill({json:{models:[{id:'fixture/alpha:free',label:'Alpha free'},{id:'fixture/beta:free',label:'Beta free'}],checkedAt:Date.now()}});
 if(path==='/api/agents'){teamBody=body;return route.fulfill({contentType:'text/event-stream',body:body.agents.map((a,i)=>event({agentStart:i,role:a.role})+event({selected:true,agent:i,model:'fixture',name:'Fixture model'})+event({agent:i,delta:`Contribution ${i+1}: <script>inert</script>`})+event({agentDone:i})).join('')+event({done:true,final:'Final fixture answer',agents:body.agents.length})});}
 if(path==='/api/routed-chat')return route.fulfill({contentType:'text/event-stream',body:event({selected:true,model:'fixture',provider:'groq'})+event({delta:'Routed fixture answer'})+event({done:true,model:'fixture',provider:'groq'})});
 if(path==='/api/conversations'&&request.method()==='POST'){savedChat={...body,id:'fixture-chat'};return route.fulfill({json:{conversation:savedChat}});}
 if(path==='/api/conversations')return route.fulfill({json:{conversations:savedChat?[savedChat]:[]}});
 return route.fulfill({json:{}});
});
async function go(route){await page.goto('http://127.0.0.1:4173/#'+route);await page.reload();await page.waitForFunction(()=>document.querySelector('#connection').textContent==='1 connected');}
try{
 await go('plans');await page.locator('[data-design-team="pro"]').click();await page.waitForSelector('.agent-card');assert.equal(await page.locator('.agent-card').count(),2);
 await page.locator('[data-job="write"]').click();await page.waitForFunction(()=>document.querySelector('[name="role0"]')?.value?.includes('Strategist'));
 await page.locator('[name="role0"]').fill('Create a launch outline');await page.locator('[name="role1"]').fill('Review it and produce the final draft');await page.locator('#team-goal').fill('Write an introduction for my project');
 await page.locator('#run-team').click();await page.waitForFunction(()=>document.querySelector('#team-status')?.textContent?.includes('Team complete'));assert.equal(teamBody.agents.length,2);assert.equal(teamBody.agents[0].role,'Create a launch outline');assert.equal(await page.locator('.contribution').count(),2);assert.equal(await page.locator('.contribution script').count(),0);
 await page.screenshot({path:'docs/v6-agents-desktop.png',fullPage:true});
 await page.locator('[data-team-plan="ultra"]').click();await page.waitForFunction(()=>document.querySelectorAll('.agent-card').length===3);assert.equal(await page.locator('#run-team').isDisabled(),true);
 plan='ultra';await go('agents');await page.waitForFunction(()=>document.querySelector('#run-team') && !document.querySelector('#run-team').disabled);assert.equal(await page.locator('.agent-card').count(),3);
 await page.locator('[data-team-plan="ultimate"]').click();await page.waitForFunction(()=>document.querySelectorAll('.agent-card').length===4);assert.equal(await page.locator('#run-team').isDisabled(),true);
 await go('connections');await page.waitForSelector('.provider-tile');assert.equal(await page.locator('.provider-tile').count(),15);
 for(const [model,name]of [['fixture/alpha:free','Alpha'],['fixture/beta:free','Beta']]){
  await page.locator('#load-free').click();await page.waitForSelector('[data-free]');await page.locator(`[data-free="${model}"]`).click();assert.equal(await page.locator('#connection-provider').inputValue(),'openrouter');
  await page.locator('#connection-owner-code').fill('owner-code-for-test');await page.locator('#connection-form [name="apiKey"]').fill('not-a-real-key-1234');await page.locator('#connection-form [name="name"]').fill(name);await page.locator('#connection-form .primary').click();await page.waitForFunction(n=>document.querySelector('#connection-list').textContent.includes(n),name);
 }
 await page.locator('#connection-owner-code').fill('owner-code-for-test');await page.locator('#combo-form [name="name"]').fill('Free writing combo');await page.locator('[name="member0"]').selectOption('conn-0');await page.locator('[name="member1"]').selectOption('conn-1');await page.locator('#combo-form .primary').click();await page.waitForFunction(()=>document.querySelector('[data-delete-combo]'));
 assert.equal(combos[0].freeOnly,true);assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>v.includes('not-a-real-key')||v.includes('owner-code-for-test'))),false);
 await page.screenshot({path:'docs/v6-connections-desktop.png',fullPage:true});
 await go('chat');await page.waitForSelector('#model-picker option[value="combo:combo-1"]',{state:'attached'});await page.locator('#model-picker').selectOption('combo:combo-1');await page.locator('#prompt').fill('Try my combo');await page.locator('#send').click();await page.waitForFunction(()=>document.querySelector('#messages').textContent.includes('Routed fixture answer'));assert.equal(await page.locator('#model-picker').inputValue(),'combo:combo-1');
 await go('appearance');await page.locator('[data-wallpaper-choice="aurora"]').click();assert.equal(await page.locator('body').getAttribute('data-wallpaper'),'aurora');await page.locator('#accent-color').selectOption('green');await page.locator('#workspace-motion').uncheck();await page.locator('#workspace-focus').check();await page.reload();await page.waitForSelector('#accent-color');assert.equal(await page.locator('#accent-color').inputValue(),'green');assert.equal(await page.locator('#workspace-motion').isChecked(),false);
 await page.locator('#wallpaper-upload').setInputFiles('docs/preview-desktop.png');await page.waitForFunction(()=>document.querySelector('#wallpaper-status').textContent.includes('saved on this device'));assert.equal(await page.locator('body').getAttribute('data-wallpaper'),'custom');await page.reload();await page.waitForFunction(()=>document.querySelector('#workspace-wallpaper')?.src.startsWith('data:image/jpeg;'));
 await page.locator('#remove-wallpaper').click();await page.waitForFunction(()=>document.body.dataset.wallpaper==='paper');await page.locator('[data-wallpaper-choice="aurora"]').click();await page.locator('#workspace-focus').uncheck();await page.locator('#accent-color').selectOption('violet');await page.screenshot({path:'docs/v6-appearance-desktop.png',fullPage:true});
 await go('chat');await page.screenshot({path:'docs/v6-workspace-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});for(const route of ['agents','connections','appearance','plans','chat']){await go(route);await page.waitForSelector('.page,.chat-page');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,route+' overflows');}
 await go('appearance');await page.screenshot({path:'docs/v6-appearance-mobile.png',fullPage:true});await page.locator('#theme-toggle').click();await page.screenshot({path:'docs/v6-appearance-mobile-dark.png',fullPage:true});
 assert.deepEqual(errors,[]);console.log('PASS: plan job selection, 2/3/4 agents, editable roles, team stream, safe output, 15 providers, save keys, free discovery, combo save/use, no browser key storage, wallpaper upload/delete/persistence, accent, focus, reduced motion and mobile layout.');
}finally{await browser.close();}
process.exit(0);
