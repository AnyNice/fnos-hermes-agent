import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from './_vendor/ws/wrapper.mjs';
import { checkOfficialCoreRelease, parseCoreVersion } from './core-release.js';
import { FeishuOnboarding } from './feishu-onboarding.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
const hopHeaders = new Set(['connection', 'upgrade', 'keep-alive', 'transfer-encoding', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);
const sessionHeader = 'X-Hermes-Session-Token';

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function safeEqual(a, b) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function createBrowserHost(options = {}) {
  const basePath = options.basePath || '/app/hermes-agent/next/';
  if (!/^\/(?:[A-Za-z0-9_-]+\/)+$/.test(basePath)) throw new Error('basePath must be an absolute directory URL.');
  const backendPort = Number(options.backendPort || 19119);
  if (!Number.isInteger(backendPort) || backendPort < 1024 || backendPort > 65535) throw new Error('Invalid backendPort');
  const token = options.backendToken || randomBytes(32).toString('base64url');
  // This standalone host is a loopback-only development entry, not the fnOS authentication layer.
  const browserSession = randomBytes(32).toString('base64url');
  const cookieName = `hermes_preview_${createHash('sha256').update(basePath).digest('hex').slice(0, 8)}`;
  const coreRoot = path.resolve(options.coreRoot || path.join(projectRoot, 'app/hermes-src'));
  const dataRoot = path.resolve(options.dataRoot || path.join(projectRoot, '.build/browser-home'));
  const python = options.python || 'python';
  const uiRoot = path.resolve(options.uiRoot || path.join(projectRoot, 'app/admin-ui'));
  const workRoot = path.resolve(options.workRoot || path.join(projectRoot, 'app/work-ui'));
  const fetchRelease = options.fetchRelease || fetch;
  const feishuOnboarding = new FeishuOnboarding({ fetchImpl: options.feishuFetch || fetch });
  const logs = [];
  let child = null;
  let lastExit = null;
  let changing = false;
  let origin;
  const upstreamSockets = new Set();
  const upgradeSockets = new Set();

  function logMeta(source, line) {
    const match=String(line).match(/\b(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\b/i);
    let level=(match?.[1]||'info').toLowerCase();if(level==='warn')level='warning';if(['critical','fatal'].includes(level))level='error';
    const logger=String(line).match(/\b(?:DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+([a-zA-Z0-9_.-]+)/i)?.[1]?.toLowerCase()||'';
    const text=`${logger} ${line}`.toLowerCase();
    const component=text.includes('gateway')?'gateway':text.includes('cron')?'cron':/\b(tool|tools|plugin|mcp)\b/.test(text)?'tools':text.includes('agent')?'agent':text.includes('hermes_cli')||text.includes('cli')?'cli':source==='host'?'host':'core';
    return {level,component};
  }

  function log(source, data) {
    const text = String(data).replaceAll(token, '[redacted]');
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      logs.push({ at: new Date().toISOString(), source, line: line.slice(0, 4000), ...logMeta(source,line) });
    }
    if (logs.length > 400) logs.splice(0, logs.length - 400);
  }

  const diskLogSources={agent:'agent.log',gateway:'gateway.log',error:'errors.log',gui:'gui.log',gateway_restart:'gateway-restart.log',gateway_close:'gateway-shutdown-diag.log',gateway_exit:'gateway-exit-diag.log'};
  async function readLogs(url) {
    const requested=url.searchParams.get('source')||'all';
    const level=url.searchParams.get('level')||'all';const component=url.searchParams.get('component')||'all';
    const limit=Math.max(50,Math.min(2000,Number(url.searchParams.get('lines')||500)||500));
    const keyword=(url.searchParams.get('keyword')||'').toLowerCase();
    let combined=[];
    for(const [source,file] of Object.entries(diskLogSources)){
      if(requested!=='all'&&requested!==source)continue;
      try{const text=await readFile(path.join(dataRoot,'logs',file),'utf8');for(const line of text.split(/\r?\n/).filter(Boolean).slice(-limit)){combined.push({at:'',source,line:line.slice(0,4000),...logMeta(source,line)});}}catch{}
    }
    // Keep the live host/service tail visible when "all" is selected, even if
    // an older on-disk log already contains more than the requested limit.
    combined.push(...logs);
    if(requested!=='all'&&['host','serve'].includes(requested))combined=combined.filter(row=>row.source===requested);
    else if(requested!=='all'&&diskLogSources[requested])combined=combined.filter(row=>row.source===requested);
    combined=combined.filter(row=>(level==='all'||row.level===level)&&(component==='all'||row.component===component)&&(!keyword||row.line.toLowerCase().includes(keyword))).slice(-limit);
    return {lines:combined,sources:['all','host','serve',...Object.keys(diskLogSources)],levels:['all','debug','info','warning','error'],components:['all','host','core','gateway','agent','tools','cli','cron']};
  }

  function appVersion() {
    const text=options.appVersion||'';if(text)return text;
    return null;
  }

  async function checkUpdates() {
    const release=JSON.parse(await readFile(path.join(projectRoot,'config/bootstrap/hermes-source.json'),'utf8'));
    const core=await checkOfficialCoreRelease(release.version,fetchRelease);
    const manifest=await readFile(path.join(projectRoot,'manifest'),'utf8');
    const current=appVersion()||manifest.match(/^version\s*=\s*([^\s]+)/m)?.[1]||'unknown';
    let app={current,latest:null,updateAvailable:false,releaseUrl:'',downloadUrl:'',publishedAt:null};
    try{
      const response=await fetchRelease('https://api.github.com/repos/AnyNice/fnos-hermes-agent/releases/latest',{headers:{Accept:'application/vnd.github+json','User-Agent':'fnos-hermes-agent'},signal:AbortSignal.timeout(15000)});
      if(response.ok){const value=await response.json();const latest=String(value.tag_name||'').replace(/^fnos-hermes-agent_v|^v/,'');const a=parseCoreVersion(current),b=parseCoreVersion(latest);const changed=a&&b?b.some((part,index)=>part!==a[index])&&b.findIndex((part,index)=>part!==a[index])>=0&&b[b.findIndex((part,index)=>part!==a[index])] > a[b.findIndex((part,index)=>part!==a[index])]:latest&&latest!==current;const asset=(value.assets||[]).find(item=>/\.fpk$/i.test(item.name||''));app={current,latest:latest||null,updateAvailable:!!changed,releaseUrl:value.html_url||'',downloadUrl:asset?.browser_download_url||'',publishedAt:value.published_at||null};}
    }catch(error){app.error=error.message;}
    return {core,app,mechanism:'fpk',hint:'通过飞牛应用中心完整升级 FPK，保留应用数据。'};
  }

  async function health() {
    try {
      const response = await fetch(`http://127.0.0.1:${backendPort}/api/status`, {
        headers: { [sessionHeader]: token }, signal: AbortSignal.timeout(1800), redirect: 'error',
      });
      if (!response.ok) return { state: 'unavailable', status: response.status };
      return { state: 'ready', native: await response.json() };
    } catch {
      return { state: child ? 'starting' : 'stopped' };
    }
  }

  async function portInUse() {
    return new Promise(resolve => {
      const socket = net.connect({ port: backendPort, host: '127.0.0.1' });
      socket.setTimeout(800);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.on('timeout', () => { socket.destroy(); resolve(true); });
    });
  }

  async function projects(profile) {
    return new Promise((resolve, reject) => {
      const url=new URL(`http://127.0.0.1:${backendPort}/api/ws`);url.protocol='ws:';url.searchParams.set('token',token);
      const ws=new WebSocket(url,{origin:`http://127.0.0.1:${backendPort}`,handshakeTimeout:5000});
      const finish=(error,value)=>{clearTimeout(timer);ws.removeAllListeners();ws.on('error',()=>{});ws.close();error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(new Error('读取工作区超时')),12000);
      ws.on('open',()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'projects.tree',params:{profile}})));
      ws.on('message',bytes=>{for(const line of bytes.toString().split('\n').filter(Boolean)){let value;try{value=JSON.parse(line);}catch{continue;}if(value.id===1)finish(value.error?new Error(value.error.message):null,value.result);}});
      ws.on('error',()=>finish(new Error('Hermes 原生服务不可用')));
      ws.on('close',()=>finish(new Error('工作区连接已关闭')));
    });
  }

  async function start() {
    if (child) return;
    if (await portInUse()) throw new Error('原生后端端口已被占用；没有接管或停止其他进程。');
    await mkdir(dataRoot, { recursive: true });
    const userHome=path.join(dataRoot,'home');await mkdir(userHome,{recursive:true});
    const running = spawn(python, ['-m', 'hermes_cli.main', 'serve', '--isolated', '--host', '127.0.0.1', '--port', String(backendPort)], {
      cwd: coreRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HERMES_HOME: dataRoot, HERMES_RUNTIME_DIR: path.join(dataRoot, 'runtime'),
        HOME:userHome, USERPROFILE:userHome,
        HERMES_DASHBOARD_SESSION_TOKEN: token, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' },
    });
    child = running;
    lastExit = null;
    running.stdout.on('data', data => log('serve', data));
    running.stderr.on('data', data => log('serve', data));
    running.on('error', error => { log('host', `启动失败：${error.code || 'process error'}`); if (child === running) child = null; });
    running.on('exit', (code, signal) => {
      lastExit = { code, signal, at: new Date().toISOString() };
      if (child === running) child = null;
      log('host', `原生后端已退出 (${code ?? signal})`);
    });
    log('host', '正在启动固定版本 Hermes serve');
  }

  async function stop() {
    const running = child;
    if (!running) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('原生后端未及时退出，请查看日志。')); }, 15_000);
      const done = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(timeout); running.off('exit', done); };
      running.once('exit', done);
      running.kill('SIGTERM');
    });
  }

  function trustedRequest(req) {
    if (req.headers.host !== new URL(origin).host) return false;
    if (req.headers.origin && req.headers.origin !== origin) return false;
    const site = req.headers['sec-fetch-site'];
    return !site || site === 'none' || site === 'same-origin';
  }
  function authenticated(req) {
    const cookie = (req.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '';
    return trustedRequest(req) && safeEqual(cookie, browserSession);
  }

  function nativePath(url) {
    const tail = url.pathname.slice((basePath + 'api/native').length);
    if (!tail.startsWith('/api/') && !tail.startsWith('/ws/')) throw new Error('Unsupported native route');
    // All real credentials stay in the host. Renderer-supplied auth must never override them.
    for (const key of ['token', 'ticket', 'internal']) url.searchParams.delete(key);
    return tail + url.search;
  }

  function proxy(req, res, url) {
    let target;
    try { target = nativePath(url); } catch { return json(res, 400, { error: '无效的原生接口路径' }); }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) =>
      !hopHeaders.has(key) && !['cookie', 'authorization', 'host', 'origin', 'x-hermes-session-token'].includes(key)));
    headers.host = `127.0.0.1:${backendPort}`;
    headers[sessionHeader] = token;
    const upstream = http.request({ hostname: '127.0.0.1', port: backendPort, path: target, method: req.method, headers }, response => {
      const outgoing = Object.fromEntries(Object.entries(response.headers).filter(([key]) =>
        !hopHeaders.has(key) && !['set-cookie', 'location', 'access-control-allow-origin'].includes(key)));
      outgoing['cache-control'] = 'no-store';
      res.writeHead(response.statusCode || 502, outgoing);
      response.pipe(res);
    });
    upstream.setTimeout(120_000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) json(res, 503, { error: 'Hermes 原生服务不可用，请在概览中启动并查看日志。' }); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  async function requestBody(req, limit = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 });
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('请求内容不是有效 JSON'), { statusCode: 400 }); }
  }

  async function applyFeishuConfig(profile, credentials, settings) {
    const script = path.join(projectRoot, 'app/server/feishu-config.py');
    const userHome = path.join(dataRoot, 'home');
    await mkdir(userHome, { recursive: true });
    return new Promise((resolve, reject) => {
      const process = spawn(python, [script], {
        cwd: coreRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...globalThis.process.env, HERMES_HOME: dataRoot, HERMES_RUNTIME_DIR: path.join(dataRoot, 'runtime'),
          HOME: userHome, USERPROFILE: userHome, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' },
      });
      const stdout = [];
      const stderr = [];
      process.stdout.on('data', chunk => stdout.push(chunk));
      process.stderr.on('data', chunk => stderr.push(chunk));
      process.on('error', reject);
      process.on('exit', code => {
        let value;
        try { value = JSON.parse(Buffer.concat(stdout).toString('utf8').trim() || '{}'); }
        catch { return reject(new Error('Hermes 飞书配置写入器返回了无效结果')); }
        if (code !== 0 || !value.ok) return reject(new Error(value.error || Buffer.concat(stderr).toString('utf8').trim() || '飞书配置保存失败'));
        resolve(value);
      });
      process.stdin.end(JSON.stringify({ profile, credentials, options: settings }));
    });
  }

  async function restartGateway(profile) {
    try {
      const url = new URL(`http://127.0.0.1:${backendPort}/api/gateway/restart`);
      url.searchParams.set('profile', profile);
      const response = await fetch(url, { method: 'POST', headers: { [sessionHeader]: token }, signal: AbortSignal.timeout(10_000) });
      const value = await response.json().catch(() => ({}));
      return response.ok ? { restart_started: true, ...value } : { restart_started: false, restart_error: value.detail || value.error || `HTTP ${response.status}` };
    } catch (error) {
      return { restart_started: false, restart_error: error.message };
    }
  }

  async function staticFile(req, res, directory, relative) {
    const resolved = path.resolve(directory, relative || 'index.html');
    if (resolved !== directory && !resolved.startsWith(directory + path.sep)) return json(res, 403, { error: 'Invalid path' });
    try {
      if (!(await stat(resolved)).isFile()) return json(res, 404, { error: 'File not found' });
      const data = await readFile(resolved);
      res.writeHead(200, { 'Content-Type': contentTypes[path.extname(resolved)] || 'application/octet-stream',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { json(res, 404, { error: '页面尚未构建，请运行对应构建脚本。' }); }
  }

  const handle = async (req, res) => {
    if (!origin || !trustedRequest(req)) return json(res, 403, { error: '只允许同源本机访问' });
    const url = new URL(req.url, origin);
    if (url.pathname === basePath.slice(0, -1) || url.pathname === '/') {
      res.writeHead(302, { Location: basePath }); return res.end();
    }
    if (!url.pathname.startsWith(basePath)) return json(res, 404, { error: 'Not found' });
    const relative = url.pathname.slice(basePath.length);
    if (!relative.startsWith('api/') && ['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Set-Cookie', `${cookieName}=${browserSession}; Path=${basePath}; HttpOnly; SameSite=Strict`);
      if (relative === 'web') { res.writeHead(302, { Location: basePath + 'web/' }); return res.end(); }
      return staticFile(req, res, relative.startsWith('web/') ? workRoot : uiRoot,
        relative.startsWith('web/') ? decodeURIComponent(relative.slice(4)) : decodeURIComponent(relative));
    }
    if (!authenticated(req)) return json(res, 401, { error: '请从管理页面重新进入。' });
    if (relative.startsWith('api/native/')) return proxy(req, res, url);
    if (relative === 'api/host/status' && req.method === 'GET') {
      return json(res, 200, { mode: 'local-preview', admin: 'ready', backend: await health(),
        pid: child?.pid || null, changing, lastExit, dataRoot, coreRoot,
        gateway: { state: 'unmanaged', detail: '此预览尚未接入飞牛通讯网关生命周期。' } });
    }
    if (relative === 'api/host/version' && req.method === 'GET') {
      const release = JSON.parse(await readFile(path.join(projectRoot, 'config/bootstrap/hermes-source.json'), 'utf8'));
      let stamp={};try{stamp=JSON.parse(await readFile(path.join(coreRoot,'install-stamp.json'),'utf8'));}catch{}
      return json(res, 200, { ...release, builtAt:stamp.builtAt||null, commitDate:stamp.commitDate||null, appVersion: appVersion() || release.version || release.tag, electronVersion: '',
        nodeVersion: process.versions.node, platform: 'browser', hermesRoot: coreRoot, updateMechanism: 'external' });
    }
    if (relative === 'api/host/logs' && req.method === 'GET') return json(res, 200, await readLogs(url));
    if (relative === 'api/host/update/check' && req.method === 'GET') {
      try{return json(res,200,await checkUpdates());}catch(error){return json(res,502,{error:error.message});}
    }
    if (relative === 'api/host/projects' && req.method === 'GET') {
      try { return json(res,200,await projects(url.searchParams.get('profile')||'default')); }
      catch(error){return json(res,503,{error:error.message});}
    }
    if (relative === 'api/host/messaging/feishu/onboarding/start' && req.method === 'POST') {
      try { return json(res, 200, await feishuOnboarding.start(await requestBody(req))); }
      catch (error) { return json(res, error.statusCode || 502, { error: error.message }); }
    }
    const feishuApply = relative.match(/^api\/host\/messaging\/feishu\/onboarding\/([^/]+)\/apply$/)?.[1];
    if (feishuApply && req.method === 'POST') {
      try {
        const body = await requestBody(req);
        const credentials = feishuOnboarding.credentials(decodeURIComponent(feishuApply));
        const saved = await applyFeishuConfig(String(body.profile || 'default'), credentials, body);
        feishuOnboarding.consume(decodeURIComponent(feishuApply));
        return json(res, 200, { ...saved, ...(await restartGateway(String(body.profile || 'default'))) });
      } catch (error) { return json(res, error.statusCode || 500, { error: error.message }); }
    }
    const feishuPairing = relative.match(/^api\/host\/messaging\/feishu\/onboarding\/([^/]+)$/)?.[1];
    if (feishuPairing && req.method === 'GET') {
      try { return json(res, 200, await feishuOnboarding.poll(decodeURIComponent(feishuPairing))); }
      catch (error) { return json(res, error.statusCode || 502, { error: error.message }); }
    }
    if (feishuPairing && req.method === 'DELETE') {
      feishuOnboarding.cancel(decodeURIComponent(feishuPairing));
      return json(res, 200, { ok: true });
    }
    const action = relative.match(/^api\/host\/service\/(start|stop|restart)$/)?.[1];
    if (action && req.method === 'POST') {
      if (changing) return json(res, 409, { error: '已有服务操作正在执行' });
      changing = true;
      try {
        if (action !== 'start') await stop();
        if (action !== 'stop') await start();
        return json(res, 200, { ok: true, backend: await health() });
      } catch (error) { return json(res, 409, { error: error.message }); }
      finally { changing = false; }
    }
    json(res, 404, { error: 'Not found' });
  };
  const server=http.createServer((req,res)=>{
    void handle(req,res).catch(()=>{if(!res.headersSent)json(res,500,{error:'请求处理失败，请查看运行日志。'});else res.destroy();});
  });

  server.on('upgrade', (req, socket, head) => {
    if (!origin || !authenticated(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const url = new URL(req.url, origin);
    if (!url.pathname.startsWith(basePath + 'api/native/')) { socket.destroy(); return; }
    let target;
    try { target = nativePath(url); } catch { socket.destroy(); return; }
    const route = new URL(target, `http://127.0.0.1:${backendPort}`);
    route.searchParams.set('token', token);
    const headers = { ...req.headers, host: `127.0.0.1:${backendPort}`, origin: `http://127.0.0.1:${backendPort}` };
    delete headers.cookie; delete headers.authorization;
    headers['x-hermes-session-token'] = token;
    const upstream = http.request({ hostname: '127.0.0.1', port: backendPort,
      path: route.pathname + route.search, headers });
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      upgradeSockets.add(socket); upstreamSockets.add(peer);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      peer.pipe(socket); socket.pipe(peer);
      socket.on('close', () => { upgradeSockets.delete(socket); peer.destroy(); });
      peer.on('close', () => { upstreamSockets.delete(peer); socket.destroy(); });
      peer.on('error', () => socket.destroy());
      socket.on('error', () => peer.destroy());
    });
    upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode || 502} Upstream Rejected\r\nConnection: close\r\n\r\n`); response.resume(); });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });

  return {
    server, basePath,
    async listen(port = 18765) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin + basePath;
    },
    async close() {
      await stop();
      for (const socket of [...upstreamSockets, ...upgradeSockets]) socket.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[process.argv.indexOf('--config') + 1];
  const options = process.argv.includes('--config') ? JSON.parse(await readFile(configPath, 'utf8')) : {};
  const host = createBrowserHost(options);
  console.log(`Hermes Admin preview: ${await host.listen(options.port)}`);
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await host.close(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
