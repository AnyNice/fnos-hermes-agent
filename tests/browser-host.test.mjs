import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from '../app/server/_vendor/ws/wrapper.mjs';
import { createBrowserHost } from '../app/server/browser-host.mjs';
import { adminPageForHash, createBrowserBridge } from '../app/browser/bridge.js';

test('host authenticates both transports, preserves scope and hides its backend credential', async t => {
  const token = 'backend-secret-known-only-to-host';
  const seen = [];
  const backend = http.createServer((req,res) => {
    seen.push({url:req.url,headers:req.headers});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ok:true}));
  });
  const sockets=new WebSocketServer({server:backend});
  sockets.on('connection',(ws,req)=>{
    seen.push({url:req.url,headers:req.headers});
    ws.on('message',bytes=>ws.send(bytes.toString()));
  });
  backend.listen(0,'127.0.0.1');await once(backend,'listening');
  const host=createBrowserHost({backendPort:backend.address().port,backendToken:token});
  const base=await host.listen(0);
  t.after(async()=>{await host.close();for(const client of sockets.clients)client.terminate();sockets.close();await new Promise(r=>backend.close(r));});

  const first=await fetch(base);
  const cookie=first.headers.get('set-cookie').split(';')[0];
  assert.match(first.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const endpoint=base+'api/native/api/config?profile=work&token=attacker';
  assert.equal((await fetch(endpoint)).status,401);
  assert.equal((await fetch(endpoint,{headers:{cookie,Origin:'https://untrusted.invalid'}})).status,403);
  assert.equal((await fetch(endpoint,{headers:{cookie,'Sec-Fetch-Site':'cross-site'}})).status,403);
  const result=await fetch(endpoint,{headers:{cookie,Authorization:'Bearer attacker','X-Hermes-Session-Token':'attacker'}});
  assert.equal(result.status,200);assert.deepEqual(await result.json(),{ok:true});
  assert.equal(seen[0].url,'/api/config?profile=work');
  assert.equal(seen[0].headers['x-hermes-session-token'],token);
  assert.equal(seen[0].headers.authorization,undefined);assert.equal(seen[0].headers.cookie,undefined);

  const url=new URL(base+'api/native/api/ws?profile=second&token=attacker');url.protocol='ws:';
  const ws=new WebSocket(url,{headers:{cookie},origin:new URL(base).origin});
  await once(ws,'open');const reply=once(ws,'message');ws.send('profile-frame');
  assert.equal((await reply)[0].toString(),'profile-frame');
  const target=new URL(seen[1].url,'http://localhost');
  assert.equal(target.searchParams.get('profile'),'second');assert.equal(target.searchParams.get('token'),token);
  ws.close();await once(ws,'close');

  const rejected=new WebSocket(url,{origin:'https://untrusted.invalid'});
  const error=once(rejected,'error');await error;rejected.terminate();
});

test('stopped backend stays stopped and unavailable reads return an error', async t=>{
  const placeholder=http.createServer();placeholder.listen(0,'127.0.0.1');await once(placeholder,'listening');
  const port=placeholder.address().port;await new Promise(r=>placeholder.close(r));
  const host=createBrowserHost({backendPort:port});const base=await host.listen(0);t.after(()=>host.close());
  const first=await fetch(base);const cookie=first.headers.get('set-cookie').split(';')[0];
  const result=await fetch(base+'api/native/api/config',{headers:{cookie}});
  assert.equal(result.status,503);assert.match((await result.json()).error,/不可用/);
  const status=await fetch(base+'api/host/status',{headers:{cookie}}).then(r=>r.json());
  assert.equal(status.backend.state,'stopped');assert.equal(status.pid,null);
  assert.equal((await fetch(base+'%zz',{headers:{cookie}})).status,500);
});

test('browser bridge captures REST owners and does not change the global active profile', async()=>{
  const calls=[];
  const browser={location:{search:'?profile=first'},fetch:async(url,init)=>{calls.push({url:new URL(url),init});return {ok:true,json:async()=>({ok:true})};}};
  const bridge=createBrowserBridge({hostRoot:'http://localhost:9876/app/hermes/next/',browser});
  const pending=bridge.api({path:'/api/config',method:'PUT',body:{config:{compression:{enabled:false}}}});
  await bridge.profile.remember('second');await pending;
  await bridge.api({path:'/api/config',profile:'third'});
  await bridge.api({path:'/api/cron/jobs?profile=all'});
  assert.deepEqual(calls.map(c=>c.url.searchParams.get('profile')),['first','third','all']);
  assert.equal(calls[0].init.credentials,'same-origin');
  assert.ok(!calls.some(c=>c.url.pathname.includes('/profiles/active')));
  assert.equal((await bridge.getConnection('third')).token,'');
  assert.equal(new URL((await bridge.getGatewayWsUrl('third')).wsUrl).pathname,'/app/hermes/next/api/native/api/ws');
  await assert.rejects(bridge.api({path:'https://untrusted.invalid/api/config'}),/Invalid/);
  await assert.rejects(bridge.api({path:'/api/config',connectionId:'other-nas'}),/only this NAS/);
  await assert.rejects(bridge.recycleBackend(),/Admin/);
});

test('dedicated management routes lead to Admin, while conversation routes stay in Hermes',()=>{
  assert.equal(adminPageForHash('#/capabilities?tab=mcp'),'mcp');
  assert.equal(adminPageForHash('#/capabilities?tab=skills'),'tools');
  assert.equal(adminPageForHash('#/messaging'),'messaging');
  assert.equal(adminPageForHash('#/cron'),'cron');
  assert.equal(adminPageForHash('#/session/saved-conversation'),null);
  assert.equal(adminPageForHash('#/settings?section=appearance'),null);
});
