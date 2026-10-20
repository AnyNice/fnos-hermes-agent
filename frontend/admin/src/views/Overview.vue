<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NButton, NCard, NIcon, NModal, NSelect, NSwitch, NTag, NCheckbox, useDialog, useMessage } from 'naive-ui';
import { PlayerPlay, PlayerStop, Refresh, ExternalLink, Settings } from '@vicons/tabler';
import { useRuntime } from '../stores/runtime';
import { request, workUrl } from '../api';
const runtime = useRuntime(); const message = useMessage(); const dialog = useDialog();
const iconUrl = new URL('./hermes-icon.png', document.baseURI).href;
const ready = computed(() => runtime.status?.backend.state === 'ready');
const stateText = computed(() => ({ ready: '运行中', starting: '启动中', stopped: '已停止', unavailable: '不可用' }[runtime.status?.backend.state as string] || '正在检查'));
const commit = computed(() => String(runtime.version?.commit || '—').slice(0, 8));
const build = computed(() => runtime.version?.builtAt ? new Date(runtime.version.builtAt).toLocaleString('zh-CN', { hour12: false }) : '—');
// 通讯网关状态（由 host 探测：读 gateway.pid + 服务商配置就绪）
const gw = computed(() => runtime.status?.gateway || {});
const gwRunning = computed(() => gw.value.state === 'running');
const gwProviderReady = computed(() => !!gw.value.providerReady);

// ── 指标卡自定义（7 张里选哪 3–5 张，本设备记忆）：默认展示 服务/网关 + CPU/内存 + Profile ──
const METRIC_DEFS = [
  { key: 'service', label: '工作服务' },
  { key: 'core', label: '核心版本' },
  { key: 'gateway', label: '通讯网关' },
  { key: 'profile', label: '当前 Profile' },
  { key: 'pid', label: '运行进程' },
  { key: 'cpu', label: 'CPU 占用' },
  { key: 'mem', label: '内存占用' },
];
const DEFAULT_METRICS = ['service', 'gateway', 'cpu', 'mem', 'profile'];
const metricsModal = ref(false);
function loadMetrics(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem('hermes.admin.overview.metrics') || 'null');
    if (Array.isArray(arr)) {
      const valid = METRIC_DEFS.map(d => d.key).filter(k => arr.includes(k));
      if (valid.length >= 3 && valid.length <= 5) return valid;
    }
  } catch {}
  return [...DEFAULT_METRICS];
}
const metrics = ref<string[]>(loadMetrics());
function toggleMetric(key: string) {
  if (metrics.value.includes(key)) {
    if (metrics.value.length <= 3) return message.warning('至少保留 3 张卡片');
    metrics.value = metrics.value.filter(k => k !== key);
  } else {
    if (metrics.value.length >= 5) return message.warning('最多展示 5 张卡片，请先取消勾选一张');
    metrics.value = [...metrics.value, key];
  }
  persistMetrics();
}
function persistMetrics() { try { localStorage.setItem('hermes.admin.overview.metrics', JSON.stringify(metrics.value)); } catch {} }
const metricLabel = (key: string) => METRIC_DEFS.find(d => d.key === key)?.label || key;

// ── 指标卡列数：桌面按当前展示张数排一列，移动端固定 2 列（最后一张奇数卡 span 整行）──
const isNarrow = ref(false);
function updateNarrow() { isNarrow.value = window.innerWidth <= 760; }
const metricCols = computed(() => (isNarrow.value ? 2 : Math.max(metrics.value.length, 3)));

