// 全局扫 work-ui bundle：找语言相关的 localStorage 键 / 初始语言判定
import fs from 'node:fs';
import path from 'node:path';

const root = 'E:/项目/hermes_fnos/fnos-dual-entry/app/work-ui/assets';
const files = fs.readdirSync(root).filter(f => f.endsWith('.js'));

const KEY_RE = /localStorage\.(?:getItem|setItem)\(\s*([`'"])([^`'"]{2,60})\1/g;
const hits = new Map(); // key -> Set(file)
for (const f of files) {
  let s;
  try { s = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
  let m;
  KEY_RE.lastIndex = 0;
  while ((m = KEY_RE.exec(s))) {
    const key = m[2];
    if (!hits.has(key)) hits.set(key, new Set());
    hits.get(key).add(f);
  }
}
console.log('=== 所有 localStorage 键（全 bundle）===');
for (const [key, files] of [...hits.entries()].sort()) {
  const langy = /lang|locale|nls/i.test(key);
  console.log(`${langy ? 'LANG >> ' : '        '} ${key}   (${[...files].join(', ').slice(0, 80)})`);
}

// i18n 初始判定：搜 i18n bundle 里 detect / resolve locale 的字面
const i18n = files.find(f => f.startsWith('i18n-'));
if (i18n) {
  const s = fs.readFileSync(path.join(root, i18n), 'utf8');
  console.log(`\n=== ${i18n} 语言判定片段 ===`);
  for (const p of ['detectLocale', 'initialLocale', 'resolveLocale', 'getDefaultLocale', 'language', 'locale']) {
    let i = s.indexOf(p);
    if (i >= 0) console.log(`[${p}] @${i}: ${s.slice(Math.max(0, i - 200), i + 200).replace(/\s+/g, ' ')}`);
  }
}
