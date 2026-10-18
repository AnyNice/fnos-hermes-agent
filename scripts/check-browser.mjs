// Real Hermes backend + official renderer, with a loopback model fixture (no paid provider).
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowserHost } from '../app/server/browser-host.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=await import(pathToFileURL(path.join(root,'.build/browser-core/node_modules/playwright/index.mjs')));
const pythonFlag=process.argv.indexOf('--python');
const python=pythonFlag<0?'python':process.argv[pythonFlag+1];
const reportRoot=await mkdtemp(path.join(root,'.build/browser-e2e-'));
const failures=[];const checks=[];let modelCalls=0;
const fixture=http.createServer(async(req,res)=>{
  if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({object:'list',data:[{id:'browser-smoke-model',object:'model',owned_by:'local-test'}]}));return;}
  if(!req.url.endsWith('/chat/completions')){res.writeHead(404);res.end();return;}
  let body='';for await(const data of req)body+=data;
  const payload=JSON.parse(body);modelCalls++;
  const slow=JSON.stringify(payload.messages).includes('INTERRUPT_BROWSER_TEST');
  const reply=slow?'中止测试流式输出。'.repeat(70):'浏览器适配验证通过。';
  if(!payload.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',model:'browser-smoke-model',choices:[{index:0,message:{role:'assistant',content:reply},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  const frame=delta=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'browser-smoke-model',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  frame({role:'assistant'});let index=0;
  const timer=setInterval(()=>{
    if(index<reply.length)frame({content:reply[index++]});
    else{clearInterval(timer);res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\ndata: [DONE]\n\n');res.end();}
  },slow?70:8);
  res.on('close',()=>clearInterval(timer));
});
fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
const portProbe=http.createServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');
const backendPort=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
const host=createBrowserHost({python,backendPort,dataRoot:path.join(reportRoot,'home')});
const base=await host.listen(0);
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1024}});
const page=await context.newPage();
page.on('pageerror',error=>failures.push(String(error)));
const attachmentResults=[];const sentMethods=[];
page.on('websocket',socket=>{
  const attachments=new Set();
  socket.on('framesent',frame=>{for(const line of String(frame.payload).split('\n')){let value;try{value=JSON.parse(line);}catch{continue;}if(value.method)sentMethods.push(value.method);if(value.method==='file.attach')attachments.add(value.id);}});
  socket.on('framereceived',frame=>{for(const line of String(frame.payload).split('\n')){let value;try{value=JSON.parse(line);}catch{continue;}if(attachments.has(value.id))attachmentResults.push(value);}});
});
const api=async(endpoint,method='GET',body)=>{
  const response=await page.request.fetch(base+endpoint,{method,...(body===undefined?{}:{data:body})});
  const value=await response.json();assert.ok(response.ok(),`${endpoint}: ${JSON.stringify(value)}`);return value;
};
const native=(endpoint,method='GET',body,profile='default')=>api('api/native'+endpoint+(endpoint.includes('?')?'&':'?')+'profile='+encodeURIComponent(profile),method,body);
async function poll(fn,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,350));}throw new Error('Verification timed out');}
try{
  await page.goto(base);
  await api('api/host/service/start','POST');
  await poll(async()=> (await api('api/host/status')).backend.state==='ready');
  checks.push('real hermes serve starts and reports 0.22.2');
  await native('/api/providers/custom-endpoints','POST',{name:'browser-smoke',base_url:`http://127.0.0.1:${fixture.address().port}/v1`,model:'browser-smoke-model',api_key:'local-fixture-key',api_mode:'chat_completions',context_length:131072,discover_models:false,make_default:true});
  await native('/api/config','PUT',{config:{compression:{enabled:false},memory:{memory_enabled:false,user_profile_enabled:false},display:{language:'zh-CN'},terminal:{cwd:reportRoot}}});
  await native('/api/profiles','POST',{name:'scope-test',clone_from_default:false,no_skills:true});
  await native('/api/config','PUT',{config:{compression:{threshold:0.73}}},'scope-test');
  assert.notEqual((await native('/api/config')).compression.threshold,0.73);
  assert.equal((await native('/api/config','GET',undefined,'scope-test')).compression.threshold,0.73);
  checks.push('two profiles keep distinct native config');
  await page.goto(base+'#/settings');
  await page.getByText(/^上下文与压缩/).click();
  await page.getByText('压缩触发比例',{exact:true}).waitFor();
  checks.push('Admin loads native advanced fields');
  const thresholdInput=page.locator('.n-form-item').filter({hasText:'压缩触发比例'}).locator('input').first();
  await thresholdInput.fill('0.61');await thresholdInput.press('Tab');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.getByText('Hermes 需要重启后才能完整应用本次配置。正在进行的对话会中断。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'稍后重启',exact:true}).click();
  await poll(async()=> (await native('/api/config')).compression.threshold===0.61);
  assert.equal((await native('/api/config','GET',undefined,'scope-test')).compression.threshold,0.73);
  assert.equal((await native('/api/config')).memory.memory_enabled,false);
  checks.push('Admin saves only edited advanced fields to the selected profile');
  await page.goto(base+'web/?profile=default');
  await page.waitForFunction(()=>/v0\.22\.2/.test(document.body.innerText),null,{timeout:45000});
  const decline=page.getByRole('button',{name:/^(No thanks|不用了)$/});if(await decline.isVisible())await decline.click();
  const composer=page.locator('[contenteditable="true"]').first();await composer.waitFor();
  await composer.fill('验证当前浏览器连接。');await composer.press('Enter');
  await poll(()=>modelCalls>0,60000);
  await page.waitForFunction(()=>document.body.innerText.includes('浏览器适配验证通过。'),null,{timeout:60000});
  await page.waitForTimeout(1000);
  assert.ok(modelCalls>0);
  const sessions=await native('/api/sessions');
  await writeFile(path.join(reportRoot,'sessions-shape.json'),JSON.stringify(sessions,null,2));
  await page.screenshot({path:path.join(reportRoot,'hermes-chat.png')});
  checks.push('official renderer submits a prompt and streams the local model response');
  await page.reload();
  await page.waitForFunction(()=>document.body.innerText.includes('浏览器适配验证通过。'),null,{timeout:45000});
  checks.push('stored conversation survives browser reload');
  const drop=await page.evaluateHandle(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['client attachment fixture'],'local-browser.txt',{type:'text/plain'}));return transfer;});
  const input=page.locator('[contenteditable="true"]').first();await input.waitFor();
  await input.dispatchEvent('drop',{dataTransfer:drop});
  await page.getByText('local-browser.txt',{exact:true}).first().waitFor();
  const previousCalls=modelCalls;
  await input.fill('验证附件传输。');await input.press('Enter');
  await poll(()=>attachmentResults.some(value=>value.result?.attached===true),45000);
  checks.push('client file drop reaches the native attachment protocol successfully');
  await poll(()=>modelCalls>previousCalls,45000);
  await page.getByRole('button',{name:/^(Stop|停止)$/}).first().waitFor({state:'hidden'});
  const countBeforeInterrupt=modelCalls;
  await input.fill('INTERRUPT_BROWSER_TEST');await input.press('Enter');
  await poll(()=>modelCalls>countBeforeInterrupt,45000);
  await page.getByRole('button',{name:/^(Stop|停止)$/}).first().click();
  await page.waitForTimeout(1000);
  assert.ok(sentMethods.some(method=>/interrupt|cancel/.test(method)),'stop did not reach native RPC');
  checks.push('Stop button interrupts a streaming native turn');
  const uploadPath=path.join(reportRoot,'home','workspace','browser-fixture.txt');
  await mkdir(path.dirname(uploadPath),{recursive:true});
  await native('/api/files/upload','POST',{path:uploadPath,data_url:'data:text/plain;base64,'+Buffer.from('browser-file-roundtrip').toString('base64'),overwrite:false});
  const download=await page.request.get(base+'api/native/api/files/download?profile=default&path='+encodeURIComponent(uploadPath));
  assert.ok(download.ok());assert.equal((await download.body()).toString(),'browser-file-roundtrip');
  checks.push('authenticated file upload and download round trip');
  for(const route of ['overview','workspace','models','tools','mcp','messaging','cron','logs','settings']){
    await page.goto(base+'#/'+route);await page.waitForTimeout(600);
    assert.ok(!(await page.locator('main').innerText()).includes('暂时无法读取'),`Admin ${route} failed`);
  }
  checks.push('all nine Admin pages load against the real backend');
  await page.goto(base+'web/?profile=scope-test#/capabilities?tab=mcp');
  await page.waitForURL(url=>url.hash==='#/mcp'&&!url.pathname.endsWith('/web/'));
  assert.equal(new URL(page.url()).searchParams.get('profile'),'scope-test');
  await page.getByRole('heading',{name:'MCP',exact:true}).waitFor();
  checks.push('work UI management routes lead to Admin with the same profile');
  await page.goto(base);await page.waitForTimeout(700);await page.screenshot({path:path.join(reportRoot,'admin-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(reportRoot,'admin-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  checks.push('mobile layout has no horizontal page overflow');
  await api('api/host/service/stop','POST');
  assert.equal((await api('api/host/status')).backend.state,'stopped');
  await page.reload();await page.getByText('已停止',{exact:true}).first().waitFor();
  const unavailable=await page.request.get(base+'api/native/api/config');assert.equal(unavailable.status(),503);
  checks.push('manual stop leaves Admin available and does not restart the backend');
  assert.deepEqual(failures,[]);
}catch(error){
  failures.push(error.stack||String(error));
  await writeFile(path.join(reportRoot,'failure-body.txt'),await page.locator('body').innerText());
  await page.screenshot({path:path.join(reportRoot,'failure.png')});
}finally{
  await writeFile(path.join(reportRoot,'report.json'),JSON.stringify({checks,failures,modelCalls,sentMethods,attachmentResults},null,2));
  await context.close();await browser.close();await host.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
}
console.log(JSON.stringify({reportRoot,checks,failures,modelCalls},null,2));
if(failures.length)process.exitCode=1;
