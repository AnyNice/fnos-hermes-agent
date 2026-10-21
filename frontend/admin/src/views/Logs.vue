<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { NButton, NCard, NInput, NSelect, NSwitch, NTag } from 'naive-ui';
import { native, request } from '../api';
import { useRuntime } from '../stores/runtime';
import ResourceState from '../components/ResourceState.vue';

const runtime = useRuntime();
const lines = ref<any[]>([]);
const error = ref('');
const loading = ref(true);
const live = ref(true);
const autoScroll = ref(true);
const logBox = ref<HTMLElement | null>(null);
// 默认 all（聚合本机所有已落盘来源），避免一进页面就落在某个可能没文件的来源上
const source = ref('all');
const level = ref('all');
const component = ref('all');
const count = ref(200);
const keyword = ref('');
const hostNote = ref('');
// v0.21.166：「最后更新」时间戳——2s 轮询是否真的在刷新可感知（后端 readLogs 每次全量读被
// I/O 拖住时，时间戳不动比"看起来卡住"更能定位问题）。
const lastUpdated = ref('');
const availableSources = ref<string[]>([]);
let timer: ReturnType<typeof setInterval>;
let debounce: ReturnType<typeof setTimeout>;
let disposed = false;

const DISK_SOURCE_LABELS: Record<string, string> = {
  all: '全部（有日志的来源）', host: '飞牛宿主', dashboard: '仪表盘进程',
  gateway: '通讯网关', agent: 'Agent 主日志', error: '错误日志',
  gui: '管理界面', gateway_restart: '网关重启诊断', gateway_close: '网关关闭诊断', gateway_exit: '网关退出诊断',
};
const CORE_SOURCE_LABELS: Record<string, string> = {
  desktop: '桌面端（NAS 无此文件）', update: 'Hermes 更新', handoff: '桌面更新交接', mcp: 'MCP 子进程',
};
// v158：按本机真实落盘情况过滤来源——后端每次返回 sources（有日志文件的来源清单）；
// NAS 上不存在的来源（如核心 4 项桌面专属）整项从下拉移除，避免用户点进空态。
// 首帧（availableSources 尚未返回）先展示静态全量，避免闪烁空列表。
const diskSourceValues = computed(() => availableSources.value.length
  ? Object.keys(DISK_SOURCE_LABELS).filter(k => k !== 'all' && availableSources.value.includes(k))
  : Object.keys(DISK_SOURCE_LABELS).filter(k => k !== 'all'));
const coreSourceValues = computed(() => availableSources.value.length
  ? Object.keys(CORE_SOURCE_LABELS).filter(k => availableSources.value.includes(k))
  : Object.keys(CORE_SOURCE_LABELS));
const sourceGroups = computed(() => {
  const groups: { label: string; children: { value: string; label: string }[] }[] = [];
  groups.push({ label: '宿主磁盘日志（NAS 本地读取）', children: ['all', ...diskSourceValues.value].map(v => ({ value: v, label: DISK_SOURCE_LABELS[v] })) });
  if (coreSourceValues.value.length) groups.push({ label: '核心日志（需 Hermes 服务运行）', children: coreSourceValues.value.map(v => ({ value: v, label: CORE_SOURCE_LABELS[v] })) });
  return groups;
});
const isCore = computed(() => coreSourceValues.value.includes(source.value));
const serviceReady = computed(() => runtime.status?.backend.state === 'ready');
const levelOptions = ['all', 'debug', 'info', 'warning', 'error'].map(value => ({ value, label: ({ all: '全部', debug: 'DEBUG 及以上', info: 'INFO 及以上', warning: 'WARNING 及以上', error: 'ERROR 及以上' } as Record<string, string>)[value] }));
const componentOptions = ['all', 'gateway', 'agent', 'tools', 'cli', 'cron', 'gui'].map(value => ({ value, label: ({ all: '全部组件', gateway: 'Gateway / 通讯', agent: 'Agent / 模型', tools: 'Tools / MCP', cli: 'Hermes CLI', cron: 'Cron', gui: 'GUI / Web 服务' } as Record<string, string>)[value] }));
const summary = computed(() => ({ errors: lines.value.filter(row => row.level === 'error').length, warnings: lines.value.filter(row => row.level === 'warning').length }));
const components: Record<string, string[]> = { gateway: ['gateway', 'hermes_plugins', 'plugins.platforms'], agent: ['agent', 'run_agent', 'model_tools', 'batch_runner'], tools: ['tools'], cli: ['hermes_cli', 'cli'], cron: ['cron'], gui: ['hermes_cli.web_server', 'hermes_cli.pty_bridge', 'hermes_cli.desktop', 'tui_gateway', 'uvicorn'] };

