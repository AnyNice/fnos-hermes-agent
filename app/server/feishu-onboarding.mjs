import { randomBytes } from 'node:crypto';

const accountsOrigins = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
};
const openOrigins = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};
const registrationPath = '/oauth/v1/app/registration';

function normalizedDomain(value) {
  return value === 'lark' ? 'lark' : 'feishu';
}

async function responseJson(response) {
  const text = await response.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`飞书配置服务返回了无法解析的响应 (${response.status})`); }
  if (!response.ok && !value.error) throw new Error(`飞书配置服务请求失败 (${response.status})`);
  return value;
}

async function postRegistration(fetchImpl, domain, body) {
  const response = await fetchImpl(`${accountsOrigins[normalizedDomain(domain)]}${registrationPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(12_000),
  });
  return responseJson(response);
}

async function probeBot(fetchImpl, credentials) {
  const origin = openOrigins[normalizedDomain(credentials.domain)];
  try {
    const tokenResponse = await fetchImpl(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ app_id: credentials.app_id, app_secret: credentials.app_secret }),
      signal: AbortSignal.timeout(12_000),
    });
    const token = await responseJson(tokenResponse);
    if (!token.tenant_access_token) return {};
    const botResponse = await fetchImpl(`${origin}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${token.tenant_access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    const value = await responseJson(botResponse);
    if (value.code !== 0) return {};
    const bot = value.bot || value.data?.bot || {};
    return { bot_name: bot.app_name || bot.bot_name || '', bot_open_id: bot.open_id || '' };
  } catch {
    return {};
  }
}

function publicSession(record) {
  return {
    pairing_id: record.id,
    status: record.status,
    qr_payload: record.qrUrl,
    user_code: record.userCode,
    domain: record.domain,
    expires_at: new Date(record.expiresAt).toISOString(),
    poll_after_ms: Math.max(1200, record.interval * 1000),
    open_id: record.openId || null,
    bot_name: record.botName || null,
    bot_open_id: record.botOpenId || null,
    error: record.error || null,
  };
}

export class FeishuOnboarding {
  constructor({ fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sessions = new Map();
  }

  prune() {
    const cutoff = this.now() - 60_000;
    for (const [id, record] of this.sessions) {
      if (record.expiresAt < cutoff || (record.consumedAt && record.consumedAt < cutoff)) this.sessions.delete(id);
    }
  }

  require(id) {
    this.prune();
    const record = this.sessions.get(id);
    if (!record) throw Object.assign(new Error('飞书扫码会话不存在或已过期，请重新开始'), { statusCode: 404 });
    return record;
  }

  async start({ domain = 'feishu' } = {}) {
    this.prune();
    domain = normalizedDomain(domain);
    const init = await postRegistration(this.fetchImpl, domain, { action: 'init' });
    if (!(init.supported_auth_methods || []).includes('client_secret')) {
      throw new Error(`当前飞书配置服务不支持自动创建机器人（支持方式：${(init.supported_auth_methods || []).join(', ') || '未知'}）`);
    }
    const begin = await postRegistration(this.fetchImpl, domain, {
      action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id',
    });
    if (!begin.device_code || !begin.verification_uri_complete) throw new Error('飞书配置服务没有返回扫码会话');
    const qr = new URL(begin.verification_uri_complete);
    qr.searchParams.set('from', 'hermes');
    qr.searchParams.set('tp', 'hermes');
    const id = randomBytes(24).toString('base64url');
    const interval = Math.max(1, Math.min(30, Number(begin.interval) || 5));
    const expiresIn = Math.max(60, Math.min(900, Number(begin.expire_in) || 600));
    const record = {
      id, status: 'waiting', deviceCode: String(begin.device_code), qrUrl: qr.href,
      userCode: String(begin.user_code || ''), domain, interval,
      expiresAt: this.now() + expiresIn * 1000, nextPollAt: 0,
      credentials: null, openId: '', botName: '', botOpenId: '', error: '',
    };
    this.sessions.set(id, record);
    return publicSession(record);
  }

  async poll(id) {
    const record = this.require(id);
    if (record.status !== 'waiting') return publicSession(record);
    if (this.now() >= record.expiresAt) {
      record.status = 'expired'; record.error = '二维码已过期，请重新开始';
      return publicSession(record);
    }
    if (this.now() < record.nextPollAt) return publicSession(record);
    record.nextPollAt = this.now() + record.interval * 1000;
    const result = await postRegistration(this.fetchImpl, record.domain, {
      action: 'poll', device_code: record.deviceCode, tp: 'ob_app',
    });
    const userInfo = result.user_info || {};
    if (userInfo.tenant_brand === 'lark') record.domain = 'lark';
    if (result.client_id && result.client_secret) {
      record.credentials = {
        app_id: String(result.client_id), app_secret: String(result.client_secret), domain: record.domain,
      };
      record.openId = String(userInfo.open_id || '');
      const bot = await probeBot(this.fetchImpl, record.credentials);
      record.botName = bot.bot_name || '';
      record.botOpenId = bot.bot_open_id || '';
      record.status = 'ready';
      return publicSession(record);
    }
    if (result.error === 'access_denied') {
      record.status = 'cancelled'; record.error = '你已在飞书中取消授权';
    } else if (result.error === 'expired_token') {
      record.status = 'expired'; record.error = '二维码已过期，请重新开始';
    } else if (result.error === 'slow_down') {
      record.interval = Math.min(30, record.interval + 2);
    }
    return publicSession(record);
  }

  credentials(id) {
    const record = this.require(id);
    if (record.status !== 'ready' || !record.credentials) {
      throw Object.assign(new Error('请先完成飞书扫码授权'), { statusCode: 409 });
    }
    return { ...record.credentials, open_id: record.openId, bot_name: record.botName, bot_open_id: record.botOpenId };
  }

  consume(id) {
    const record = this.require(id);
    record.credentials = null;
    record.status = 'applied';
    record.consumedAt = this.now();
  }

  cancel(id) {
    return this.sessions.delete(id);
  }
}