// ── 指标卡拖拽排序（桌面按下即拖 / 移动端长按 350ms 后拖；幽灵体跟手 + 原位占位 + 其余卡实时补位；顺序持久化）──
const metricsEl = ref<HTMLElement | null>(null);
const dragGhost = ref<{ key: string; x: number; y: number; w: number; h: number } | null>(null);
const dragHideKey = ref<string | null>(null);
interface DragState {
  key: string; pointerId: number; sx: number; sy: number;
  timer: number | null; active: boolean; isTouch: boolean;
  el: HTMLElement; rect: DOMRect;
}
let dragState: DragState | null = null;
function activateDrag(state: DragState) {
  state.active = true;
  dragHideKey.value = state.key;
  dragGhost.value = { key: state.key, x: state.rect.left, y: state.rect.top, w: state.rect.width, h: state.rect.height };
  try { (navigator as any).vibrate?.(8); } catch {}
}
// 拖拽目标索引：按当前列数（桌面 1 行 N 列 / 移动端 2 列）把指针坐标换算到网格位置
function targetIndexAt(x: number, y: number): number {
  const el = metricsEl.value;
  if (!el) return -1;
  const len = metrics.value.length;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return -1;
  const numCols = isNarrow.value ? 2 : metricCols.value;
  const colWidth = rect.width / numCols;
  const rowCount = Math.ceil(len / numCols);
  const rowHeight = rect.height / rowCount;
  const col = Math.max(0, Math.min(numCols - 1, Math.floor((x - rect.left) / colWidth)));
  const row = Math.max(0, Math.min(rowCount - 1, Math.floor((y - rect.top) / rowHeight)));
  return Math.max(0, Math.min(len - 1, row * numCols + col));
}
function onMetricPointerMove(e: PointerEvent) {
  const state = dragState;
  if (!state || e.pointerId !== state.pointerId) return;
  if (!state.active) {
    const dist = Math.hypot(e.clientX - state.sx, e.clientY - state.sy);
    if (state.isTouch) { if (dist > 12) cancelDrag(); return; }   // 触屏位移=想滚动，取消拖拽
    if (dist > 4) activateDrag(state);
    return;
  }
  e.preventDefault();
  const ghost = dragGhost.value;
  if (ghost) { ghost.x = e.clientX - state.rect.width / 2; ghost.y = e.clientY - state.rect.height / 2; }
  const target = targetIndexAt(e.clientX, e.clientY);
  const from = metrics.value.indexOf(state.key);
  if (from !== -1 && target !== -1 && from !== target) {
    const next = [...metrics.value]; next.splice(from, 1); next.splice(target, 0, state.key);
    metrics.value = next;
  }
}
function onMetricPointerDown(e: PointerEvent, metricKey: string) {
  if ((e.pointerType === 'mouse' && e.button !== 0) || dragState) return;
  const el = e.currentTarget as HTMLElement;
  const state: DragState = { key: metricKey, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, timer: null, active: false, isTouch: e.pointerType !== 'mouse', el, rect: el.getBoundingClientRect() };
  dragState = state;
  if (state.isTouch) state.timer = window.setTimeout(() => { if (dragState === state && !state.active) activateDrag(state); }, 350);
  window.addEventListener('pointermove', onMetricPointerMove, { passive: false });
  window.addEventListener('pointerup', onMetricPointerEnd);
  window.addEventListener('pointercancel', onMetricPointerEnd);
}
function onMetricPointerEnd() { finishDrag(); }
function finishDrag() {
  const state = dragState;
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  if (state.active) persistMetrics();
  dragState = null; dragGhost.value = null; dragHideKey.value = null;
  window.removeEventListener('pointermove', onMetricPointerMove);
  window.removeEventListener('pointerup', onMetricPointerEnd);
  window.removeEventListener('pointercancel', onMetricPointerEnd);
}
function cancelDrag() { finishDrag(); }

// ── Hermes 进程资源占用（宿主 /proc 采样：monitor + 工作服务 + 网关；CPU 为采样间隔平均）──
const resources = ref<any>(null);
let resTimer: ReturnType<typeof setInterval>;
async function loadResources() { try { resources.value = await request('api/host/resources'); } catch {} }

// ── 运行日志窗（替换原「常用入口」：宿主磁盘最新日志，5s 自动刷新）──
const logSource = ref('host');
const logLines = ref(100);
const logLive = ref(true);
const logRows = ref<any[]>([]);
const logSourceOptions = ['host', 'all', 'dashboard', 'gateway', 'agent', 'error'].map(v => ({ value: v, label: ({ host: '宿主 monitor', all: '全部磁盘来源', dashboard: '仪表盘', gateway: '通讯网关', agent: 'Agent', error: '错误日志' } as Record<string, string>)[v] }));
let logTimer: ReturnType<typeof setInterval>;
async function loadLog() {
  try {
    const data: any = await request(`api/host/logs?source=${logSource.value}&lines=${logLines.value}`);
    logRows.value = data.lines || [];
  } catch {}
}

