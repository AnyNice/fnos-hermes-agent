export const hostRoot = new URL('./', window.location.href);

// 宿主 API 统一 60s 超时：NAS 门户反代链（浏览器→fnOS→unix socket→monitor→网关）下，
// 通讯页 /api/status + /api/messaging/platforms 的冷探测（首次可达性检查、网关刚重启、
// 叠 CF 隧道抖动）偶发 >30s，30s 会让前端先 Abort 弹「请求超时（30s 内未响应）」红框，
// 而宿主/网关实际还在正常工作。放宽到 60s 与 monitor.js 的 native 反代超时对齐（双 60s），
// 消除「宿主 10s 先砍 / 前端 30s 先砍」的撞车红框。
// 仍设超时是必要的：若某请求真正挂起，裸 fetch 永不返回会让 runtime.busy 永久卡 true，
// 导致概览页「运行管理」三个按钮（disabled 条件含 busy）全部点不了——60s 是兜底而非取消。
const REQUEST_TIMEOUT_MS = 60000;

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
