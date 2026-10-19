// nas-admin-host.test.mjs — 双入口 NAS 宿主的 HTTP/WS 路由验收
// 覆盖：静态资源（两前端目录）、api/host/* 全端点、native 反代的凭据不变量
// （渲染层 token 剔除 + 门户前缀兼容）、路径穿越防护、未命中交还上游（null）、
// 飞书 onboarding 会话流（mock fetch）。
// 与 browser-host.test.mjs 同一测试模型：临时后端 fixture，不调用付费模型。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from '../app/server/_vendor/ws/wrapper.mjs';
import { createNasAdminHost } from '../app/server/nas-admin-host.js';
import { ChatOnboarding, decryptQqSecret } from '../app/server/chat-onboarding.mjs';
import { createCipheriv } from 'node:crypto';

// AES-256-GCM 加密助手：与 chat-onboarding.mjs 的 decryptQqSecret 互为逆运算，
// 用于构造 bot_encrypt_secret 测试向量。
function encryptQqSecret(plain, keyBase64, ivBase64) {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), Buffer.from(ivBase64, 'base64'));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from(ivBase64, 'base64'), enc, cipher.getAuthTag()]).toString('base64');
}
const QQ_KEY = Buffer.alloc(32, 7).toString('base64');
const QQ_IV = Buffer.alloc(12, 9).toString('base64');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'dashboard-session-secret-only-host-knows-it';

async function mockBackend(t, { wsEcho = true } = {}) {
  const seen = [];
  const backend = http.createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers['x-hermes-session-token'] });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ running: true, uptime_s: 1 }));
      return;
    }
    if (url.pathname === '/api/gateway/restart') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, pid: 4242 }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const sockets = new WebSocketServer({ server: backend });
  if (wsEcho) {
    sockets.on('connection', (ws, req) => {
      seen.push({ url: req.url, ws: true, token: new URL(req.url, 'http://127.0.0.1').searchParams.get('token') });
      ws.on('message', (bytes) => {
        let value; try { value = JSON.parse(bytes.toString()); } catch { ws.send(bytes.toString()); return; }
        if (value.method === 'projects.discover_repos') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { repos: [] } }));
        }
        if (value.method === 'projects.tree') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { projects: [{ id: 'demo', name: 'demo' }] } }));
        }
      });
    });
  }
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const port = backend.address().port;
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    await new Promise(r => backend.close(r));
  });
  return { port, seen };
}

