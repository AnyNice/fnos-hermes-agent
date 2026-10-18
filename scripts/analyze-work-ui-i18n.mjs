// 分析 work-ui 的 app 级 i18n 初始语言判定 + 持久化键，决定默认中文的注入点
import fs from 'node:fs';
const root = 'E:/项目/hermes_fnos/fnos-dual-entry/app/work-ui';
const files = ['assets/i18n-BttyMfgh.js', 'assets/index-Jt8SPgQs.js'];

const PATTERNS = [
  'detectLanguage', 'getInitialLanguage', 'initialLanguage', 'defaultLanguage',
  'i18next', 'useLanguage', 'setLanguage', 'changeLanguage', 'useLocale',
  'navigator.language', 'userLanguage', 'workbench.locale', 'appLanguage',
  'localStorage.getItem', 'localStorage.setItem', 'hermes.*lang', 'lang',
];

for (const f of files) {
  let s;
  try { s = fs.readFileSync(`${root}/${f}`, 'utf8'); } catch { continue; }
  console.log(`\n===== ${f} (${(s.length/1024/1024).toFixed(1)} MB) =====`);
  const seen = new Set();
  for (const p of PATTERNS) {
    const re = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let m, idx = s.indexOf(p);
    if (idx >= 0) {
      // 收集前 3 处命中上下文
      let count = 0;
      idx = s.indexOf(p);
      while (idx >= 0 && count < 3) {
        const ctx = s.slice(Math.max(0, idx - 160), idx + 160).replace(/\s+/g, ' ');
        console.log(`\n  [${p}] @${idx}: ${ctx}`);
        count++; idx = s.indexOf(p, idx + 1);
      }
    }
  }
}
