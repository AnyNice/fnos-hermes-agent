import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { native, request } from '../api';

export const useRuntime = defineStore('runtime', () => {
  const profile = ref(new URLSearchParams(location.search).get('profile') || 'default');
  const unsaved = ref(false);
  const profiles = ref<Array<{name: string; display_name?: string}>>([]);
  const status = ref<any>(null);
  const version = ref<any>(null);
  const error = ref('');
  const busy = ref(false);
  watch(profile,value=>{const url=new URL(location.href);url.searchParams.set('profile',value);history.replaceState(history.state,'',url);});
  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      status.value = await request('api/host/status'); error.value = '';
      if (!version.value) version.value = await request('api/host/version');
      if (status.value.backend.state === 'ready') {
        const result = await native('/api/profiles', profile.value);
        profiles.value = result.profiles;
      }
    } catch (e) { error.value = String((e as Error).message); }
    finally { refreshing = false; }
  }
  async function service(action: string) {
    if (busy.value) return; // 入口守卫：操作进行中忽略重复请求（请求层有 30s 超时兜底，busy 不会永久卡死）
    busy.value = true;
    try { await request(`api/host/service/${action}`, { method: 'POST' }); await refresh(); }
    finally { busy.value = false; }
  }
  async function gatewayService(action: 'start' | 'stop') {
    if (busy.value) return;
    busy.value = true;
    try { await request(`api/host/service/gateway/${action}`, { method: 'POST' }); await refresh(); }
    finally { busy.value = false; }
  }
  return { profile, unsaved, profiles, status, version, error, busy, refresh, service, gatewayService };
});
