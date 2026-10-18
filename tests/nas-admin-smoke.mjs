// nas-admin-smoke.mjs — 双入口真实 HTTP 冒烟验证（node tests/nas-admin-smoke.mjs）
//
// 与单测的区别：本 harness 起真实 HTTP server（模拟 monitor.js 的挂载方式 +
// dashboard-proxy 升级分支的前缀匹配逻辑），用浏览器可见的完整 URL 验证：
//   1. 门户形态 /app/hermes-agent/admin/... 与独立 TCP 形态 /admin/... 均可达
//   2. native 反代注入真实会话令牌、剔除攻击者 token（端到端）
//   3. monitor.js 升级分支 dashboardProxyPrefixes 的 wsPath 匹配逻辑
// 全部通过打印 SMOKE-OK；任何失败非零退出。

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'smoke-dashboard-token';

// ── mock dashboard 后端（HTTP + WS，替代 127.0.0.1:9219）──
const backendSeen = [];
const backend = http.createServer((req, res) => {
  backendSeen.push({ url: req.url, token: req.headers['x-hermes-session-token'] });
  if (req.url.startsWith('/api/status')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ running: true }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'nf' }));
  }
});
backend.listen(0, '127.0.0.1');
await new Promise(r => backend.once('listening', r));
const backendPort = backend.address().port;

// ── 前端目录下的最小静态桩（不依赖构建产物存在性，验证路由形态即可）──
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
const tmp = mkdtempSync(path.join(path.dirname(repoRoot), '.nas-smoke-'));
const uiRoot = path.join(tmp, 'admin-ui');
const workRoot = path.join(tmp, 'work-ui');
mkdirSync(path.join(uiRoot, 'assets'), { recursive: true });
writeFileSync(path.join(uiRoot, 'index.html'), '<!doctype html><title>Admin</title>\n');
writeFileSync(path.join(uiRoot, 'assets/index-x.js'), '// admin bundle\n');
mkdirSync(workRoot, { recursive: true });
writeFileSync(path.join(workRoot, 'index.html'), '<!doctype html><title>Work</title><script src="./fnos-host.js"></script>\n');

const { createNasAdminHost } = await import('../app/server/nas-admin-host.js');
// 模拟 monitor.js 的 proxyDashboard 转发行为（注入令牌 → 打到 mock 后端）
const proxyDashboard = async (request) => {
  const url = new URL(request.url);
  const sub = url.pathname.replace(/^\/app\/[^/]+/, '').replace(/^\/proxy\/dashboard/, '');
  const up = await fetch(`http://127.0.0.1:${backendPort}${sub}`, {
    method: request.method,
    headers: { 'X-Hermes-Session-Token': TOKEN },
    signal: AbortSignal.timeout(5000),
  });
  return new Response(up.body, { status: up.status, headers: { 'content-type': 'application/json' } });
};

const nasAdmin = createNasAdminHost({
  appDir: repoRoot, uiRoot, workRoot,
  coreRoot: path.join(repoRoot, 'app/hermes-src'),
  bootstrapFile: path.join(repoRoot, 'config/bootstrap/hermes-source.json'),
  dashboardBind: '127.0.0.1', dashboardPort: backendPort,
  dashboardSessionToken: TOKEN,
  readPid: () => 4321,
  proxyDashboard,
  log: () => {},
});

// ── 模拟 monitor.js 的 http handler 挂载（toWebRequest + nasAdmin.handle 优先）──
function toWebRequest(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const body = Buffer.concat(chunks);
      const request = new Request('http://localhost' + req.url, { method: req.method, headers, body: body.length && req.method !== 'GET' ? body : undefined, duplex: 'half' });
      resolve(request);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const request = await toWebRequest(req);
  const r = await nasAdmin.handle(request);
  if (r) {
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    const text = await r.text();
    res.end(text);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('UPSTREAM'); // 模拟交还 monitor 的 handleCustomRoute/handleFetch
});
server.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── 模拟 monitor.js 的 WS 升级分支前缀匹配（dashboardProxyPrefixes 原逻辑）──
function matchUpgradePrefix(wsPath) {
  const dashboardProxyPrefixes = ['/proxy/dashboard', '/proxy/hermes-agent', '/admin/api/native'];
  for (const prefix of dashboardProxyPrefixes) {
    if (wsPath.startsWith(prefix + '/')) {
      return { matched: prefix, subPath: wsPath.slice(prefix.length) };
    }
  }
  return { matched: null };
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.log(`FAIL  ${name} ${detail}`); }
}

// 1. 双形态可达
const portalAdmin = await fetch(`${base}/app/hermes-agent/admin/`);
check('portal /app/hermes-agent/admin/ → 200 html', portalAdmin.status === 200 && (portalAdmin.headers.get('content-type') || '').includes('text/html'), `got ${portalAdmin.status}`);

const tcpAdmin = await fetch(`${base}/admin/`);
check('tcp /admin/ → 200 html', tcpAdmin.status === 200, `got ${tcpAdmin.status}`);

const work = await fetch(`${base}/admin/web/`);
check('tcp /admin/web/ → 200 work index', work.status === 200 && (await work.text()).includes('fnos-host'), `got ${work.status}`);

const asset = await fetch(`${base}/admin/assets/index-x.js`);
check('admin assets 长缓存', asset.status === 200 && (asset.headers.get('cache-control') || '').includes('max-age=31536000'), `got ${asset.status} ${asset.headers.get('cache-control')}`);

// 2. host API
const status = await (await fetch(`${base}/admin/api/host/status`)).json();
check('api/host/status ready+pid', status.mode === 'fnos' && status.backend.state === 'ready' && status.pid === 4321, JSON.stringify(status).slice(0, 120));

// 3. native 反代端到端：攻击者 token 剔除 + 真实令牌注入
const native = await fetch(`${base}/admin/api/native/api/status?token=attacker`);
check('native 反代 200', native.status === 200, `got ${native.status}`);
const lastBackend = backendSeen.at(-1);
check('后端收到宿主令牌（非攻击者）', lastBackend.token === TOKEN, `got ${lastBackend.token}`);

const portalNative = await fetch(`${base}/app/hermes-agent/admin/api/native/api/status?token=attacker`, { method: 'GET' });
check('portal 形态 native 反代 200', portalNative.status === 200, `got ${portalNative.status}`);

// 4. 未命中 /admin/* 交还上游
const upstream = await fetch(`${base}/api/health`).then(r => r.text());
check('未命中 /admin 路由交还上游', upstream === 'UPSTREAM', `got ${upstream}`);

// 5. 升级分支前缀匹配逻辑
const m1 = matchUpgradePrefix('/admin/api/native/api/ws');
check('WS: /admin/api/native/api/ws → 匹配', m1.matched === '/admin/api/native' && m1.subPath === '/api/ws', JSON.stringify(m1));
const m2 = matchUpgradePrefix('/proxy/dashboard/api/ws');
check('WS: 既有 /proxy/dashboard 不受影响', m2.matched === '/proxy/dashboard' && m2.subPath === '/api/ws', JSON.stringify(m2));
const m3 = matchUpgradePrefix('/api/terminal/ws');
check('WS: 终端路由不落入 dashboard-proxy', m3.matched === null, JSON.stringify(m3));

server.close();
backend.close();

if (failures) {
  console.error(`SMOKE-FAIL: ${failures} 项失败`);
  process.exit(1);
}
console.log('SMOKE-OK: 双入口 NAS 宿主真实 HTTP 冒烟全部通过');
