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
  if (!response.ok) {
    const rawMsg = typeof value.detail === 'string' ? value.detail : value.error || `请求失败 (${response.status})`;
    // 核心（dashboard）未就绪识别：502/503 且文案含 unavailable/不可用 → 打可识别标记。
    // 首装冷启动（~1 分钟）窗口里用户操作配置页，native 反代 9219 尚未监听，monitor 回
    // 502「Dashboard unavailable / 原生服务不可用」——此前被渲染成通用红 toast，误导用户
    // 以为是配置填错。上层据此区分「核心初始化中」（可等待/自愈）与「真正写失败」（需排查）。
    if ((response.status === 502 || response.status === 503) && /unavailable|不可用|not (yet )?available/i.test(rawMsg)) {
      const e = new Error('核心服务尚未就绪（首次安装初始化中，约需 1 分钟）') as Error & { name: string; coreNotReady?: boolean };
      e.name = 'CoreNotReady'; e.coreNotReady = true; throw e;
    }
    throw new Error(rawMsg);
  }
  return value as T;
}

// 同飞行去重（v0.21.163）：切页/并发时，完全相同的 GET（同 URL+profile）在飞期内合并为一次真实请求，
// 消除「每次切换功能页都重新拉一遍 Hermes 数据」的重复与慢（多个请求同时打到同一 dashboard 端点排队）。
const _inflight = new Map<string, Promise<unknown>>();
// GET 结果 TTL 缓存（v0.21.166）：5s 窗口内的相同 GET 直接复用上次成功结果，消除「切走再切回
// 隔 1~5s」场景的重复拉取（in-flight 去重只合「同时在飞」，时序错开就失效）。
// 豁免实时端点（/api/logs、resources、status：日志窗口与 3s/5s 采样要求新鲜）；
// 任何写操作（POST/PUT/DELETE）成功即全量失效——配置改动后读路径必须拿新值。
const _getCache = new Map<string, { at: number; promise: Promise<unknown> }>();
const GET_CACHE_TTL_MS = 5000;
const GET_CACHE_EXEMPT = /\/(logs|resources|status)(\?|$)/;
function nativeInvalidateCache() { _getCache.clear(); }
export function native<T = any>(path: string, profile: string, method = 'GET', body?: unknown, opts: { noCache?: boolean } = {}): Promise<T> {
  const url = new URL(`api/native${path}`, hostRoot);
  url.searchParams.set('profile', profile);
  // 仅 GET 且无 body 可去重（幂等读）；POST/PUT 有副作用，绝不合并。
  if (method === 'GET' && body === undefined) {
    const key = url.href;
    const existing = _inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = request<T>(url.href, { method }).finally(() => { _inflight.delete(key); });
    _inflight.set(key, p);
    if (!opts.noCache && !GET_CACHE_EXEMPT.test(path)) {
      const now = Date.now();
      const hit = _getCache.get(key);
      if (hit && now - hit.at < GET_CACHE_TTL_MS) return hit.promise as Promise<T>;
      const entry: { at: number; promise: Promise<unknown> } = { at: now, promise: p };
      _getCache.set(key, entry);
      // 成功落地后刷新 at（计时从返回算起，慢请求不吃满 5s 窗口）；失败则摘除——陈旧/错误结果不可缓存。
      p.then(() => { entry.at = Date.now(); }, () => { _getCache.delete(key); });
      return entry.promise as Promise<T>;
    }
    return p;
  }
  const p = request(url.href, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  // 写操作成功 → 读缓存全部失效（配置/模型/端点已变，陈旧 GET 结果必须不再复用）。
  p.then(() => { if (method !== 'GET') nativeInvalidateCache(); }).catch(() => {});
  return p as Promise<T>;
}

export function workUrl(profile: string): string {
  const url = new URL('web/', hostRoot); url.searchParams.set('profile', profile); return url.href;
}