async function execute(action: string) {
  try { await runtime.service(action); message.success(action === 'stop' ? 'Hermes 工作服务已停止' : '已提交服务操作，请等待状态更新'); }
  catch (e) { message.error((e as Error).message); }
}
function service(action: string) {
  if (action === 'start') return execute(action);
  dialog.warning({ title: action === 'stop' ? '停止 Hermes 工作服务？' : '重启 Hermes 工作服务？', content: '进行中的对话会中断。Admin 将保持可用；通讯网关独立管理（见上方指标卡）。', positiveText: '继续', negativeText: '取消', onPositiveClick: () => execute(action) });
}
async function gatewayAction(action: 'start' | 'stop') {
  if (action === 'start') {
    if (!gwProviderReady.value) return message.warning('通讯网关需要模型支持：请先在「模型管理」配置服务商，并到「通讯」配置机器人通道后再启动。');
  }
  try { await runtime.gatewayService(action); message.success(action === 'stop' ? '通讯网关已停止' : '通讯网关启动中'); }
  catch (e) { message.error((e as Error).message); }
}
function metricValue(key: string): string {
  switch (key) {
    case 'service': return stateText.value;
    case 'core': return runtime.status?.backend.native?.version || runtime.version?.version || '—';
    case 'gateway': return gwRunning.value ? '运行中' : '未运行';
    case 'profile': return runtime.profile;
    case 'pid': return String(runtime.status?.pid || '—');
    case 'cpu': {
      const running = (resources.value?.processes || []).filter((p: any) => p.running);
      if (!running.length) return '—';
      const t: any = resources.value?.total || {};
      // 方案A：主数字用整机口径（÷核数，0–100），与右侧 FnNAS 系统监控同基准可直接对比；
      // 旧版后端无 cpuPercentOfMachine 字段时，用 totalCpu÷核数 回退；核数未知则保留单核当量。
      const cores = Number(t.cpuCores) || 0;
      const val = typeof t.cpuPercentOfMachine === 'number'
        ? t.cpuPercentOfMachine
        : cores ? Number(t.cpuPercent || 0) / cores
        : Number(t.cpuPercent || 0);
      return `${val.toFixed(1)}%`;
    }
    case 'mem': {
      const running = (resources.value?.processes || []).filter((p: any) => p.running);
      if (!running.length) return '—';
      const mb = Number(resources.value?.total?.memoryMb || 0);
      return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
    }
    default: return '—';
  }
}
onMounted(() => {
  updateNarrow(); window.addEventListener('resize', updateNarrow);
  void loadResources(); resTimer = setInterval(loadResources, 3000);
  void loadLog(); logTimer = setInterval(() => { if (logLive.value) void loadLog(); }, 5000);
});
onBeforeUnmount(() => { clearInterval(resTimer); clearInterval(logTimer); window.removeEventListener('resize', updateNarrow); finishDrag(); });
</script>
<template>
  <n-card :bordered="false" class="hero-card">
    <div class="hero-head"><div class="hero-brand"><img class="app-icon" :src="iconUrl" alt="Hermes"/><div><div class="hero-title">Hermes Agent <n-tag :type="ready ? 'success' : 'default'" size="small" round :bordered="false">{{ stateText }}</n-tag></div><div class="version-line"><span>版本: {{ runtime.version?.version||runtime.version?.tag||'—' }}</span><span>| Commit: {{ commit }}</span><span>| Build: {{ build }}</span><span>|</span></div></div></div><n-button type="primary" size="large" tag="a" :href="workUrl(runtime.profile)" target="_blank" :disabled="!ready"><template #icon><n-icon :component="ExternalLink" /></template>进入 Hermes</n-button></div>
    <div class="metrics-settings-row"><n-button quaternary circle title="选择要展示的指标卡片（7 选 3–5）" @click="metricsModal = true" aria-label="自定义指标卡片"><n-icon :component="Settings" /></n-button></div>
    <div ref="metricsEl" class="metrics" :style="{ gridTemplateColumns: `repeat(${metricCols}, minmax(0, 1fr))` }">
      <div v-for="(metricKey, mi) in metrics" :key="metricKey" :class="['metric-cell', dragHideKey === metricKey ? 'metric-cell-hidden' : '', isNarrow && metrics.length % 2 === 1 && mi === metrics.length - 1 ? 'metric-cell-span2' : '']" @pointerdown="onMetricPointerDown($event, metricKey)"><span class="metric-label">{{ metricLabel(metricKey) }}</span><strong>{{ metricValue(metricKey) }}</strong><span v-if="metricKey==='cpu'" class="metric-sub">Hermes 进程 · 整机口径{{ resources?.total?.cpuCores ? ' · ' + resources.total.cpuCores + ' 核' : '' }} · 3s 采样</span><span v-else-if="metricKey==='mem'" class="metric-sub">Hermes 进程 · RSS · 3s 采样</span><div v-if="metricKey==='gateway'" class="metric-sub metric-gw-sub"><a class="gw-chip" href="#/messaging">配置机器人</a><button v-if="!gwRunning" class="gw-chip gw-chip-primary" type="button" :disabled="runtime.busy" @click="gatewayAction('start')">启动</button><button v-else class="gw-chip" type="button" :disabled="runtime.busy" @click="gatewayAction('stop')">停止</button><span v-if="!gwProviderReady" class="gw-hint">需模型支持</span></div></div>
    </div>
    <div v-if="dragGhost" class="metric-ghost" :style="{ left: dragGhost.x + 'px', top: dragGhost.y + 'px', width: dragGhost.w + 'px', height: dragGhost.h + 'px' }"><span class="metric-label">{{ metricLabel(dragGhost.key) }}</span><strong>{{ metricValue(dragGhost.key) }}</strong></div>
    <n-modal v-model:show="metricsModal" preset="card" title="自定义指标卡片" style="width:380px;max-width:calc(100vw - 32px)"><p class="muted mb">选择概览顶部展示哪些卡片（3–5 张），选择与顺序都保存在本设备；顶部卡片可直接长按/拖动调整顺序。CPU 显示为 Hermes 相关进程（宿主 monitor、工作服务、通讯网关）合计占用的<strong>整机容量百分比</strong>（已按核数归一化，与右侧系统监控同基准、0–100），每 3 秒采样；内存为 RSS。</p><div class="metrics-picker"><n-checkbox v-for="def in METRIC_DEFS" :key="def.key" :checked="metrics.includes(def.key)" @update:checked="toggleMetric(def.key)">{{ def.label }}</n-checkbox></div></n-modal>
  </n-card>
  <section class="section-title"><h2>运行管理</h2><span>点击图标即可操作 · Admin 在工作服务停止后仍可访问</span></section>
  <div class="control-grid">
    <n-card :bordered="false"><button class="control-icon svc-btn blue" type="button" :class="{ busy: runtime.busy }" :disabled="ready || !!runtime.status?.pid" @click="service('start')" aria-label="启动 Hermes"><n-icon :component="PlayerPlay" /></button><h3>启动服务</h3><p>启动官方 Hermes 后端，为工作界面提供服务。</p></n-card>
    <n-card :bordered="false"><button class="control-icon svc-btn amber" type="button" :class="{ busy: runtime.busy }" :disabled="!runtime.status?.pid" @click="service('restart')" aria-label="重启 Hermes"><n-icon :component="Refresh" /></button><h3>重启服务</h3><p>重新连接工作界面，应用需要重启的配置。</p></n-card>
    <n-card :bordered="false"><button class="control-icon svc-btn slate" type="button" :class="{ busy: runtime.busy }" :disabled="!runtime.status?.pid" @click="service('stop')" aria-label="停止 Hermes"><n-icon :component="PlayerStop" /></button><h3>停止服务</h3><p>停止当前工作服务，保留全部数据。</p></n-card>
  </div>
  <section class="section-title"><h2>运行日志</h2><span>宿主磁盘最新日志 · <n-button text size="small" tag="a" href="#/logs" :bordered="false">打开完整日志页 →</n-button></span></section>
  <n-card :bordered="false">
    <div class="log-window-toolbar">
      <n-select v-model:value="logSource" size="small" :options="logSourceOptions" style="width:150px" @update:value="loadLog" />
      <n-select v-model:value="logLines" size="small" :options="[50,100,200].map(v=>({label:`${v} 行`,value:v}))" style="width:110px" @update:value="loadLog" />
      <label class="inline"><n-switch v-model:value="logLive" size="small" />自动刷新</label>
      <n-button size="small" quaternary @click="loadLog">刷新</n-button>
    </div>
    <div class="log-window"><div v-if="!logRows.length" class="muted">该来源暂无日志内容（可能尚未运行或文件未落盘）。</div><div v-for="(row, index) in logRows" :key="index" :class="`ll-${row.level}`"><span class="ll-src">[{{ String(row.source).toUpperCase() }}]</span> {{ row.line }}</div></div>
  </n-card>
</template>
