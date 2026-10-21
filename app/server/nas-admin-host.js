// nas-admin-host.js — 双入口（Hermes Admin + 桌面端工作台）NAS 宿主
//
// 设计要点（详见 docs/BROWSER-ADAPTATION.md「接入安装包前的门槛」）：
//   - 不新增任何进程：native 后端复用 monitor 已管理的 `hermes dashboard`
//     (127.0.0.1:DASHBOARD_PORT)，鉴权令牌 DASHBOARD_SESSION_TOKEN 由宿主注入，
//     与 /proxy/dashboard 的暴露面一致。
//   - 静态资源：/admin/ → app/admin-ui（Hermes Admin），/admin/web/ → app/work-ui
//     （官方 Desktop 浏览器版工作台）。两个前端 bundle 的 API base 都是相对
//     hostRoot 计算（admin-ui: new URL("./", location)；work-ui: new URL("../", ...)），
//     因此 api/host/* 与 api/native/* 统一挂在 /admin/ 目录下。
//   - api/host/service/* 映射到 monitor 的 dashboard 进程生命周期
//     （spawnHermes / stopPid），不接管网关（网关仍由旧 UI /api/start|stop 管理）。
//   - 飞书 onboarding 复用 FeishuOnboarding + feishu-config.py，python 指向 NAS venv。
//
// 本模块由 monitor.js 在 handleCustomRoute 之前调用 handle(request)；
// 命中 /admin/* 返回 Response，否则返回 null 交还上游。独立于旧控制台，
// 任何运行时错误只影响双入口，不破坏 chat / status / dashboard 既有功能。

