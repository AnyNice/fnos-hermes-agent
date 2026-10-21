// config-repair.mjs — config.yaml 文本级修复纯函数（无 IO / 无副作用，可单测）。
//
// 背景：Hermes config.yaml 出现「同一 map 内同父重复键」（历史版本壳层追加写 / 手动编辑残留，
//   如嵌套 supports_reasoning 写了两次）时，核心 ruamel 严格解析抛 "duplicate key" 错误，
//   而核心又有「读配置失败即拒绝覆盖写」保护（InvalidUserConfigError）→ 用户在界面保存模型/
//   供应商永远被拦下（"Failed to save" 死锁），网关热加载解析 config 失败 → 「网关动不动不能用」。
//   纯文本级去重（不依赖 YAML 解析器——解析器本身已读不动此文件）：按 YAML 覆盖语义
//   「保留同父同名键的最后一次出现、删除其先前出现的整棵子树」，数据无损、幂等。

/**
 * 行级去重：删除 (父层级, 键名) 分组内非最后一次出现的键行及其子树。
 * @param {string[]} lines 配置行（允许行尾带 \r，函数对 CRLF 鲁棒）
 * @returns {{ lines: string[], removed: number, keys: string[] }}
 *   removed = 删除的重复键行数（不含其子树随行）；keys = 去重掉的键名（去重后集合）。
 */
export function dedupeYamlKeyDups(lines) {
  const n = lines.length;
  const indentOf = (s) => { let i = 0; while (i < s.length && s[i] === ' ') i++; return i; };
  // 结构键行：`key:` / `key: value`（列表项 `- x` 不作分组键，只当容器边界）
  const keyNameOf = (s) => {
    const m = s.match(/^ *([A-Za-z_][A-Za-z0-9_.\-]*):/);
    return m ? m[1] : '';
  };
  const isKey = new Array(n).fill(false);
  const ind = new Array(n).fill(-1);
  const kn = new Array(n).fill('');
  for (let i = 0; i < n; i++) {
    const t = lines[i].trim();
    if (t === '' || t[0] === '#') continue;
    const I = indentOf(lines[i]);
    ind[i] = I;
    const m = keyNameOf(lines[i]);
    if (m) { isKey[i] = true; kn[i] = m; }
  }

  // 父键栈 → 每个键的分组键 = 直接父键名::本键名（YAML 中同父同名键必须唯一）
  const stack = []; // [indent, keyName]
  const group = new Array(n).fill('');
  for (let i = 0; i < n; i++) {
    if (!isKey[i]) continue;
    const I = ind[i];
    while (stack.length && stack[stack.length - 1][0] >= I) stack.pop();
    const parent = stack.length ? stack[stack.length - 1][1] : '\u0000';
    group[i] = parent + '::' + kn[i];
    stack.push([I, kn[i]]);
  }

  // 每组保留最后一次出现；其余 key 行 → 连同其整棵子树一起删
  const lastByKey = {};
  for (let i = 0; i < n; i++) if (isKey[i]) lastByKey[group[i]] = i;
  const toDelete = new Set();
  const removedKeys = new Set();
  for (let i = 0; i < n; i++) {
    if (isKey[i] && lastByKey[group[i]] !== i) { toDelete.add(i); removedKeys.add(kn[i]); }
  }
  if (toDelete.size === 0) return { lines, removed: 0, keys: [] };

  const drop = new Set();
  for (const i of toDelete) {
    drop.add(i);
    const I = ind[i];
    let j = i + 1;
    while (j < n) {
      const tj = lines[j].trim();
      if (tj === '' || tj[0] === '#') { drop.add(j); j++; continue; } // 空行/注释跟随块（删掉无碍）
      if (indentOf(lines[j]) <= I) break; // 缩进回退到父级 → 子树结束
      drop.add(j); j++;
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (!drop.has(i)) out.push(lines[i]);
  return { lines: out, removed: toDelete.size, keys: [...removedKeys] };
}
