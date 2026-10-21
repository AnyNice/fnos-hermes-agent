<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NAlert, NButton, NConfigProvider, NDialogProvider, NIcon, NMessageProvider, NSelect, darkTheme, zhCN, dateZhCN } from 'naive-ui';
import { LayoutBoard, Folders, Cpu, Tool, PlugConnected, MessageCircle, CalendarTime, FileText, Settings, ExternalLink, Moon, Sun, DotsVertical, X } from '@vicons/tabler';
import { useRuntime } from './stores/runtime';
import { workUrl } from './api';
import Overview from './views/Overview.vue';
import Workspace from './views/Workspace.vue';
import NativePage from './views/NativePage.vue';
import Models from './views/Models.vue';
import Messaging from './views/Messaging.vue';
import SettingsPage from './views/Settings.vue';
import Logs from './views/Logs.vue';

const runtime = useRuntime();
const iconUrl = new URL('./hermes-icon.png', document.baseURI).href;
const pages = [
  { id: 'overview', label: '概览', icon: LayoutBoard, hint: '管理 Hermes 的运行与访问' },
  { id: 'workspace', label: '工作区', icon: Folders, hint: '查看项目目录，继续你的工作' },
  { id: 'models', label: '模型管理', icon: Cpu, hint: '模型与供应商配置' },
  { id: 'tools', label: '工具', icon: Tool, hint: '工具集、技能与插件' },
  { id: 'mcp', label: 'MCP', icon: PlugConnected, hint: '连接外部工具与服务' },
  { id: 'messaging', label: '通讯', icon: MessageCircle, hint: 'Hermes 原生消息平台' },
  { id: 'cron', label: '定时任务', icon: CalendarTime, hint: '计划任务与执行结果' },
  { id: 'logs', label: '运行日志', icon: FileText, hint: '查看服务输出与故障信息' },
  { id: 'settings', label: '应用设置', icon: Settings, hint: '应用配置与 Hermes 高级设置' },
];
const route = ref(location.hash.slice(2) || 'overview');
const page = computed(() => pages.find(p => p.id === route.value) || pages[0]);
const dark = ref(localStorage.getItem('hermes.admin.theme') === 'dark');
// 移动端导航（参考 deepseek harness：桌面侧栏 + 移动端底部 Tabbar；9 个页面放不下 5 个主项，剩余进「更多」弹层）
const mobileMore = ref(false);
// 移动端主栏 4 直达 + 「更多」（9 页超出 5 槽，次常用页进「更多」；应用设置常驻弹层、标签与桌面侧栏一致）
const mobileTabs = [
  { id: 'overview', label: '概览', icon: LayoutBoard },
  { id: 'workspace', label: '工作区', icon: Folders },
  { id: 'models', label: '模型', icon: Cpu },
  { id: 'messaging', label: '通讯', icon: MessageCircle },
  { more: true, id: 'more', label: '更多', icon: undefined },
];
function goMobile(item: { id: string; more?: boolean }) {
  if (item.more) { mobileMore.value = true; return; }
  window.location.hash = `#/${item.id}`;
}
const mobileMorePages = pages.filter(p => ['tools', 'mcp', 'cron', 'logs', 'settings'].includes(p.id));
const changeRoute = () => {mobileMore.value = false; if(runtime.unsaved&&!window.confirm('当前设置尚未保存，是否放弃修改并离开？')){history.replaceState(history.state,'',`#/${route.value}`);return;}route.value = location.hash.slice(2) || 'overview';};
function selectProfile(value:string){if(runtime.unsaved&&!window.confirm('当前设置尚未保存，是否放弃修改并切换 Profile？'))return;runtime.unsaved=false;runtime.profile=value;}
function guardNavigation(event:MouseEvent){const href=(event.target as Element).closest('a')?.getAttribute('href');if(href?.startsWith('#/')&&href!==location.hash&&runtime.unsaved){if(!window.confirm('当前设置尚未保存，是否放弃修改并离开？')){event.preventDefault();event.stopPropagation();}else runtime.unsaved=false;}}
function toggleTheme() { dark.value = !dark.value; localStorage.setItem('hermes.admin.theme', dark.value ? 'dark' : 'light'); }
let timer: ReturnType<typeof setInterval>;
onMounted(() => { window.addEventListener('hashchange', changeRoute); void runtime.refresh(); timer = setInterval(() => void runtime.refresh(), 5000); });
onBeforeUnmount(() => { window.removeEventListener('hashchange', changeRoute); clearInterval(timer); });
const themeOverrides = { common: { primaryColor: '#1669ff', primaryColorHover: '#4084ff', primaryColorPressed: '#0052d9', borderRadius: '10px', fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", sans-serif' }, Card: { borderRadius: '16px' } };
</script>
<template>
  <n-config-provider :theme="dark ? darkTheme : null" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider><n-dialog-provider>
      <div class="app-layout" :class="{ dark }" @click.capture="guardNavigation">
        <!-- 桌面侧边栏（移动端隐藏，改由底部 Tabbar 导航；参考 deepseek harness 移动端方案）-->
        <aside class="sidebar">
          <a class="brand" href="#/overview"><img class="brand-mark" :src="iconUrl" alt="Hermes" /><span><strong>Hermes Admin</strong><small>Hermes管理器</small></span></a>
          <div class="nav-caption">管理控制台</div>
          <nav><a v-for="item in pages" :key="item.id" :href="`#/${item.id}`" :class="{ active: page.id === item.id }"><n-icon :component="item.icon" size="20" /><span>{{ item.label }}</span></a></nav>
          <div class="sidebar-bottom"><div class="scope-label">当前 Profile</div><n-select :value="runtime.profile" @update:value="selectProfile" :options="runtime.profiles.length ? runtime.profiles.map(p => ({ label: p.display_name || p.name, value: p.name })) : [{label:'default',value:'default'}]" aria-label="当前 Profile" />
            <div class="sidebar-foot"><span><i :class="{ online: runtime.status?.backend.state === 'ready' }" />{{ runtime.status?.backend.state === 'ready' ? 'Hermes 已连接' : 'Hermes 未就绪' }}</span><button class="theme-toggle" @click="toggleTheme" aria-label="切换主题"><n-icon :component="dark ? Sun : Moon" size="18" /></button></div>
          </div>
        </aside>
        <main>
          <header class="page-header"><div><h1>{{ page.label }}</h1><p>{{ page.hint }}</p></div><n-button v-if="page.id !== 'overview'" tag="a" :href="workUrl(runtime.profile)" target="_blank" :disabled="runtime.status?.backend.state !== 'ready'"><template #icon><n-icon :component="ExternalLink" /></template>进入 Hermes</n-button></header>
          <div class="mobile-scope"><span>Profile</span><n-select :value="runtime.profile" @update:value="selectProfile" :options="runtime.profiles.length?runtime.profiles.map(p=>({label:p.display_name||p.name,value:p.name})):[{label:'default',value:'default'}]" /><button class="theme-toggle" @click="toggleTheme" aria-label="切换主题"><n-icon :component="dark?Sun:Moon" size="18" /></button></div>
          <n-alert v-if="runtime.error" type="error" class="mb" :bordered="false">{{ runtime.error }}</n-alert>
          <KeepAlive :max="10">
            <Overview v-if="page.id === 'overview'" key="overview" />
            <Workspace v-else-if="page.id === 'workspace'" key="workspace" />
            <Models v-else-if="page.id === 'models'" key="models" />
            <Messaging v-else-if="page.id === 'messaging'" key="messaging" />
            <SettingsPage v-else-if="page.id === 'settings'" key="settings" />
            <Logs v-else-if="page.id === 'logs'" key="logs" />
            <NativePage v-else :key="page.id" :kind="page.id" />
          </KeepAlive>
          <footer>Hermes Admin <span>·</span> 本机开发预览 <span>·</span> Hermes {{ runtime.version?.version || runtime.version?.tag || '—' }}</footer>
        </main>

        <!-- 移动端底部 Tabbar（参考 deepseek harness：主项 5 个 + 「更多」弹出剩余页）-->
        <nav class="mobile-tabbar" aria-label="移动端导航">
          <button v-for="item in mobileTabs" :key="item.id" type="button" :class="{ active: !item.more && page.id === item.id }" @click="goMobile(item)">
            <n-icon :component="item.more ? DotsVertical : item.icon!" size="21" />
            <span>{{ item.more ? '更多' : item.label }}</span>
          </button>
        </nav>
        <div v-if="mobileMore" class="mobile-sheet-backdrop" @click="mobileMore = false"></div>
        <div v-if="mobileMore" class="mobile-sheet" role="dialog" aria-label="更多功能">
          <div class="mobile-sheet-handle"></div>
          <div class="mobile-sheet-head"><span>更多功能</span><n-button quaternary circle size="small" @click="mobileMore = false"><n-icon :component="X" size="18" /></n-button></div>
          <a v-for="item in mobileMorePages" :key="item.id" :href="`#/${item.id}`" :class="{ active: page.id === item.id }" @click="mobileMore = false"><n-icon :component="item.icon" size="20" /><span>{{ item.label }}</span></a>
          <div class="mobile-sheet-foot"><span><i :class="{ online: runtime.status?.backend.state === 'ready' }" />{{ runtime.status?.backend.state === 'ready' ? 'Hermes 已连接' : 'Hermes 未就绪' }}</span></div>
        </div>
      </div>
    </n-dialog-provider></n-message-provider>
  </n-config-provider>
</template>