import path from 'node:path';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import WSClib from './_vendor/ws/wrapper.mjs';
import { checkOfficialCoreRelease, parseCoreVersion } from './core-release.js';
import { FeishuOnboarding } from './feishu-onboarding.mjs';
import { ChatOnboarding } from './chat-onboarding.mjs';

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res, status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ── 日志级别/组件启发式（与 browser-host.mjs 保持一致，Admin 日志页数据驱动）──
function logMeta(source, line) {
  const match = String(line).match(/\b(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\b/i);
  let level = (match?.[1] || 'info').toLowerCase();
  if (level === 'warn') level = 'warning';
  if (['critical', 'fatal'].includes(level)) level = 'error';
  const logger = String(line).match(/\b(?:DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+([a-zA-Z0-9_.-]+)/i)?.[1]?.toLowerCase() || '';
  const text = `${logger} ${line}`.toLowerCase();
  const component = text.includes('gateway') ? 'gateway'
    : text.includes('cron') ? 'cron'
    : /\b(tool|tools|plugin|mcp)\b/.test(text) ? 'tools'
    : text.includes('agent') ? 'agent'
    : text.includes('hermes_cli') || text.includes('cli') ? 'cli'
    : source === 'host' ? 'host' : 'core';
  return { level, component };
}

export function createNasAdminHost(options = {}) {
  const appDir = options.appDir || '/var/apps/hermes-agent';
  const dataDir = options.dataDir || `${appDir}/home/data`;
  const varDir = options.varDir || `${appDir}/var`;
  const coreRoot = options.coreRoot || path.join(appDir, 'hermes-src');
  const uiRoot = options.uiRoot || path.join(appDir, 'admin-ui');
  const workRoot = options.workRoot || path.join(appDir, 'work-ui');
  const bootstrapFile = options.bootstrapFile || path.join(appDir, 'config/bootstrap/hermes-source.json');
  const feishuScript = options.feishuScript || path.join(appDir, 'server/feishu-config.py');
  const dashboardBind = options.dashboardBind || '127.0.0.1';
  const dashboardPort = Number(options.dashboardPort || 9219);
  const dashboardSessionToken = options.dashboardSessionToken;
  const gatewayPidPath = options.gatewayPidPath || path.join(varDir, 'gateway.pid');
  const dashboardPidPath = options.dashboardPidPath || path.join(varDir, 'dashboard.pid');
  const readPid = options.readPid || (() => null);
  const isPortListening = options.isPortListening || (() => false);
  const dashboardSpawnTs = options.dashboardSpawnTs || (() => 0);
  const dashboardGraceMs = Number(options.dashboardGraceMs || 120000);
  const stopDashboard = options.stopDashboard || (async () => {});
  const startDashboard = options.startDashboard || (() => ({ ok: false, error: '未配置' }));
  const startGateway = options.startGateway || (() => ({ ok: false, error: '网关启停未配置' }));
  const stopGateway = options.stopGateway || (async () => {});
  const gatewayProviderReady = options.gatewayProviderReady || (() => false);
  const proxyDashboard = options.proxyDashboard || (async () => json(null, 503, { error: '原生后端代理不可用' }));
  const hermesVersion = options.hermesVersion || (() => 'unknown');
  const log = options.log || (() => {});
  const fetchRelease = options.fetchRelease || fetch;
  const python = options.python || `${dataDir}/venv/bin/python3`;
  const githubRepo = options.githubRepo || 'AnyNice/fnos-hermes-agent';
  const githubPatFile = options.githubPatFile || path.join(varDir, 'github_pat');
  const basePath = '/admin';

  const diskLogSources = {
    host: [path.join(varDir, 'hermes.log')],
    dashboard: [path.join(varDir, 'dashboard.log')],
    gateway: [path.join(varDir, 'gateway.log'), path.join(dataDir, 'logs', 'gateway.log')],
    agent: [path.join(dataDir, 'logs', 'agent.log')],
    error: [path.join(dataDir, 'logs', 'errors.log')],
    gui: [path.join(dataDir, 'logs', 'gui.log')],
    gateway_restart: [path.join(dataDir, 'logs', 'gateway-restart.log')],
    gateway_close: [path.join(dataDir, 'logs', 'gateway-shutdown-diag.log')],
    gateway_exit: [path.join(dataDir, 'logs', 'gateway-exit-diag.log')],
  };

  let changing = false;
  const feishuOnboarding = new FeishuOnboarding({ fetchImpl: options.feishuFetch || fetch });
  const chatOnboarding = new ChatOnboarding({ fetchImpl: options.chatFetch || fetch, now: options.chatNow || (() => Date.now()), keyGen: options.chatKeyGen });

  // ── 日志（与 browser-host 相同的过滤语义；NAS 无内存 tail，直接读磁盘文件）──
  // 各日志源的文件清单是"候选路径"：NAS 上只有真实存在（且非空）的文件才有日志。
  // 每个源探测真实落点，前端据此区分"有日志的来源"与"本来源无日志文件"，
  // 不再让未落盘的来源在前端显示"当前来源没有匹配日志"这种误导性空态。
  async function probeLogSources() {
    const probe = new Map();
    for (const [source, files] of Object.entries(diskLogSources)) {
      const present = [];
      for (const file of files) {
        try {
          const st = await stat(file);
          if (st.isFile() && st.size > 0) present.push(file);
        } catch {}
      }
      probe.set(source, { files: present, present: present.length > 0 });
    }
    return probe;
  }

  // ── Hermes 进程资源占用（/proc 采样；CPU 为相邻两次调用间隔内的平均，首帧无基线返回 0）──
  const resourceSamples = new Map();
  const CLK_TCK = 100; // Linux /proc stat 的 utime/stime 单位（clock ticks）
  function readProcPid(pid) {
    let utime = 0, stime = 0, rssMb = 0, alive = false;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      // rest[0]=field3(state)；utime=field14=rest[11]，stime=field15=rest[12]
      utime = Number(rest[11]) || 0;
      stime = Number(rest[12]) || 0;
      alive = true;
    } catch {}
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/^VmRSS:\s+(\d+) kB/im);
      if (m) { rssMb = Math.round(Number(m[1]) / 1024); alive = true; }
    } catch {}
    return { utime, stime, rssMb, alive };
  }
  function hostResources() {
    // 方案A（v159）：同时给「单核当量」与「整机口径」。右卡 FnNAS 系统监控用整机多核百分比
    // （4 核 32% ≈ 1.28 核当量），与此处 total.cpuPercent（单核口径合计，可 >100%）不同基准，
    // 并排易误读为"进程比机器还满"。核数用 availableParallelism（尊重 cgroup/容器限制，
    // 比 os.cpus().length 更准），兜底 1，避免容器限制到 1 核时整机口径被放大。
    const cores = Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
    const targets = [
      { key: 'monitor', label: '宿主 monitor', pid: process.pid },
      { key: 'dashboard', label: 'Hermes 工作服务', pid: readPid(dashboardPidPath) },
      { key: 'gateway', label: '通讯网关', pid: readPid(gatewayPidPath) },
    ];
    const now = Date.now();
    const processes = [];
    let totalCpu = 0, totalMem = 0;
    for (const t of targets) {
      const pid = t.pid;
      const rec = { key: t.key, label: t.label, pid: pid || null, running: false, cpuPercent: 0, cpuPercentOfMachine: 0, memoryMb: null };
      if (pid) {
        const sample = readProcPid(pid);
        if (sample.alive) {
          rec.running = true;
          rec.memoryMb = sample.rssMb;
          const prev = resourceSamples.get(t.key);
          if (prev && prev.pid === pid) {
            const wallDeltaS = Math.max(0.05, (now - prev.wall) / 1000); // 下限 50ms 防除零
            const cpuTicks = Math.max(0, (sample.utime - prev.utime) + (sample.stime - prev.stime));
            rec.cpuPercent = Math.max(0, (cpuTicks / CLK_TCK) / wallDeltaS * 100);
          }
          rec.cpuPercentOfMachine = Math.round((rec.cpuPercent / cores) * 10) / 10; // 相对整机容量（÷核数）
          resourceSamples.set(t.key, { pid, wall: now, utime: sample.utime, stime: sample.stime });
          totalCpu += rec.cpuPercent;
          totalMem += rec.memoryMb || 0;
        }
      }
      processes.push(rec);
    }
    return {
      updatedAt: now,
      total: {
        running: processes.some(p => p.running),
        cpuPercent: Math.round(totalCpu * 10) / 10, // 单核当量（多核可 >100%），历史字段保留
        cpuPercentOfMachine: Math.round((totalCpu / cores) * 10) / 10, // 整机口径（0–100，÷核数），与系统监控同基准
        cpuCores: cores,
        memoryMb: totalMem,
      },
      processes,
      note: 'CPU 单核当量（相对单核，多核可 >100%）；cpuPercentOfMachine 为相对整机容量（÷核数），与 FnNAS 系统监控同口径可直接对比；内存为 RSS。',
    };
  }

  async function readLogs(url) {
    const requested = url.searchParams.get('source') || 'all';
    const level = url.searchParams.get('level') || 'all';
    const component = url.searchParams.get('component') || 'all';
    const limit = Math.max(50, Math.min(2000, Number(url.searchParams.get('lines') || 500) || 500));
    const keyword = (url.searchParams.get('keyword') || '').toLowerCase();
    const available = await probeLogSources();
    let combined = [];
    for (const [source, info] of available.entries()) {
      if (requested !== 'all' && requested !== source) continue;
      for (const file of info.files) {
        try {
          const text = await readFile(file, 'utf8');
          for (const line of text.split(/\r?\n/).filter(Boolean).slice(-limit)) {
            combined.push({ at: '', source, line: line.slice(0, 4000), ...logMeta(source, line) });
          }
        } catch {}
      }
    }
    combined = combined
      // 级别按"最低级别"语义（DEBUG<INFO<WARNING<ERROR），与前端"X 及以上"一致
      .filter(row => {
        const order = { debug: 0, info: 1, warning: 2, error: 3 };
        const levelOk = level === 'all' || (order[row.level] ?? 1) >= (order[level] ?? 1);
        const compOk = component === 'all' || row.component === component;
        const kwOk = !keyword || row.line.toLowerCase().includes(keyword);
        return levelOk && compOk && kwOk;
      })
      .slice(-limit);
    // 来源清单：仅暴露本 NAS 上真实落盘（有内容）的来源；"all" 永远在。
    const presentSources = ['all', ...[...available.entries()].filter(([, info]) => info.present).map(([s]) => s)];
    return {
      lines: combined,
      sources: presentSources,
      sourcesAll: ['all', ...Object.keys(diskLogSources)],
      levels: ['all', 'debug', 'info', 'warning', 'error'],
      components: ['all', 'host', 'core', 'gateway', 'agent', 'tools', 'cli', 'cron'],
      note: requested !== 'all' && !available.get(requested)?.present ? `当前来源（${requested}）在本机没有落盘日志文件。` : '',
    };
  }

  // ── 原生后端健康检查（复用 dashboard 9219，注入会话令牌）──
  // 修「状态卡永远卡 starting」：旧版 fetch 一旦抛异常就无脑回 starting，
  // 而 dashboard 其实早已 READY（log: 17:19 DASHBOARD_READY，17:32 service start 仍报 starting）→
  // UI 观感"一直在重复启动"，实际进程稳定运行中。现按「端口 LISTEN > 冷启动宽限期 > pid 判死」
  // 三级判据回真实状态：端口在监听 = 已就绪；进程在但端口未起且仍在冷启动宽限期内 = starting；
  // 进程在但超宽限期仍无端口 = unresponsive（挂死，提示手动重启）；无 pid = stopped。
  async function health() {
    try {
      const response = await fetch(`http://${dashboardBind}:${dashboardPort}/api/status`, {
        headers: { 'X-Hermes-Session-Token': dashboardSessionToken },
        signal: AbortSignal.timeout(1800),
        redirect: 'error',
      });
      if (!response.ok) return { state: 'unavailable', status: response.status };
      return { state: 'ready', native: await response.json() };
    } catch {
      const dp = readPid(dashboardPidPath);
      if (isPortListening(dashboardPort)) {
        // 端口 LISTEN = dashboard web server 已起（READY 即监听 9219）。/api/status 瞬断/鉴权抖动不算故障。
        return { state: 'ready', portListening: true, pid: dp || null };
      }
      if (dp) {
        const inGrace = Date.now() - dashboardSpawnTs() < dashboardGraceMs;
        return inGrace
          ? { state: 'starting', pid: dp }
          : { state: 'unresponsive', pid: dp, hint: '工作服务进程存活但端口未监听（可能挂死），可点「启动工作服务」重新拉起' };
      }
      return { state: 'stopped' };
    }
  }

  async function versionInfo() {
    let release = {};
    try { release = JSON.parse(await readFile(bootstrapFile, 'utf8')); } catch {}
    let stamp = {};
    try { stamp = JSON.parse(await readFile(path.join(coreRoot, 'install-stamp.json'), 'utf8')); } catch {}
    let manifestVersion = '';
    try {
      const manifest = await readFile(path.join(appDir, 'manifest'), 'utf8');
      manifestVersion = manifest.match(/^version\s*=\s*([\d.]+)/m)?.[1] || '';
    } catch {}
    // v158：FPK 版本源优先级——hermes-version.env 的 APP_VERSION（打包器与 manifest 同步校验、
    //   保证部署到设备；FPK 框架不部署 manifest 到应用目录 → 读不到时版本轨掉回核心版本，
    //   即 NAS 上"应用 0.22.2 → 0.21.157"混轨显示 + 更新检查恒"无更新"的根因）
    //   → APP_DIR/manifest（仓库/测试场景兜底）→ 核心版本（仅最后兜底，会混轨，标记 source）。
    let fpkVersion = manifestVersion, fpkVersionSource = manifestVersion ? 'manifest' : 'unknown';
    try {
      const envText = await readFile(path.join(appDir, 'config/bootstrap/hermes-version.env'), 'utf8');
      const m = envText.match(/^APP_VERSION\s*=\s*([\d.]+)/m);
      if (m?.[1]) { fpkVersion = m[1]; fpkVersionSource = 'hermes-version.env'; }
    } catch {}
    return {
      ...release,
      builtAt: stamp.builtAt || null,
      commitDate: stamp.commitDate || null,
      appVersion: hermesVersion() || manifestVersion || release.version || 'unknown',
      // FPK 应用版本轨（hermes-version.env APP_VERSION / manifest，与 GitHub release tag 同轨）。
      // 核心版本（hermesVersion）只属于 core 轨；update/check 的 app.current 必须用它，
      // 否则核心 0.22.2 与 FPK tag 0.21.x 混比 → updateAvailable 恒 false。
      fpkVersion: fpkVersion || 'unknown',
      fpkVersionSource,
      electronVersion: '',
      nodeVersion: process.versions.node,
      platform: 'fnos',
      hermesRoot: coreRoot,
      updateMechanism: 'external',
    };
  }

  async function checkUpdates() {
    const release = JSON.parse(await readFile(bootstrapFile, 'utf8'));
    const core = await checkOfficialCoreRelease(release.version, fetchRelease);
    const version = await versionInfo();
    // app 轨 current 必须用 FPK 版本（manifest），与 GitHub tag 同轨可比；
    // 取不到 manifest 时才退回 appVersion（可能带核心版本串，解析失败走 latest!==current 兜底）。
    const current = version.fpkVersion && version.fpkVersion !== 'unknown' ? version.fpkVersion : version.appVersion;
    let app = { current, latest: null, updateAvailable: false, releaseUrl: '', downloadUrl: '', body: '', publishedAt: null };
    const ghHeaders = () => {
      const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'fnos-hermes-agent' };
      const pat = getGitHubPAT();
      if (pat) headers.Authorization = `Bearer ${pat}`;
      return headers;
    };
    // 取最新 release：按 published_at 倒序（对齐上游 fetchLatestPublishedRelease，防拉到重建旧版）；
    // 网络抖动/限流拿不到时兜底退 releases/latest（双保险，对齐原版健壮性）。
    let data = null;
    try {
      data = (await fetchLatestPublishedRelease(ghHeaders())).data;
      if (!data) {
        const lr = await fetchRelease(`https://api.github.com/repos/${githubRepo}/releases/latest`, { headers: ghHeaders(), signal: AbortSignal.timeout(15000) });
        if (lr.ok) data = await lr.json();
      }
      if (data && data.tag_name) {
        const latest = String(data.tag_name).replace(/^fnos-hermes-agent_v|^v/, '').trim();
        const a = parseCoreVersion(current);
        const b = parseCoreVersion(latest);
        const idx = a && b ? b.findIndex((part, i) => part !== a[i]) : -1;
        const changed = a && b ? (idx >= 0 && b[idx] > a[idx]) : latest !== current;
        const asset = (data.assets || []).find(item => /\.fpk$/i.test(item.name || ''));
        app = { current, latest: latest || null, updateAvailable: !!changed, releaseUrl: data.html_url || '', downloadUrl: asset?.browser_download_url || '', body: data.body || '', publishedAt: data.published_at || null };
      }
    } catch (error) {
      app.error = error.message;
    }
    return { core, app, mechanism: 'fpk', hint: '通过飞牛应用中心安装新版 FPK 完成升级，应用数据保留。' };
  }

  // ── GitHub PAT（落盘 var/github_pat 0600；查 release 时带 Bearer 绕过未认证 60/h 限流）──
  // PAT 三级优先级（对齐上游 githubPatDefault 设计）：env > 落盘 var/github_pat（用户手填 0600）> 构建注入默认值。
  // 默认值显式空串（保留 ?? 真值语义）——源码零 PAT 字面量：避免 GitHub Push Protection 拦截 + 随公开 Release 资产泄露；
  // 需要内置 PAT 时走构建/环境注入，不在 git 里写字面量。
  function getGitHubPAT() {
    const fromEnv = String(process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || '').trim();
    if (fromEnv) return fromEnv;
    try { if (existsSync(githubPatFile)) return readFileSync(githubPatFile, 'utf8').trim(); } catch {}
    return String(options.githubPatDefault ?? '');
  }

  // 取「最新发布」release：按 published_at 倒序（而非 per_page=1 的 created_at 倒序——
  // 重建过的旧 release 会排在前面导致热更拉到旧版本，对齐上游 fetchLatestPublishedRelease）。
  // 仅走 api.github.com 列表接口；调用方保留 releases/latest 兜底双保险（网络抖动不再整条报错）。
  async function fetchLatestPublishedRelease(headers) {
    const r = await fetchRelease(`https://api.github.com/repos/${githubRepo}/releases?per_page=30`, {
      signal: AbortSignal.timeout(15000), headers,
    });
    if (!r.ok) return { data: null, status: r.status };
    const list = await r.json();
    const published = (Array.isArray(list) ? list : []).filter(x => !x.draft && x.published_at);
    if (!published.length) return { data: null, status: r.status };
    published.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
    return { data: published[0], status: r.status };
  }

  async function saveGitHubPAT(pat) {
    const value = String(pat || '').trim();
    if (value) {
      writeFileSync(githubPatFile, value + '\n', { mode: 0o600 });
      return { ok: true, saved: true };
    }
    try { if (existsSync(githubPatFile)) unlinkSync(githubPatFile); } catch {}
    return { ok: true, saved: false };
  }
  const patState = () => ({ hasPat: !!getGitHubPAT(), source: String(process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || '').trim() ? 'env' : (existsSync(githubPatFile) ? 'file' : (options.githubPatDefault ? 'builtin' : 'none')) });

  // ── 取「最新发布」的 FPK 资产（不比较版本，只拿下载直链）——供 update/download 服务端代下 ──
  async function latestFpkAsset() {
    const ghHeaders = () => {
      const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'fnos-hermes-agent' };
      const pat = getGitHubPAT();
      if (pat) headers.Authorization = `Bearer ${pat}`;
      return headers;
    };
    let data = null;
    try {
      data = (await fetchLatestPublishedRelease(ghHeaders())).data;
      if (!data) {
        const lr = await fetchRelease(`https://api.github.com/repos/${githubRepo}/releases/latest`, { headers: ghHeaders(), signal: AbortSignal.timeout(15000) });
        if (lr.ok) data = await lr.json();
      }
    } catch (e) { return { error: `查询最新 Release 失败：${e.message}` }; }
    const asset = (data?.assets || []).find(a => /\.fpk$/i.test(a?.name || ''));
    if (!data || !asset?.browser_download_url) return { error: '未找到 FPK 下载资产' };
    return {
      tag: String(data.tag_name || '').replace(/^fnos-hermes-agent_v|^v/, '').trim(),
      name: asset.name,
      url: asset.browser_download_url,
      body: data.body || '',
      publishedAt: data.published_at,
    };
  }

  // 把首块（已读做 gzip 头校验）与后续流合并为 async iterable，供 Response 流式透传。
  async function* streamConcat(first, reader) {
    if (first && first.value && first.value.length) yield Buffer.from(first.value);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) yield Buffer.from(value);
    }
  }

  // 服务端代下 FPK：浏览器只面对「同源 + Content-Disposition + Content-Length」，原生下载器显示进度；
  // 网络出口走 NAS 自身，按「GitHub 加速中继（大陆可达）→ GitHub 直连」多通道依次尝试，取第一个成功。
  // 根治「前端 <a target=_blank> 直连 github.com 在飞牛 webview 里跨站被拦 + 国内直连 310MB 卡死」问题。
  async function downloadFpkStream() {
    const asset = await latestFpkAsset();
    if (asset.error) return json(null, 404, { error: asset.error });
    // 通道顺序（首成功即用，对齐上游 ghfast.top 优先策略，大陆实测 ~2.6MB/s；中继失败/回 HTML 预览页时由 gzip 魔数校验自动切下一通道）
    const ghfastBase = (process.env.HERMES_GHFST || 'https://ghfast.top/').replace(/\/+$/, '');
    const ghproxyBase = (process.env.HERMES_GHPROXY || 'https://ghproxy.net/').replace(/\/+$/, '');
    const rel = asset.url.replace(/^https?:\/\//, ''); // github.com/AnyNice/.../releases/download/...
    const channels = [
      { label: 'ghfast.top 加速中继', url: `${ghfastBase}/${rel}`, timeoutMs: 900000 },
      { label: 'ghproxy 加速中继', url: `${ghproxyBase}/${rel}`, timeoutMs: 180000 },
      { label: 'GitHub 直连', url: asset.url, timeoutMs: 600000 },
    ];
    let lastErr = '';
    for (const ch of channels) {
      let up = null;
      try {
        up = await fetchRelease(ch.url, { signal: AbortSignal.timeout(ch.timeoutMs) });
        if (!up.ok || !up.body) { lastErr = `${ch.label} HTTP ${up?.status ?? 'n/a'}`; continue; }
        // 首块校验 gzip 头（FPK 是 gzip tar：0x1f 0x8b），非文件内容（HTML 预览页等）立即换下一通道
        const reader = up.body.getReader();
        const first = await reader.read();
        const head = Buffer.from(first?.value || []);
        if (!(head.length > 2 && head[0] === 0x1f && head[1] === 0x8b)) {
          lastErr = `${ch.label} 返回内容非 FPK（非 gzip 头）`;
          try { await reader.cancel(); } catch {}
          continue;
        }
        log(`[app-download] 经 ${ch.label} 开始流式回传 ${asset.name}（tag=${asset.tag || 'latest'}）`);
        const headers = {
          'Content-Type': 'application/x-fpk',
          'Content-Disposition': `attachment; filename="${asset.name}"`,
          'X-Fpk-Tag': asset.tag || '',
          'Cache-Control': 'no-store',
        };
        const cl = up.headers.get('content-length');
        if (cl) headers['Content-Length'] = cl;
        return new Response(streamConcat(first, reader), { status: 200, headers });
      } catch (e) {
        lastErr = `${ch.label} 异常：${e?.message || e}`;
      }
    }
    return json(null, 502, { error: `FPK 下载失败（${lastErr}）。请检查网络，或在设置中保存 GitHub PAT 后重试。` });
  }

  // ── 工作区（projects.tree 经 dashboard WS JSON-RPC sidecar）──
  // Tier-3 磁盘仓库发现：官方默认 desktop.repo_scan_roots=[] 即关闭磁盘扫描，且发现缓存
  // 只能由显式 projects.discover_repos(scan=true) 写入。NAS 上没有桌面客户端替我们扫本地盘，
  // 所以这里在取树前先触发一次扫描（60s 内存节流；?refresh=1 由前端「重新扫描」强制）。
  // 扫描失败不阻断读树——宁可显示旧结果/空，不报错（root 缺失/扫描根未挂载是常态）。
  let lastWorkspaceScanAt = 0;
  async function projects(profile, { force = false } = {}) {
    const shouldScan = force || Date.now() - lastWorkspaceScanAt > 60000;
    return new Promise((resolve, reject) => {
      const url = new URL(`http://${dashboardBind}:${dashboardPort}/api/ws`);
      url.protocol = 'ws:';
      url.searchParams.set('token', dashboardSessionToken);
      const ws = new WSClib(url.href, { handshakeTimeout: 5000 });
      const finish = (error, value) => { clearTimeout(timer); ws.removeAllListeners(); try { ws.close(); } catch {} error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(new Error('读取工作区超时')), shouldScan ? 15000 : 12000);
      const sendTree = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'projects.tree', params: { profile } }));
      ws.on('open', () => {
        if (shouldScan) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'projects.discover_repos', params: { profile, scan: true } }));
        } else {
          sendTree();
        }
      });
      ws.on('message', (bytes) => {
        for (const line of bytes.toString().split('\n').filter(Boolean)) {
          let value; try { value = JSON.parse(line); } catch { continue; }
          if (value.id === 1) {
            // 无论成功/失败都记下节流时间戳，避免每个请求都触发全量扫描；失败继续取树
            lastWorkspaceScanAt = Date.now();
            sendTree();
          } else if (value.id === 2) {
            finish(value.error ? new Error(value.error.message || '工作区读取失败') : null, value.result);
          }
        }
      });
      ws.on('error', () => finish(new Error('Hermes 原生服务不可用')));
      ws.on('close', () => finish(new Error('工作区连接已关闭')));
    });
  }

  // ── 飞书配置写入（NAS venv python，HERMES_HOME=DATA_DIR）──
  async function applyFeishuConfig(profile, credentials, settings) {
    const userHome = dataDir;
    await mkdir(userHome, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn(python, [feishuScript], {
        cwd: coreRoot, stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HERMES_HOME: dataDir,
          HERMES_RUNTIME_DIR: path.join(dataDir, 'runtime'),
          HOME: userHome,
          PYTHONUNBUFFERED: '1', PYTHONUTF8: '1',
        },
      });
      const stdout = [], stderr = [];
      child.stdout.on('data', d => stdout.push(d));
      child.stderr.on('data', d => stderr.push(d));
      child.on('error', reject);
      child.on('exit', code => {
        let value;
        try { value = JSON.parse(Buffer.concat(stdout).toString('utf8').trim() || '{}'); }
        catch { return reject(new Error('Hermes 飞书配置写入器返回了无效结果')); }
        if (code !== 0 || !value.ok) return reject(new Error(value.error || Buffer.concat(stderr).toString('utf8').trim() || '飞书配置保存失败'));
        resolve(value);
      });
      child.stdin.end(JSON.stringify({ profile, credentials, options: settings }));
    });
  }

  // ── 微信/QQ 扫码配置写入（NAS venv python，与飞书写入器同构的一次性 helper）──
  async function applyChatConfig(platform, profile, credentials, settings) {
    const chatScript = options.chatScript || path.join(appDir, 'server/chat-onboard.py');
    const userHome = dataDir;
    await mkdir(userHome, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn(python, [chatScript], {
        cwd: coreRoot, stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HERMES_HOME: dataDir,
          HERMES_RUNTIME_DIR: path.join(dataDir, 'runtime'),
          HOME: userHome,
          PYTHONUNBUFFERED: '1', PYTHONUTF8: '1',
        },
      });
      const stdout = [], stderr = [];
      child.stdout.on('data', d => stdout.push(d));
      child.stderr.on('data', d => stderr.push(d));
      child.on('error', reject);
      child.on('exit', code => {
        let value;
        try { value = JSON.parse(Buffer.concat(stdout).toString('utf8').trim().split('\n').pop() || '{}'); }
        catch { return reject(new Error(`${platform === 'weixin' ? '微信' : 'QQ'} 配置写入器返回了无效结果`)); }
        if (code !== 0 || !value.ok) return reject(new Error(value.error || Buffer.concat(stderr).toString('utf8').trim() || `${platform === 'weixin' ? '微信' : 'QQ'} 配置保存失败`));
        resolve(value);
      });
      child.stdin.end(JSON.stringify({ platform, profile, credentials, options: settings }));
    });
  }

  // 经原生代理重启网关（复用 monitor 的重启修复逻辑）
  // proxyDashboard 只认 /proxy/dashboard 前缀：按当前请求的门户前缀（/app/<app> 或空）构造。
  async function restartGateway(profile, originalUrl) {
    try {
      const prefix = originalUrl ? originalUrl.pathname.slice(0, originalUrl.pathname.indexOf(`${basePath}/`)) : '';
      const url = new URL(`http://127.0.0.1${prefix}/proxy/dashboard/api/gateway/restart`);
      url.searchParams.set('profile', profile);
      const response = await proxyDashboard(new Request(url.href, { method: 'POST', headers: new Headers() }));
      const value = await response.json().catch(() => ({}));
      return response.ok ? { restart_started: true, ...value } : { restart_started: false, restart_error: value.detail || value.error || `HTTP ${response.status}` };
    } catch (error) {
      return { restart_started: false, restart_error: error.message };
    }
  }

  // ── 静态资源（路径穿越防护；index.html no-store，hash 化 assets 长缓存）──
  async function staticFile(directory, relative, reqMethod) {
    let resolved = path.resolve(directory, relative || 'index.html');
    if (resolved !== directory && !resolved.startsWith(directory + path.sep)) {
      return new Response(JSON.stringify({ error: 'Invalid path' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    try {
      let st = await stat(resolved);
      if (st.isDirectory()) {
        resolved = path.join(resolved, 'index.html');
        st = await stat(resolved);
      }
      const data = await readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      // hash 化的构建产物（assets/、ds-assets/）长缓存；页面与宿主脚本 no-store
      const hashedAsset = relative.startsWith('assets/') || relative.includes('/assets/')
        || relative.startsWith('ds-assets/') || relative.includes('/ds-assets/');
      const cacheable = hashedAsset ? 'public, max-age=31536000, immutable' : 'no-store';
      const headers = {
        'Content-Type': contentTypes[ext] || 'application/octet-stream',
        'Cache-Control': path.extname(resolved) === '.html' ? 'no-store' : cacheable,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin',
      };
      return new Response(reqMethod === 'HEAD' ? Buffer.alloc(0) : data, { status: 200, headers });
    } catch {
      return new Response(JSON.stringify({ error: '页面尚未构建，请确认安装包完整。' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // ── native 反代：/admin/api/native/<rest> → proxyDashboard(/proxy/dashboard/<rest>) ──
  // 凭据不变量：渲染层注入的 token/ticket/internal 一律剔除，真实会话令牌只由宿主注入。
  async function proxyNative(request, url, relative) {
    const rest = relative.slice('api/native/'.length);
    if (!rest.startsWith('api/') && !rest.startsWith('ws/')) {
      return new Response(JSON.stringify({ error: '无效的原生接口路径' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    for (const key of ['token', 'ticket', 'internal']) url.searchParams.delete(key);
    // 在剔除参数后的 URL 上改写路径；/admin 前缀可能带或不带 /app/<app> 门户前缀，按 indexOf 定位。
    const idx = url.pathname.indexOf(`${basePath}/api/native/`);
    if (idx < 0) {
      return new Response(JSON.stringify({ error: '无效的原生接口路径' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    url.pathname = url.pathname.slice(0, idx) + `/proxy/dashboard/${rest}`;
    const headers = new Headers(request.headers);
    headers.delete('host');
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body;
    const init = { method: request.method, headers, signal: request.signal };
    if (hasBody) { init.body = request.body; init.duplex = 'half'; }
    return proxyDashboard(new Request(url.href, init));
  }

  // ── 路由分发：返回 Response 或 null（交还上游）──
  const handle = async (request) => {
    let url;
    try { url = new URL(request.url); } catch { return null; }
    // fnOS 门户反向代理不剥 /app/<app>/ 前缀（unix socket 模式），独立 TCP 模式无前缀；两者都兼容。
    let p = url.pathname.replace(/^\/app\/[A-Za-z0-9_-]+/, '') || '/';

    if (p !== basePath && !(p.startsWith(basePath + '/'))) return null;
    const method = request.method;
    const relative = p.slice(basePath.length + 1); // '' 表示 /admin 本身

    // 页面与静态资源（GET/HEAD）
    if (!relative.startsWith('api/') && ['GET', 'HEAD'].includes(method)) {
      const isWork = relative === 'web' || relative.startsWith('web/');
      const directory = isWork ? workRoot : uiRoot;
      let fileRel = isWork ? (relative === 'web' ? '' : relative.slice(4)) : (relative || '');
      if (fileRel === '/') fileRel = ''; // 目录根（/admin/web/ 等）回到 index.html
      // 浏览器可能以百分号编码发请求（CJK/空格文件名），解码后再落盘；解码失败按原始路径尝试。
      try { if (fileRel.includes('%')) fileRel = decodeURIComponent(fileRel); } catch {}
      return await staticFile(directory, fileRel, method);
    }

    // 宿主 API
    if (relative.startsWith('api/host/')) {
      const tail = relative.slice('api/host/'.length);

      if (tail === 'status' && method === 'GET') {
        const gatewayRunning = !!(readPid(gatewayPidPath));
        const providerReady = gatewayProviderReady();
        return json(null, 200, {
          mode: 'fnos',
          admin: 'ready',
          backend: await health(),
          pid: readPid(dashboardPidPath) || null,
          changing,
          dataRoot: dataDir,
          coreRoot,
          // 默认扫描根（HERMES_HOME 之外，与 install/upgrade_callback 注入的 desktop.repo_scan_roots 一致）
          workspacesRoot: path.join(path.dirname(dataDir), 'workspaces'),
          gateway: {
            state: gatewayRunning ? 'running' : 'stopped',
            providerReady,
            // 是否已配置至少一个机器人通道（FEISHU/WEIXIN/QQ 的 ALLOW_ALL_USERS 或凭证 env 已落盘）。
            // 概览页「配置机器人」引导 + 停止按钮据此在配好后自动隐藏（配好=机器人就绪）。
            botsConfigured: (function () {
              // 机器人通道凭证落盘在 profile-scope 的 .env：default → dataDir/.env，命名 profile → dataDir/profiles/<name>/.env。
              // 扫两者，任一平台（feishu/weixin/qqbot）有 ALLOW_ALL_USERS=true 或专属凭据即视为已配置。
              const files = [path.join(dataDir, '.env')];
              try {
                const pdir = path.join(dataDir, 'profiles');
                for (const d of readdirSync(pdir)) files.push(path.join(pdir, d, '.env'));
              } catch {}
              // some() 短路只回布尔不回值——必须逐文件取第一个非空匹配（回字符串）
              const firstDef = (k) => {
                for (const fp of files) {
                  try { const m = readFileSync(fp, 'utf8').match(new RegExp('^' + k + '\\s*=\\s*(.+)$', 'm')); if (m && m[1].trim()) return m[1].trim(); } catch {}
                }
                return '';
              };
              return ['feishu', 'weixin', 'qqbot'].some(plat => {
                const U = plat.toUpperCase();
                const all = firstDef(U + '_ALLOW_ALL_USERS');
                const cred = firstDef(plat === 'feishu' ? 'FEISHU_APP_ID' : plat === 'weixin' ? 'WEIXIN_ACCOUNT_ID' : 'QQ_APP_ID');
                return all === 'true' || !!cred;
              });
            })(),
            detail: gatewayRunning
              ? '通讯网关运行中。'
              : providerReady
                ? '已配置模型服务商，网关尚未运行，可启动。'
                : '尚未配置模型服务商。请先在「模型管理」中添加并保存供应商，网关配置完成后即可运行。',
          },
        });
      }

      if (tail === 'version' && method === 'GET') {
        return json(null, 200, await versionInfo());
      }

      if (tail === 'logs' && method === 'GET') {
        return json(null, 200, await readLogs(url));
      }

      if (tail === 'update/check' && method === 'GET') {
        try { const updates = await checkUpdates(); updates.github = patState(); return json(null, 200, updates); }
        catch (error) { return json(null, 502, { error: error.message }); }
      }

      // ── 服务端代下 FPK（ghproxy 中继 → GitHub 直连多通道，流式回传 + Content-Disposition）──
      // 浏览器同源下载（原生下载器显示进度），根治 <a target=_blank> 直连 github.com 在
      // 飞牛 webview 里跨站被拦 / 国内直连 310MB 卡死的问题。
      if (tail === 'update/download' && method === 'GET') {
        return downloadFpkStream();
      }

      // ── GitHub PAT（落盘 var/github_pat 0600；供 update/check 带 Bearer 绕过未认证限流）──
      if (tail === 'update/token' && method === 'POST') {
        try {
          let body = {};
          try { body = await request.json().catch(() => ({})); } catch {}
          return json(null, 200, await saveGitHubPAT(body && body.pat));
        } catch (error) { return json(null, 400, { error: error.message }); }
      }

      if (tail === 'projects' && method === 'GET') {
        try { return json(null, 200, await projects(url.searchParams.get('profile') || 'default', { force: url.searchParams.get('refresh') === '1' })); }
        catch (error) { return json(null, 503, { error: error.message }); }
      }

      // ── Hermes 进程资源占用（/proc 采样：CPU 双采样平均 + RSS；覆盖 dashboard+gateway+宿主 monitor）──
      if (tail === 'resources' && method === 'GET') {
        return json(null, 200, hostResources());
      }

      // ── 维护与恢复（真实接入 hermes 核心能力；无占位文案）──
      // doctor：hermes doctor --fix [--live]（配置/依赖诊断 + 自动修复；--live 追加对工具后端的只读真实探针）
      // 异步 spawn：不阻塞 monitor 事件循环（诊断耗时 30~90s，阻塞会把整个 Admin 面板卡死）
      if (tail === 'maintenance/doctor' && method === 'POST') {
        let body = {}; try { body = await req.json().catch(() => ({})); } catch {}
        const hermesBin = options.hermesBin;
        if (!hermesBin) return json(null, 503, { error: '维护命令未配置（缺少 hermes 可执行文件路径注入）' });
        const args = ['doctor', '--fix'];
        if (body.live) args.push('--live');
        const started = Date.now();
        const child = spawn(hermesBin, args, {
          env: { ...process.env, HERMES_HOME: dataDir, HOME: process.env.HOME || dataDir, PATH: `${dataDir}/venv/bin:${process.env.PATH || ''}` },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const appendOut = (chunk) => { out += chunk; if (out.length > 1024 * 1024) out = out.slice(-512 * 1024); };
        child.stdout.on('data', appendOut);
        child.stderr.on('data', appendOut);
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 120000);
        return new Promise((resolve) => {
          const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
          child.on('close', (code) => {
            clearTimeout(timer);
            const text = stripAnsi(out).trim();
            const lines = text ? text.split(/\r?\n/) : [];
            resolve(json(null, 200, {
              ok: code === 0,
              exitCode: code,
              command: `hermes ${args.join(' ')}`,
              durationMs: Date.now() - started,
              lines: lines.slice(-300),
              summary: lines.slice(-8).join('\n') || '诊断完成，无输出',
            }));
          });
          child.on('error', (err) => {
            clearTimeout(timer);
            resolve(json(null, 504, { ok: false, error: `诊断执行失败：${err.message}`, lines: [] }));
          });
        });
      }

      // logs/clear：白名单 8 文件（与 monitor 的 /api/logs/clear 同源语义），截断为 0 字节
      if (tail === 'maintenance/logs/clear' && method === 'POST') {
        let body = {}; try { body = await req.json().catch(() => ({})); } catch {}
        const file = body.file || 'hermes.log';
        const allowed = ['gateway.log', 'errors.log', 'agent.log', 'gui.log', 'gateway-restart.log', 'gateway-shutdown-diag.log', 'gateway-exit-diag.log', 'hermes.log'];
        if (!allowed.includes(file)) return json(null, 400, { error: 'disallowed file' });
        const fp = file === 'hermes.log' ? path.join(varDir, file) : path.join(dataDir, 'logs', file);
        try {
          writeFileSync(fp, '');
          return json(null, 200, { ok: true, file: fp });
        } catch (error) {
          return json(null, 500, { error: error.message });
        }
      }

      const action = tail.match(/^service\/(start|stop|restart)$/)?.[1];
      if (action && method === 'POST') {
        if (changing) return json(null, 409, { error: '已有服务操作正在执行' });
        changing = true;
        try {
          if (action !== 'start') await stopDashboard();
          if (action !== 'stop') await startDashboard();
          log(`[nas-admin] service ${action} → ${JSON.stringify(await health())}`);
          return json(null, 200, { ok: true, backend: await health() });
        } catch (error) {
          return json(null, 409, { error: error.message });
        } finally { changing = false; }
      }

      // 通讯网关生命周期（由 monitor 管理；配置语义：无真实模型服务商时网关不应运行）
      const gwAction = tail.match(/^service\/gateway\/(start|stop)$/)?.[1];
      if (gwAction && method === 'POST') {
        if (changing) return json(null, 409, { error: '已有服务操作正在执行' });
        changing = true;
        try {
          let result;
          if (gwAction === 'start') {
            if (readPid(gatewayPidPath)) result = { ok: true, msg: 'already_running' };
            else if (!gatewayProviderReady()) result = { ok: false, error: '尚未配置模型服务商，请先在「模型管理」中保存供应商后再启动网关' };
            else result = await startGateway();
          } else {
            result = await stopGateway();
            result = { ok: true, ...(result || {}) };
          }
          log(`[nas-admin] gateway ${gwAction} → ${JSON.stringify(result)}`);
          return json(null, result && result.error ? 409 : 200, result);
        } catch (error) {
          return json(null, 409, { error: error.message });
        } finally { changing = false; }
      }

      const onboardingStart = tail === 'messaging/feishu/onboarding/start' && method === 'POST';
      if (onboardingStart) {
        let body = {};
        try { body = await request.json().catch(() => ({})); } catch {}
        try { return json(null, 200, await feishuOnboarding.start(body)); }
        catch (error) { return json(null, 502, { error: error.message }); }
      }

      const applyMatch = tail.match(/^messaging\/feishu\/onboarding\/([^/]+)\/apply$/);
      if (applyMatch && method === 'POST') {
        let body = {};
        try { body = await request.json().catch(() => ({})); } catch {}
        try {
          const credentials = feishuOnboarding.credentials(decodeURIComponent(applyMatch[1]));
          const saved = await applyFeishuConfig(String(body.profile || 'default'), credentials, body);
          feishuOnboarding.consume(decodeURIComponent(applyMatch[1]));
          return json(null, 200, { ...saved, ...(await restartGateway(String(body.profile || 'default'), url)) });
        } catch (error) {
          // FeishuOnboarding 的 409/404（未扫码/会话过期）等状态码需原样透传给前端
          return json(null, error.statusCode || 500, { error: error.message });
        }
      }

      const pairingMatch = tail.match(/^messaging\/feishu\/onboarding\/([^/]+)$/);
      if (pairingMatch && method === 'GET') {
        try { return json(null, 200, await feishuOnboarding.poll(decodeURIComponent(pairingMatch[1]))); }
        catch (error) { return json(null, 502, { error: error.message }); }
      }
      if (pairingMatch && method === 'DELETE') {
        feishuOnboarding.cancel(decodeURIComponent(pairingMatch[1]));
        return json(null, 200, { ok: true });
      }

      // ── 微信 / QQ 机器人扫码接入（Node 侧驱动 iLink / q.qq.com 协议，apply 走一次性 python）──
      const chatStartMatch = tail.match(/^messaging\/(weixin|qqbot)\/onboarding\/start$/);
      if (chatStartMatch && method === 'POST') {
        try { return json(null, 200, await chatOnboarding.start(chatStartMatch[1])); }
        catch (error) { return json(null, 502, { error: error.message }); }
      }

      const chatApplyMatch = tail.match(/^messaging\/(weixin|qqbot)\/onboarding\/([^/]+)\/apply$/);
      if (chatApplyMatch && method === 'POST') {
        let body = {};
        try { body = await request.json().catch(() => ({})); } catch {}
        try {
          const platform = chatApplyMatch[1];
          const credentials = chatOnboarding.credentials(decodeURIComponent(chatApplyMatch[2]));
          const saved = await applyChatConfig(platform, String(body.profile || 'default'), credentials, body);
          chatOnboarding.consume(decodeURIComponent(chatApplyMatch[2]));
          return json(null, 200, { ...saved, ...(await restartGateway(String(body.profile || 'default'), url)) });
        } catch (error) {
          return json(null, error.statusCode || 500, { error: error.message });
        }
      }

      const chatPairingMatch = tail.match(/^messaging\/(weixin|qqbot)\/onboarding\/([^/]+)$/);
      if (chatPairingMatch && method === 'GET') {
        try { return json(null, 200, await chatOnboarding.poll(decodeURIComponent(chatPairingMatch[2]))); }
        catch (error) { return json(null, error.statusCode || 502, { error: error.message }); }
      }
      if (chatPairingMatch && method === 'DELETE') {
        chatOnboarding.cancel(decodeURIComponent(chatPairingMatch[2]));
        return json(null, 200, { ok: true });
      }
    }

    // 原生反代（→ dashboard 9219 + 注入会话令牌）
    if (relative.startsWith('api/native/')) {
      return proxyNative(request, url, relative);
    }

    return json(null, 404, { error: 'Not found' });
  };

  return { handle, health, versionInfo, checkUpdates, projects };
}
