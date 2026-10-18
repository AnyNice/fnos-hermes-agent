// 抽取 work-ui fnos-host.js 调用的所有 native(/api/...) 端点 + unavailable() 能力，
// 对照 hermes 核心 web_routers 实际存在的端点，找"桌面假设断裂"
import fs from 'node:fs';

const base = 'E:/项目/hermes_fnos/fnos-dual-entry';
const hostJs = fs.readFileSync(`${base}/app/work-ui/fnos-host.js`, 'utf8');

// 1) 所有 native(/api/...) 路径字面量（fnos-host.js 里 api({path:...})）
const apiPaths = new Set();
for (const m of hostJs.matchAll(/path:\s*[`'"]([^`'"]*\/api\/[^`'"]*)[`'"]/g)) apiPaths.add(m[1]);
// template 里的 path 变量
for (const m of hostJs.matchAll(/[`'"]([^`'"]*\/api\/[a-z0-9_-]+)[^`'"]*[`'"]/g)) apiPaths.add(m[1]);

console.log('=== work-ui fnos-host.js 引用的 native /api/* 端点 ===');
for (const p of [...apiPaths].sort()) console.log('  ' + p);

// 2) unavailable() 声明的"桌面端才有的能力"
console.log('\n=== fnos-host.js 标记为 unavailable 的能力（NAS 不支持/需人工）===');
for (const m of hostJs.matchAll(/(\w+):\s*unavailable\(`?([^`'"\n]*)`?\)/g)) console.log(`  ${m[1]}  ← ${m[2]}`);
console.log('  (注: 上面正则抓直接字面量的；带变量的在运行时抛"请在 Hermes Admin 管理"提示)');

// 3) hermes 核心 web_routers 全集端点
console.log('\n=== hermes 核心 web_routers 实际 @router 端点（对照面）===');
const routerDir = `${base}/app/hermes-src/hermes_cli/web_routers`;
const seen = new Set();
function addRouter(file, pathBase = '') {
  try {
    const s = fs.readFileSync(file, 'utf8');
    // 匹配 @router.get("/api/x") / @logs_router.get / @config_router.get 等
    for (const m of s.matchAll(/@\w*[Rr]outer\.\w+\(\s*["'`](\/?[^"'`,\s)]+)/g)) {
      seen.add((pathBase + m[1]).replace(/\/{2,}/g, '/'));
    }
    for (const m of s.matchAll(/@\w*[Rr]outer\.(get|post|put|delete|patch|websocket)\(/g)) {}
  } catch {}
}
for (const f of fs.readdirSync(routerDir).filter(x => x.endsWith('.py'))) addRouter(`${routerDir}/${f}`);
// web_server.py 顶层 router
try {
  const s = fs.readFileSync(`${base}/app/hermes-src/hermes_cli/web_server.py`, 'utf8');
  for (const m of s.matchAll(/@\w*[Rr]outer\.\w+\(\s*["'`](\/?[^"'`,\s)]+)/g)) seen.add(m[1]);
} catch {}
for (const p of [...seen].sort()) if (p.startsWith('/api/')) console.log('  ' + p);
console.log(`\n(核心 /api/* 端点共 ${[...seen].filter(p=>p.startsWith('/api/')).length} 个)`);
