<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import { NButton, NCard, NEllipsis, NEmpty, NGrid, NGi, NIcon, NThing, NTime, NTooltip, NTag, useMessage } from 'naive-ui';
import { Folder, ExternalLink, Clock, Calendar } from '@vicons/tabler';
import { useRuntime } from '../stores/runtime';
import { request, workUrl } from '../api';
import { useResource } from '../composables';
import ResourceState from '../components/ResourceState.vue';

const runtime = useRuntime();
const message = useMessage();
const scanning = ref(false);
const { data, loading, error, refresh } = useResource(
  () => request(`api/host/projects?profile=${encodeURIComponent(runtime.profile)}`),
  [toRef(runtime, 'profile')],
);
const projects = computed(() => (data.value?.projects || []).filter((p: any) => p.path && !p.isNoProject));
const dataRoot = computed(() => runtime.status?.dataRoot || '');
const workspaceDir = computed(() => runtime.status?.workspacesRoot || '');

// 强制触发一次磁盘仓库扫描（绕过 60s 节流）；扫描根默认指向 TRIM_PKGHOME/workspaces（HERMES_HOME 之外）
async function rescan() {
  scanning.value = true;
  try {
    await request(`api/host/projects?profile=${encodeURIComponent(runtime.profile)}&refresh=1`);
    await refresh();
  } catch {}
  scanning.value = false;
}

async function locate(directory: string) {
  try {
    const { TrimApp } = await import('@trimjs/web-app');
    if (window.parent !== window) {
      const sdk = new TrimApp(); await sdk.ready();
      if (!sdk.isStandaloneWeb) { await sdk.openFileManager(directory); return; }
    }
    await navigator.clipboard.writeText(directory);
    message.success('已复制目录路径，请在飞牛文件管理中打开');
  } catch { message.info(`目录：${directory}`); }
}
</script>
<template>
  <div class="ws-page">
    <!-- 页头：标题 + 数据目录 -->
    <div class="ws-head">
      <div class="ws-head-title"><h1>工作区</h1><n-tag v-if="projects.length" size="small" :bordered="false">{{ projects.length }} 个</n-tag></div>
      <n-tooltip trigger="hover" :disabled="!dataRoot">
        <template #trigger>
          <n-button size="small" secondary :disabled="!dataRoot" @click="locate(dataRoot)">数据目录</n-button>
        </template>
        {{ dataRoot ? `在文件管理中打开：${dataRoot}` : '数据目录路径未配置' }}
      </n-tooltip>
    </div>

    <ResourceState :loading="loading" :error="error" @retry="refresh">
      <!-- 空状态 -->
      <n-card v-if="!projects.length" :bordered="false" class="ws-empty">
        <n-empty description="还没有工作区">
          <template #icon><n-icon :size="44" class="ws-empty-icon"><Folder /></n-icon></template>
          <template #extra>
            <p class="muted">把项目（git 仓库）放进工作区目录后，或让 Hermes 在其中跑一次会话，工作区就会显示在这里。</p>
            <div class="inline ws-empty-actions">
              <n-tooltip v-if="workspaceDir" trigger="hover">
                <template #trigger>
                  <n-button size="small" secondary @click="locate(workspaceDir)">工作区目录</n-button>
                </template>
                {{ workspaceDir }}
              </n-tooltip>
              <n-button size="small" :loading="scanning" @click="rescan">重新扫描</n-button>
              <n-button type="primary" size="small" tag="a" :href="workUrl(runtime.profile)" target="_blank">进入 Hermes</n-button>
            </div>
          </template>
        </n-empty>
      </n-card>

      <!-- 卡片网格 -->
      <n-grid v-else :cols="2" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
        <n-gi span="2 m:1" v-for="project in projects" :key="project.id || project.path">
          <n-card hoverable :bordered="false" class="ws-card" @click="locate(project.path)">
            <n-thing>
              <template #avatar>
                <n-tooltip trigger="hover">
                  <template #trigger><div class="ws-card-avatar"><n-icon :component="Folder" :size="22" /></div></template>
                  在文件管理中打开 {{ project.label || project.path }}
                </n-tooltip>
              </template>
              <template #header>
                <div class="ws-card-title"><n-ellipsis :line-clamp="1" :tooltip="true">{{ project.label || project.path }}</n-ellipsis></div>
              </template>
              <template #header-extra>
                <n-tooltip trigger="hover">
                  <template #trigger><n-tag size="tiny" round :bordered="false" type="info" class="mono">{{ project.sessionCount == null ? '会话数不可用' : `${project.sessionCount} 会话` }}</n-tag></template>
                  包含 {{ project.sessionCount ?? 0 }} 个活动对话会话
                </n-tooltip>
              </template>
              <template #description>
                <div class="ws-card-path"><n-ellipsis :line-clamp="1" :tooltip="true">{{ project.path }}</n-ellipsis></div>
              </template>
              <template #footer>
                <div class="ws-card-foot">
                  <n-tooltip v-if="project.lastActive" trigger="hover">
                    <template #trigger><div class="ws-foot-item"><n-icon :component="Clock" :size="12" /><span>更新于 <n-time :time="new Date(project.lastActive * 1000)" type="relative" /></span></div></template>
                    更新于：{{ new Date(project.lastActive * 1000).toLocaleString() }}
                  </n-tooltip>
                  <span v-else class="ws-foot-item"><n-icon :component="Calendar" :size="12" /><span class="muted">暂无活动记录</span></span>
                </div>
              </template>
            </n-thing>
          </n-card>
        </n-gi>
      </n-grid>
    </ResourceState>
  </div>
</template>
