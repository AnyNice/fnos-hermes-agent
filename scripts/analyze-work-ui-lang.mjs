// 分析 work-ui 的语言机制：找语言存储键 + 默认语言判定逻辑
import fs from 'node:fs';
import path from 'node:path';

const root = 'E:/项目/hermes_fnos/fnos-dual-entry/app/work-ui';
const files = fs.readdirSync(path.join(root, 'assets')).filter(f => f.endsWith('.js'));

// 1. 找所有 i18n/locale 相关的 localStorage 键
const keySet = new Set();
for (const f of files) {
  let s;
  try { s = fs.readFileSync(path.join(root, 'assets', f), 'utf8'); } catch { continue; }
  for (const m of s.matchAll(/localStorage\.(?:get|set)Item\((['"`])((?:[a-zA-Z@._-][a-zA-Z0-9@._-]*))/g)) {
    keySet.add(`${m[2]}  <-- ${f}`);
  }
}
console.log('=== localStorage 键（全量）===');
[...keySet].sort().forEach(k => console.log(k));

// 2. 找语言判定逻辑（navigator.language / accept-language / i18n 默认）
console.log('\n=== 语言判定上下文 ===');
for (const f of files) {
  let s;
  try { s = fs.readFileSync(path.join(root, 'assets', f), 'utf8'); } catch { continue; }
  let idx = 0;
  const hits = [];
  while ((idx = s.indexOf('navigator.language', idx + 1)) >= 0) {
    hits.push(s.slice(Math.max(0, idx - 300), idx + 120).replace(/\s+/g, ' '));
    if (hits.length >= 2) break;
  }
  // 找 i18n 默认 locale
  for (const m of s.matchAll(/default[A-Za-z]*Locale|initialLanguage|"zh"|"zh-CN"|"en-US"|"en"/g)) {
    hits.push(`[i18n marker] ${s.slice(Math.max(0, m.index - 200), m.index + 150).replace(/\s+/g, ' ')}`);
  }
  if (hits.length) {
    console.log(`\n--- ${f} ---`);
    hits.slice(0, 4).forEach(h => console.log(h.slice(0, 400), '\n~'));
  }
}
