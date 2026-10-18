import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

export function useResource<T>(load: () => Promise<T>, dependencies: Ref<any>[]) {
  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(false);
  const error = ref('');
  let generation = 0;
  async function refresh() {
    const current = ++generation;
    loading.value = true; error.value = ''; data.value = null;
    try { const result = await load(); if (current === generation) data.value = result; }
    catch (e) { if (current === generation) error.value = (e as Error).message; }
    finally { if (current === generation) loading.value = false; }
  }
  watch(dependencies, refresh, { immediate: true });
  onBeforeUnmount(() => { generation++; });
  return { data, loading, error, refresh };
}
