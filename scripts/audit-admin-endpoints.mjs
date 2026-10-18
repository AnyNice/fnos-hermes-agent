// 排查"桌面假设 vs NAS 现实"：admin 前端调用的全部 native/host 端点
// 对照 hermes 核心 web_routers 是否有对应实现，找出来"调了但没有/桌面专属"的
import fs from 'node:fs';
import path from 'node:path';

const adminSrc = 'E:/项目/hermes_fnos/fnos-dual-entry/frontend/admin/src';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|vue|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const nativeSet = new Set();
const hostSet = new Set();
for (const f of walk(adminSrc)) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/native\(\s*[`'"]([^`'"]+)/g)) nativeSet.add(m[1]);
  for (const m of s.matchAll(/api\/host\/([a-z0-9_/-]+)/g)) hostSet.add('/' + m[1]);
}
console.log('=== admin 前端 native(/api/...) 端点全集 ===');
for (const p of [...nativeSet].sort()) console.log('  ' + p);
console.log('\n=== admin 前端 host(api/host/...) 端点全集 ===');
for (const p of [...hostSet].sort()) console.log('  ' + p);

// 提取 native 路径里的"资源根"（如 /api/providers、/api/logs、/api/messaging、/api/fs、/api/system ...）
console.log('\n=== native 资源根聚合（对照核心 router）===');
const roots = new Set();
for (const p of nativeSet) {
  const m = p.match(/^\/api\/([a-z0-9_-]+)(\/[a-z0-9_-]+)?/);
  if (m) roots.add(m[1]);
}
for (const r of [...roots].sort()) console.log('  /api/' + r);