function metadata(text: string, previous: any = { level: 'info', component: 'unknown' }) {
  const levelMatch = text.match(/\s(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s/i);
  let nextLevel = levelMatch?.[1]?.toLowerCase() || previous.level;
  if (nextLevel === 'warn') nextLevel = 'warning';
  if (nextLevel === 'critical' || nextLevel === 'fatal') nextLevel = 'error';
  const logger = text.match(/\s(?:DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)(?:\s+\[.*?\])?\s+(\S+):/i)?.[1] || '';
  let nextComponent = previous.component;
  if (logger) nextComponent = Object.entries(components).find(([, prefixes]) => prefixes.some(prefix => logger.startsWith(prefix)))?.[0] || 'other';
  return { level: nextLevel, component: nextComponent };
}
function parseNative(raw: string[]) {
  let previous = { level: 'info', component: 'unknown' };
  return raw.map(line => { previous = metadata(line, previous); return { at: '', source: source.value, line, ...previous }; });
}

async function refresh() {
  try {
    let rows: any[] = [];
    let serverTs = 0;
    hostNote.value = '';
    if (isCore.value) {
      // 核心来源：经 Hermes 服务读取（服务端按 level/component/search 结构化过滤）
      if (!serviceReady.value) {
        rows = [];
        hostNote.value = '核心日志需 Hermes 服务运行（当前未就绪）。请在「概览」中启动服务，或改用左侧「宿主磁盘日志」。';
      } else {
        const params = new URLSearchParams({ file: source.value, lines: String(count.value) });
        if (level.value !== 'all') params.set('level', level.value.toUpperCase());
        if (component.value !== 'all') params.set('component', component.value);
        if (keyword.value) params.set('search', keyword.value);
        const data: any = await native(`/api/logs?${params}`, runtime.profile);
        rows = parseNative(data.lines || []);
        serverTs = data.serverTs || 0;
      }
    } else {
      // 磁盘来源：NAS 直接读盘（后端已按真实落盘过滤来源；level/component/keyword 服务端二次过滤）
      const params = new URLSearchParams({ source: source.value, level: level.value, component: component.value, lines: String(count.value), keyword: keyword.value });
      const data: any = await request(`api/host/logs?${params}`);
      rows = data.lines || [];
      hostNote.value = data.note || '';
      availableSources.value = data.sources || [];
      serverTs = data.serverTs || 0;
    }
    if (disposed) return;
    lines.value = rows; error.value = '';
    // v0.21.166：记录「最后更新」——磁盘来源用后端 serverTs（真实服务端生成时刻），核心来源取本地完成时刻。
    lastUpdated.value = new Date(serverTs || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
    if (autoScroll.value) await nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight; });
  } catch (e) { if (!disposed) error.value = (e as Error).message; }
  finally { if (!disposed) loading.value = false; }
}
function changed() { loading.value = true; clearTimeout(debounce); debounce = setTimeout(() => void refresh(), 250); }
function pickSource() { changed(); }
function download() {
  const value = lines.value.map(row => `${row.at || ''}${row.at ? ' ' : ''}[${String(row.source).toUpperCase()}] [${String(row.level).toUpperCase()}] ${row.line}`).join('\n');
  const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `hermes-${source.value}-${new Date().toISOString().slice(0, 10)}.log`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const emptyHint = computed(() => {
  if (isCore.value && !serviceReady.value) return '核心日志需 Hermes 服务运行（当前未就绪）。请在「概览」中启动服务，或改用「宿主磁盘日志」。';
  if (hostNote.value) return hostNote.value;
  if (keyword.value || level.value !== 'all' || component.value !== 'all') return '当前过滤条件下没有匹配日志，可放宽级别 / 组件或清空关键词。';
  return '该来源当前没有日志内容。';
});

watch(() => runtime.profile, () => changed());
watch(source, pickSource);
// 来源过滤后，若当前选中项已不在可选清单（如本机未落盘的核心来源）→ 回落 all，避免悬空选中
watch([sourceGroups, source], () => {
  const values = sourceGroups.value.flatMap(g => g.children.map(c => c.value));
  if (!values.includes(source.value)) source.value = 'all';
});
// KeepAlive 下切页不卸载（onBeforeUnmount 不触发），定时器须随激活态停启，避免后台多页并行走轮询。
onActivated(() => { void refresh(); timer = setInterval(() => { if (live.value) void refresh(); }, 2000); });
onDeactivated(() => { clearInterval(timer); clearTimeout(debounce); });
onBeforeUnmount(() => { disposed = true; });
</script>
<template>
  <div class="toolbar"><div class="inline"><label class="inline">实时刷新 <n-switch v-model:value="live" size="small" /></label><label class="inline">自动滚动 <n-switch v-model:value="autoScroll" size="small" /></label></div><n-button :disabled="!lines.length" @click="download">下载当前结果</n-button></div>
  <n-card :bordered="false" class="filter-panel log-filter-panel">
    <div class="log-filter-grid">
      <label><span>日志来源</span><n-select v-model:value="source" :options="sourceGroups" /></label>
      <label><span>最低级别</span><n-select v-model:value="level" :options="levelOptions" @update:value="changed" /></label>
      <label><span>组件</span><n-select v-model:value="component" :options="componentOptions" @update:value="changed" /></label>
      <label class="log-search"><span>检索内容</span><n-input v-model:value="keyword" clearable placeholder="关键词、错误文本、路径…" @update:value="changed" /></label>
      <label><span>读取行数</span><n-select v-model:value="count" :options="[50, 100, 200, 500].map(value => ({ label: `${value} 行`, value }))" @update:value="changed" /></label>
    </div>
    <div class="log-source-meta">
      <span v-if="isCore">核心日志文件：<code>{{ source }}</code>（经 Hermes 服务）</span>
      <span v-else-if="availableSources.length">本机已落盘：<code>{{ availableSources.join(', ') }}</code></span>
      <span>Profile：<b>{{ runtime.profile }}</b></span>
      <span>当前结果：{{ lines.length }} 行</span>
      <span v-if="lastUpdated" class="muted" style="font-size:11px">最后更新 {{ lastUpdated }}</span>
      <n-tag v-if="summary.warnings" size="small" type="warning" :bordered="false">{{ summary.warnings }} 条警告</n-tag>
      <n-tag v-if="summary.errors" size="small" type="error" :bordered="false">{{ summary.errors }} 条错误</n-tag>
    </div>
  </n-card>
  <n-card :bordered="false">
    <ResourceState :loading="loading" :error="error" @retry="refresh">
      <div ref="logBox" class="logs">
        <div v-if="!lines.length" class="logs-empty muted">{{ emptyHint }}</div>
        <template v-else>
          <div v-for="(row, index) in lines" :key="`${row.at}-${index}`" :class="`log-line-${row.level}`"><span v-if="row.at" class="muted">{{ new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false }) }} </span><span class="log-source-chip">[{{ String(row.source).toUpperCase() }}]</span> {{ row.line }}</div>
        </template>
      </div>
    </ResourceState>
  </n-card>
</template>