function fakeProxyDashboard(seen) {
  return async (request) => {
    const url = new URL(request.url);
    // 模拟 monitor.js proxyDashboard：注入会话令牌、剔除 hop 头后转发到 dashboard 后端
    assert.ok(url.pathname.includes('/proxy/dashboard/'), 'native 反代必须走 /proxy/dashboard 前缀: ' + url.pathname);
    seen.push({ url: url.pathname + url.search, tokenInQuery: url.searchParams.get('token') });
    // 真打到 mock 后端，验证端到端：剥掉可选门户前缀 + /proxy/dashboard，得到原生子路径
    const sub = url.pathname
      .replace(/^\/app\/[^/]+/, '')          // 可选 /app/hermes-agent 门户前缀
      .replace(/^\/proxy\/dashboard/, '');   // /proxy/dashboard → 原生子路径
    const upstream = await fetch(`http://127.0.0.1:${seenPort}${sub}`, {
      method: request.method,
      headers: { 'X-Hermes-Session-Token': TOKEN, ...(request.headers.has('content-type') ? { 'content-type': request.headers.get('content-type') } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' } });
  };
}

let seenPort = 0;

test('nas host serves both frontends and rejects path traversal', async t => {
  const { port, seen } = await mockBackend(t);
  seenPort = port;
  const proxyCalls = [];
  const host = createNasAdminHost({
    appDir: repoRoot,
    uiRoot: path.join(repoRoot, 'app/admin-ui'),
    workRoot: path.join(repoRoot, 'app/work-ui'),
    bootstrapFile: path.join(repoRoot, 'config/bootstrap/hermes-source.json'),
    coreRoot: path.join(repoRoot, 'app/hermes-src'),
    dashboardBind: '127.0.0.1', dashboardPort: port,
    dashboardSessionToken: TOKEN,
    readPid: () => 1234,
    proxyDashboard: fakeProxyDashboard(proxyCalls),
    hermesVersion: () => '0.22.2',
    log: () => {},
  });

  // 门户前缀（/app/hermes-agent/admin/）与独立 TCP（/admin/）两种 URL 形态都支持
  for (const prefix of ['', '/app/hermes-agent']) {
    const adminPage = await host.handle(new Request(`http://nas${prefix}/admin/`));
    assert.ok(adminPage instanceof Response);
    assert.equal(adminPage.status, 200);
    assert.match(adminPage.headers.get('content-type'), /text\/html/);
    assert.match(await adminPage.text(), /<!doctype html>/i, 'admin-ui index.html 应被原样返回');
    const workPage = await host.handle(new Request(`http://nas${prefix}/admin/web/`));
    assert.equal(workPage.status, 200);
    assert.match(workPage.headers.get('content-type'), /text\/html/);
    assert.match(await workPage.text(), /fnos-host/, 'work-ui index.html 应引用 fnos-host.js');
  }

  // 静态资源内容类型（资源 hash 随构建变化，动态取真实存在的主 js）
  const adminAssets = path.join(repoRoot, 'app/admin-ui/assets');
  const realJs = (readdirSync(adminAssets).find(f => /^index-.*\.js$/.test(f))) || 'index.js';
  const js = await host.handle(new Request(`http://nas/admin/assets/${realJs}`));
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const workJs = await host.handle(new Request('http://nas/admin/web/fnos-host.js'));
  assert.equal(workJs.status, 200);
  assert.match(workJs.headers.get('content-type'), /javascript/);

  // 路径穿越：编码形式的 ..%2F 不能逃出前端目录（浏览器/URL 规范化不会吃掉编码斜杠）
  const evil = await host.handle(new Request('http://nas/admin/assets/..%2F..%2F..%2Fserver%2Fnas-admin-host.js'));
  assert.ok(evil.status === 403 || evil.status === 404, 'path traversal must not leak server files, got ' + evil.status);
  // 同时服务端文件本身对 /admin/ 路由不可达
  assert.equal(await host.handle(new Request('http://nas/server/nas-admin-host.js')), null);

  // 未命中 /admin/* → null 交还上游（monitor 的 handleCustomRoute/handleFetch）
  assert.equal(await host.handle(new Request('http://nas/api/health')), null);
  assert.equal(await host.handle(new Request('http://nas/app/hermes-agent/ui')), null);

  // ── api/host/status：ready + pid + gateway 映射 ──
  const status = await host.handle(new Request('http://nas/admin/api/host/status'));
  const s = await status.json();
  assert.equal(s.mode, 'fnos');
  assert.equal(s.backend.state, 'ready');
  assert.equal(s.pid, 1234);
  assert.equal(s.gateway.state, 'running');

  // ── api/host/version：核心版本 + 包版本 + 安装戳 ──
  const version = await (await host.handle(new Request('http://nas/admin/api/host/version'))).json();
  assert.equal(version.version, '0.22.2');
  assert.equal(version.appVersion, '0.22.2');
  assert.equal(version.platform, 'fnos');
  assert.equal(version.hermesRoot, path.join(repoRoot, 'app/hermes-src'));
  assert.ok(version.builtAt, 'install-stamp builtAt 应被读入');

  // ── api/host/logs：磁盘日志可读 + source 过滤 ──
  const tmpVar = mkdtempSync(path.join(tmpdir(), 'nas-admin-test-'));
  writeFileSync(path.join(tmpVar, 'hermes.log'), '[INFO] host boot\n[ERROR] boom\n');
  const host2 = createNasAdminHost({
    appDir: repoRoot, varDir: tmpVar, dataDir: tmpVar,
    uiRoot: path.join(repoRoot, 'app/admin-ui'), workRoot: path.join(repoRoot, 'app/work-ui'),
    bootstrapFile: path.join(repoRoot, 'config/bootstrap/hermes-source.json'),
    coreRoot: path.join(repoRoot, 'app/hermes-src'),
    dashboardBind: '127.0.0.1', dashboardPort: port,
    dashboardSessionToken: TOKEN, readPid: () => 1234,
    proxyDashboard: fakeProxyDashboard(proxyCalls), log: () => {},
  });
  const logs = await (await host2.handle(new Request('http://nas/admin/api/host/logs?source=host'))).json();
  assert.equal(logs.lines.length, 2);
  assert.equal(logs.lines[1].level, 'error');
  // 新语义：sources 只暴露本 NAS 上真实落盘（有内容）的来源；全量候选清单在 sourcesAll。
  // 本用例 tmpVar 仅写了 host 的 hermes.log，故 sources=['all','host']，未落盘的 gateway/agent 不出现，
  // 全量仍可从 sourcesAll 取到——这正是"修复当前来源没有匹配日志"的后端依据。
  assert.ok(logs.sources.includes('all') && logs.sources.includes('host'), `sources=${JSON.stringify(logs.sources)}`);
  assert.ok(!logs.sources.includes('gateway') && !logs.sources.includes('agent'), '未落盘的源不应出现在 sources');
  assert.ok(logs.sourcesAll.includes('gateway') && logs.sourcesAll.includes('agent'), 'sourcesAll 应含全量候选');

  // ── api/host/service/*：生命周期映射到注入的 start/stop ──
  let lifecycle = [];
  const host3 = createNasAdminHost({
    appDir: repoRoot,
    uiRoot: path.join(repoRoot, 'app/admin-ui'), workRoot: path.join(repoRoot, 'app/work-ui'),
    bootstrapFile: path.join(repoRoot, 'config/bootstrap/hermes-source.json'),
    coreRoot: path.join(repoRoot, 'app/hermes-src'),
    dashboardBind: '127.0.0.1', dashboardPort: port,
    dashboardSessionToken: TOKEN,
    readPid: () => 1234,
    startDashboard: async () => { lifecycle.push('start'); },
    stopDashboard: async () => { lifecycle.push('stop'); },
    proxyDashboard: fakeProxyDashboard(proxyCalls), log: () => {},
  });
  const start = await (await host3.handle(new Request('http://nas/admin/api/host/service/start', { method: 'POST' }))).json();
  assert.equal(start.ok, true);
  assert.deepEqual(lifecycle, ['start']);
  const restart = await (await host3.handle(new Request('http://nas/admin/api/host/service/restart', { method: 'POST' }))).json();
  assert.equal(restart.ok, true);
  assert.deepEqual(lifecycle, ['start', 'stop', 'start']);

  // ── native 反代：凭据不变量（攻击者 token 剔除、令牌只由宿主注入、门户前缀兼容）──
  const native = await host.handle(new Request('http://nas/admin/api/native/api/status?token=attacker&ticket=attacker'));
  assert.equal(native.status, 200);
  const last = proxyCalls.at(-1);
  assert.equal(last.url, '/proxy/dashboard/api/status');
  assert.equal(last.tokenInQuery, null, '渲染层 token 不得进入反代查询参数');
  assert.equal(seen.at(-1).token, TOKEN, '宿主必须注入真实会话令牌');

  const portal = await host.handle(new Request('http://nas/app/hermes-agent/admin/api/native/api/gateway/restart?token=attacker', { method: 'POST' }));
  assert.equal(portal.status, 200);
  assert.deepEqual(await portal.json(), { ok: true, pid: 4242 });
  // 门户形态保留 /app/hermes-agent 前缀（proxyDashboard 在 portal 模式的期望形态）
  assert.match(proxyCalls.at(-1).url, /\/proxy\/dashboard\/api\/gateway\/restart$/);
  assert.match(proxyCalls.at(-1).url, /^\/app\/hermes-agent\//, 'portal 请求应保留门户前缀');

  // 非法 native 路径（非 api/ 或 ws/ 前缀）→ 400
  const bad = await host.handle(new Request('http://nas/admin/api/native/evil'));
  assert.equal(bad.status, 400);

  // ── api/host/projects：经 dashboard WS JSON-RPC sidecar ──
  const projects = await (await host.handle(new Request('http://nas/admin/api/host/projects?profile=default'))).json();
  assert.deepEqual(projects.projects, [{ id: 'demo', name: 'demo' }]);
  const wsSeen = seen.filter(x => x.ws).at(-1);
  assert.equal(wsSeen.token, TOKEN, 'native WS 必须携带宿主令牌');

  // ── 飞书 onboarding 会话流（mock 飞书注册服务）──
  const feishuResponses = [
    { supported_auth_methods: ['client_secret'] }, // init
    { device_code: 'DC', verification_uri_complete: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=F1&user_code=U1', interval: 5, expire_in: 600, user_code: 'U1' }, // begin
  ];
  const feishuFetch = async (url) => Response.json(feishuResponses.shift() || {});
  const host4 = createNasAdminHost({
    appDir: repoRoot,
    uiRoot: path.join(repoRoot, 'app/admin-ui'), workRoot: path.join(repoRoot, 'app/work-ui'),
    bootstrapFile: path.join(repoRoot, 'config/bootstrap/hermes-source.json'),
    coreRoot: path.join(repoRoot, 'app/hermes-src'),
    dashboardBind: '127.0.0.1', dashboardPort: port,
    dashboardSessionToken: TOKEN, readPid: () => 1234,
    proxyDashboard: fakeProxyDashboard(proxyCalls), log: () => {},
    feishuFetch,
  });
  const started = await (await host4.handle(new Request('http://nas/admin/api/host/messaging/feishu/onboarding/start', {
    method: 'POST', body: JSON.stringify({ domain: 'feishu' }), headers: { 'content-type': 'application/json' },
  }))).json();
  assert.equal(started.status, 'waiting');
  assert.match(started.qr_payload, /accounts\.feishu\.cn/);
  assert.ok(started.pairing_id);
  const poll = await (await host4.handle(new Request(`http://nas/admin/api/host/messaging/feishu/onboarding/${started.pairing_id}`))).json();
  assert.equal(poll.status, 'waiting');
  // 未完成扫码直接 apply → 409
  const early = await host4.handle(new Request(`http://nas/admin/api/host/messaging/feishu/onboarding/${started.pairing_id}/apply`, {
    method: 'POST', body: JSON.stringify({ profile: 'default' }), headers: { 'content-type': 'application/json' },
  }));
  assert.equal(early.status, 409);
  // 取消会话
  const del = await host4.handle(new Request(`http://nas/admin/api/host/messaging/feishu/onboarding/${started.pairing_id}`, { method: 'DELETE' }));
  assert.deepEqual(await del.json(), { ok: true });
});

// ── 微信 / QQ 扫码会话流（mock iLink / q.qq.com 端点）──
test('wechat & qqbot onboarding: host routes + QR session + AES-GCM secret decryption', async () => {
  // 微信：iLink get_bot_qrcode → get_qrcode_status(wait → confirmed)
  const weixinStates = ['wait', 'confirmed'];
  const weixinFetch = async (url, init) => {
    const u = String(url);
    if (u.includes('get_bot_qrcode')) {
      return Response.json({ qrcode: 'HEXQR1', qrcode_img_content: 'weixin://liteapp/bot?token=HEXQR1' });
    }
    if (u.includes('get_qrcode_status')) {
      const step = weixinStates.shift() || 'wait';
      return Response.json(step === 'confirmed'
        ? { status: 'confirmed', ilink_bot_id: 'BOT-9', bot_token: 'TOK-9', baseurl: 'https://ilinkai.weixin.qq.com', ilink_user_id: 'wx-open-1' }
        : { status: step });
    }
    return Response.json({});
  };
  const qqFetch = async (url, init) => {
    const u = String(url);
    if (u.includes('create_bind_task')) {
      return Response.json({ retcode: 0, data: { task_id: 'TASK-1' } });
    }
    if (u.includes('poll_bind_result')) {
      return Response.json({ retcode: 0, data: { status: 2, bot_appid: 'APPID-1', bot_encrypt_secret: encryptQqSecret('QQ-SECRET-XYZ', QQ_KEY, QQ_IV), user_openid: 'qq-open-7' } });
    }
    return Response.json({});
  };
  const fakeProxy = fakeProxyDashboard([]);
  // 分别构造微信 / QQ 两个 host 实例（fetch 端点不同 + 可推进时钟越过 2s 轮询节流）
  let wxNow = Date.now();
  let qqNow = Date.now();
  const hostWx = createNasAdminHost({
    appDir: repoRoot, uiRoot: path.join(repoRoot, 'app/admin-ui'), workRoot: path.join(repoRoot, 'app/work-ui'),
    bootstrapFile: path.join(repoRoot, 'config/bootstrap/hermes-source.json'),
    coreRoot: path.join(repoRoot, 'app/hermes-src'),
    dashboardBind: '127.0.0.1', dashboardPort: 1, dashboardSessionToken: TOKEN, readPid: () => 1234,
    proxyDashboard: fakeProxy, log: () => {}, chatFetch: weixinFetch, chatNow: () => wxNow,
  });
  const hostQq = createNasAdminHost({
    appDir: repoRoot, uiRoot: path.join(repoRoot, 'app/admin-ui'), workRoot: path.join(repoRoot, 'app/work-ui'),
    bootstrapFile: path.join(repoRoot, 'config/bootstrap/hermes-source.json'),
    coreRoot: path.join(repoRoot, 'app/hermes-src'),
    dashboardBind: '127.0.0.1', dashboardPort: 1, dashboardSessionToken: TOKEN, readPid: () => 1234,
    proxyDashboard: fakeProxy, log: () => {}, chatFetch: qqFetch, chatNow: () => qqNow, chatKeyGen: () => QQ_KEY,
  });

  // 微信：start → waiting + liteapp QR；轮询两次到 ready
  const wxStart = await (await hostWx.handle(new Request('http://nas/admin/api/host/messaging/weixin/onboarding/start', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  }))).json();
  assert.equal(wxStart.status, 'waiting');
  assert.equal(wxStart.platform, 'weixin');
  assert.match(wxStart.qr_payload, /weixin:\/\/liteapp\/bot/);
  let wxPoll = await (await hostWx.handle(new Request(`http://nas/admin/api/host/messaging/weixin/onboarding/${wxStart.pairing_id}`))).json();
  assert.equal(wxPoll.status, 'waiting'); // wait（仍 waiting）
  wxNow += 2100; // 越过 2s 轮询节流，让第二次 poll 真正打到 iLink
  wxPoll = await (await hostWx.handle(new Request(`http://nas/admin/api/host/messaging/weixin/onboarding/${wxStart.pairing_id}`))).json();
  assert.equal(wxPoll.status, 'ready'); // confirmed → ready

  // QQ：start → waiting + q.qq.com 绑定页；一次轮询到 ready（mock 直接完成）
  const qqStart = await (await hostQq.handle(new Request('http://nas/admin/api/host/messaging/qqbot/onboarding/start', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  }))).json();
  assert.equal(qqStart.status, 'waiting');
  assert.equal(qqStart.platform, 'qqbot');
  assert.match(qqStart.qr_payload, /q\.qq\.com\/qqbot\/openclaw\/connect\.html\?task_id=TASK-1/);
  qqNow += 2100; // 越过首次 poll 的节流窗口
  const qqPoll = await (await hostQq.handle(new Request(`http://nas/admin/api/host/messaging/qqbot/onboarding/${qqStart.pairing_id}`))).json();
  assert.equal(qqPoll.status, 'ready');

  // 未知会话 → 404
  const missing = await hostQq.handle(new Request('http://nas/admin/api/host/messaging/qqbot/onboarding/nonexistent'));
  assert.equal(missing.status, 404);

  // AES-256-GCM 解密链路（核心 q.qq.com 密文布局：base64( IV ‖ ciphertext‖tag )）
  assert.equal(decryptQqSecret(encryptQqSecret('QQ-SECRET-XYZ', QQ_KEY, QQ_IV), QQ_KEY), 'QQ-SECRET-XYZ');
  assert.equal(decryptQqSecret(encryptQqSecret('with spaces & 中文 secret', QQ_KEY, QQ_IV), QQ_KEY), 'with spaces & 中文 secret');

  // 类级：未 ready 时 credentials() 抛 409
  const bare = new ChatOnboarding({ fetchImpl: weixinFetch, keyGen: () => QQ_KEY });
  const bareStart = await bare.start('weixin');
  assert.throws(() => bare.credentials(bareStart.pairing_id), (e) => e.statusCode === 409);

  // 取消会话
  const del = await hostWx.handle(new Request(`http://nas/admin/api/host/messaging/weixin/onboarding/${wxStart.pairing_id}`, { method: 'DELETE' }));
  assert.deepEqual(await del.json(), { ok: true });
});

// GitHub PAT 落盘 + update/check 带 Bearer + fallback 双保险
test('GitHub PAT: save/clear 0600 落盘 + check 带 Authorization + releases fallback', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'nas-host-pat-'));
  const patFile = path.join(tmp, 'github_pat');
  const calls = [];
  const ghMock = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, auth: init.headers?.Authorization || null });
    if (u.includes('NousResearch/hermes-agent')) {
      return Response.json({ tag_name: 'v0.23.0', prerelease: false, draft: false, html_url: 'https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.0', published_at: '2026-06-01' });
    }
    if (u.includes('AnyNice/fnos-hermes-agent')) {
      // per_page=1 返回空数组 → 触发 releases/latest fallback（双保险）
      if (u.includes('per_page=1')) return Response.json([]);
      return Response.json({ tag_name: 'fnos-hermes-agent_v0.19.0', html_url: 'https://github.com/AnyNice/fnos-hermes-agent/releases/tag/v0.19.0', body: '新增双入口 + 微信/QQ 扫码', published_at: '2026-10-01', assets: [{ name: 'hermes-agent_0.19.0.fpk', browser_download_url: 'https://github.com/AnyNice/fnos-hermes-agent/releases/download/v0.19.0/hermes-agent_0.19.0.fpk' }] });
    }
    return Response.json({});
  };
  // 隔离 env PAT（本机可能设了 GITHUB_TOKEN），测完恢复
  const savedEnv = [process.env.GITHUB_TOKEN, process.env.GITHUB_PAT];
  delete process.env.GITHUB_TOKEN; delete process.env.GITHUB_PAT;
  const host = createNasAdminHost({
    appDir: repoRoot, uiRoot: path.join(repoRoot, 'app/admin-ui'), workRoot: path.join(repoRoot, 'app/work-ui'),
    bootstrapFile: path.join(repoRoot, 'config/bootstrap/hermes-source.json'),
    coreRoot: path.join(repoRoot, 'app/hermes-src'),
    dashboardBind: '127.0.0.1', dashboardPort: 1, dashboardSessionToken: TOKEN, readPid: () => 1234,
    proxyDashboard: fakeProxyDashboard([]), log: () => {}, fetchRelease: ghMock,
    githubRepo: 'AnyNice/fnos-hermes-agent', githubPatFile: patFile,
  });
  try {
    // 1) 初始无 PAT → check 里带 null Authorization，fallback 已生效（per_page=1 空 → latest）
    let r = await host.handle(new Request('http://nas/admin/api/host/update/check'));
    let body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.github.hasPat, false);
    assert.equal(body.github.source, 'none');
    assert.equal(body.app.latest, '0.19.0');
    // 回归捕获：app.current 必须走 FPK 版本轨（= 仓库 manifest 版本号），
    // 而非核心版本轨（hermesVersion）或 'unknown'。修前 current=appVersion，
    // 会与 GitHub tag 跨轨混比 → updateAvailable 失真。
    const manifestNow = readFileSync(path.join(repoRoot, 'manifest'), 'utf8').match(/^version\s*=\s*([\d.]+)/m)?.[1];
    assert.ok(manifestNow, '测试前提：仓库 manifest 应有版本号');
    assert.equal(body.app.current, manifestNow, 'app.current 应取 manifest FPK 版本轨');
    // mock latest(0.19.0) < 任何真实 FPK 版号 → 同轨比较后应为 false
    assert.equal(body.app.updateAvailable, false, 'FPK 轨可比后：旧 latest 不应判为可更新');
    assert.match(body.app.body, /双入口/);
    assert.match(body.app.downloadUrl, /hermes-agent_0\.19\.0\.fpk/);
    assert.equal(body.app.error, undefined);
    // fallback 双保险：AnyNice 域名先打 per_page=1，空再打 latest
    const anyNice = calls.filter(c => c.url.includes('AnyNice'));
    assert.ok(anyNice.length >= 2, '应触发 fallback（per_page=1 + latest 两次）');
    assert.match(anyNice[0].url, /per_page=1/);
    assert.match(anyNice[1].url, /releases\/latest/);
    assert.equal(anyNice[0].auth, null); // 无 PAT 不带 Authorization
    assert.equal(anyNice[1].auth, null);

    // 2) 保存 PAT → 落盘 0600
    const saveRes = await host.handle(new Request('http://nas/admin/api/host/update/token', { method: 'POST', body: JSON.stringify({ pat: ' ghp_TEST123 ' }), headers: { 'content-type': 'application/json' } }));
    assert.deepEqual(await saveRes.json(), { ok: true, saved: true });
    assert.ok(existsSync(patFile), 'PAT 应落盘');
    assert.equal(readFileSync(patFile, 'utf8').trim(), 'ghp_TEST123'); // trim 前后空白 + 换行
    if (process.platform !== 'win32') assert.equal(statSync(patFile).mode & 0o777, 0o600, 'POSIX：权限应 0600');

    // 3) 有 PAT → check 带 Bearer，source=file
    calls.length = 0;
    r = await host.handle(new Request('http://nas/admin/api/host/update/check'));
    body = await r.json();
    assert.equal(body.github.hasPat, true);
    assert.equal(body.github.source, 'file');
    assert.equal(calls.find(c => c.url.includes('AnyNice'))?.auth, 'Bearer ghp_TEST123');

    // 4) env 优先于落盘
    process.env.GITHUB_TOKEN = 'ghp_FROM_ENV';
    r = await host.handle(new Request('http://nas/admin/api/host/update/check'));
    body = await r.json();
    assert.equal(body.github.source, 'env');
    delete process.env.GITHUB_TOKEN;

    // 5) 清除 PAT（空字符串）→ 删文件
    const clearRes = await host.handle(new Request('http://nas/admin/api/host/update/token', { method: 'POST', body: JSON.stringify({ pat: '   ' }), headers: { 'content-type': 'application/json' } }));
    assert.deepEqual(await clearRes.json(), { ok: true, saved: false });
    assert.ok(!existsSync(patFile), '清除后 PAT 文件应删除');
  } finally {
    process.env.GITHUB_TOKEN = savedEnv[0]; process.env.GITHUB_PAT = savedEnv[1];
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});
