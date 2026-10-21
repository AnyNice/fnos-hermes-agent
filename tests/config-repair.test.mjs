// config-repair.test.mjs — 验证去重算法（纯函数，不碰 monitor.js）
import { test } from 'node:test';
import assert from 'node:assert';
import { dedupeYamlKeyDups } from '../app/server/config-repair.mjs';

const L = (s) => s.split('\n');

test('嵌套同父重复键：保留最后一次，删先前（含其子树）', () => {
  const src = [
    'providers:',
    '  myllm:',
    '    base_url: "http://x/v1"',
    '    supports_reasoning: false',   // 第一次（旧值）
    '    context_window: 8000',
    '    supports_reasoning: true',     // 第二次（新值）→ 保留
    '    extra_note: keep-me',
  ];
  const r = dedupeYamlKeyDups(src);
  const out = r.lines.join('\n');
  assert.ok(r.removed >= 1, '应删除重复');
  assert.ok(r.keys.includes('supports_reasoning'));
  assert.ok(!out.includes('supports_reasoning: false'), '旧值应删');
  assert.ok(out.includes('supports_reasoning: true'), '新值应留');
  assert.ok(out.includes('base_url') && out.includes('context_window') && out.includes('extra_note'), '非重复键不误删');
});

test('不同父级下的同名键：都不删', () => {
  const src = [
    'providers:',
    '  a:',
    '    supports_reasoning: false',
    '  b:',
    '    supports_reasoning: true',
  ];
  const r = dedupeYamlKeyDups(src);
  assert.equal(r.removed, 0, '不同父级同名键不重复');
  assert.deepEqual(r.lines, src);
});

test('inline 形态 key:{} 重复：删前留后', () => {
  const src = ['mcp_servers: {}', 'other: 1', 'mcp_servers: {}'];
  const r = dedupeYamlKeyDups(src);
  assert.equal(r.removed, 1);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0], 'other: 1');
  assert.equal(r.lines[1], 'mcp_servers: {}');
});

test('列表项不误删；列表项下的 map 正确', () => {
  const src = [
    'toolsets:',
    '- hermes-cli',
    '- web',
    'model:',
    '  default: foo/bar',
    '  provider: openai',
  ];
  const r = dedupeYamlKeyDups(src);
  assert.equal(r.removed, 0);
  assert.deepEqual(r.lines, src, '无重复时原样');
});

test('幂等：跑两遍第二遍 removed=0', () => {
  const src = ['providers:', '  a:', '    supports_reasoning: false', '    supports_reasoning: true'];
  const r1 = dedupeYamlKeyDups(src);
  const r2 = dedupeYamlKeyDups(r1.lines);
  assert.equal(r2.removed, 0, '去重后无重复');
});

test('CRLF 鲁棒（行尾带 \\r 也能按缩进判层级）', () => {
  const src = ['providers:\r', '  a:\r', '    supports_reasoning: false\r', '    supports_reasoning: true\r'].map(x=>x);
  const r = dedupeYamlKeyDups(src);
  assert.ok(r.removed >= 1);
  assert.ok(r.lines.some(l => l.includes('supports_reasoning: true')));
  assert.ok(!r.lines.some(l => l.includes('supports_reasoning: false')));
});

test('无重复块：原样返回（同一数组引用）', () => {
  const src = ['a: 1', 'b: 2'];
  const r = dedupeYamlKeyDups(src);
  assert.equal(r.removed, 0);
  assert.equal(r.lines, src);
});
