<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NButton, NEmpty, NSpin } from 'naive-ui';
import { useRuntime } from '../stores/runtime';

const props = defineProps<{ loading: boolean; error: string; empty?: boolean }>();
const emit = defineEmits<{ retry: [] }>();
const runtime = useRuntime();

// 「桌面假设断裂」统一诊断：native 页经 dashboard(9219) 读取数据，
// 工作服务未启动时全是 502/503/unavailable。这里把裸错误升级为可操作诊断：
// 直接给「启动工作服务」按钮，而不是让用户自己猜去概览页找。
const backendDown = computed(() =>
  !!props.error &&
  (/unavailable|502|503|ECONNREFUSED|拒绝连接|代理不可用|backend/i.test(props.error) ||
    (runtime.status?.backend?.state && runtime.status.backend.state !== 'ready' && runtime.status.backend.state !== 'starting'))
);
const hint = computed(() => {
  if (!backendDown.value) return '';
  if (runtime.status?.backend?.state === 'stopped' || runtime.status?.backend?.state === 'unavailable')
    return 'Hermes 工作服务（Dashboard）当前未运行，读取原生数据需要它在线。';
  if (runtime.status?.backend?.state === 'starting')
    return 'Hermes 工作服务正在启动中，请稍候片刻再读取。';
  return 'Hermes 工作服务状态异常，请检查「概览」页或「运行日志」。';
});
async function startBackend() {
  try {
    await runtime.service('start');
    await new Promise(r => setTimeout(r, 2500));
    emit('retry');
  } catch { /* 失败会反映在 error 刷新后的状态 */ }
}
</script>
<template>
  <n-alert v-if="error && backendDown" title="通讯后端当前不可用（Dashboard unavailable）" type="warning" :bordered="false">
    {{ hint }} 原始错误：{{ error }}
    <div class="mt"><n-space>
      <n-button size="small" type="primary" :disabled="runtime.busy || runtime.status?.backend?.state === 'starting'" @click="startBackend">启动工作服务并重试</n-button>
      <n-button size="small" @click="$emit('retry')">重新读取</n-button>
    </n-space></div>
  </n-alert>
  <n-alert v-else-if="error" title="暂时无法读取" type="error" :bordered="false">{{ error }}<div class="mt"><n-button size="small" @click="$emit('retry')">重新读取</n-button></div></n-alert>
  <div v-else-if="loading" class="state"><n-spin size="small" /><span>正在读取 Hermes 数据</span></div>
  <n-empty v-else-if="empty" description="当前 Profile 暂无内容" class="state" />
  <slot v-else />
</template>
