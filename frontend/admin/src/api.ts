export const hostRoot = new URL('./', window.location.href);

// 宿主 API 统一 30s 超时：NAS 门户反代链（浏览器→fnOS→unix socket→monitor）下
// 若某次请求挂起，裸 fetch 永不返回，runtime.busy 将永久卡 true，
// 导致概览页「运行管理」三个按钮（disabled 条件含 busy）全部点不了。
const REQUEST_TIMEOUT_MS = 30000;

// AbortSignal.timeout 在部分老 WebView（Chromium < 103）里不存在，手动 fallback。
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('request timeout')), ms);
  return controller.signal;
}

export async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const signal = options.signal || timeoutSignal(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(new URL(path, hostRoot), { credentials: 'same-origin', signal, ...options });
  } catch (e) {
    const domEx = e instanceof DOMException ? e : undefined;
    if (domEx && (domEx.name === 'TimeoutError' || domEx.name === 'AbortError')) {
      throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s 内未响应），请查看「运行日志」中 monitor 来源日志`);
    }
    throw e;
  }
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : value.error || `请求失败 (${response.status})`);
  return value as T;
}

export function native<T = any>(path: string, profile: string, method = 'GET', body?: unknown): Promise<T> {
  const url = new URL(`api/native${path}`, hostRoot);
  url.searchParams.set('profile', profile);
  return request<T>(url.href, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
}

export function workUrl(profile: string): string {
  const url = new URL('web/', hostRoot); url.searchParams.set('profile', profile); return url.href;
}
