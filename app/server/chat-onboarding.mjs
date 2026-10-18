import { randomBytes, createDecipheriv } from 'node:crypto';

// 微信 iLink（核心 gateway/platforms/weixin.py）与 QQ 机器人（核心
// gateway/platforms/qqbot/*）的扫码协议，在 Node 宿主侧做会话化驱动——
// 与 feishu-onboarding.mjs 同构：纯内存会话、不落盘、零新增进程。
// 协议常量与核心保持一致，行为仍由核心适配器负责实际收发消息。

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const EP_GET_BOT_QR = 'ilink/bot/get_bot_qrcode';
const EP_GET_QR_STATUS = 'ilink/bot/get_qrcode_status';
const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0); // 与核心一致
const WEIXIN_QR_TTL_MS = 480_000;

const QQ_PORTAL_HOST = 'q.qq.com';
const QQ_CREATE_PATH = '/lite/create_bind_task';
const QQ_POLL_PATH = '/lite/poll_bind_result';
const QQ_QR_URL = (taskId) => `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2&source=hermes`;
const QQ_VERSION = '1.1.0';
const QQ_TTL_MS = 300_000;
const QQ_STATUS = { NONE: 0, PENDING: 1, COMPLETED: 2, EXPIRED: 3 };

function iLinkHeaders() {
  return { 'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION, Accept: 'application/json' };
}

function qqHeaders() {
  // q.qq.com 要求 Accept: application/json + 特定 UA，否则返回反爬 JS 页。
  const ua = `QQBotAdapter/${QQ_VERSION} (Node/${process.versions.node}; ${process.platform}; Hermes/app)`;
  return { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': ua };
}

export function decryptQqSecret(encryptedBase64, keyBase64) {
  // base64( IV(12) ‖ AES-256-GCM ciphertext ‖ tag(16) ) → UTF-8 明文
  // 用标准 setAuthTag（tag 与密文分离传入），跨 Node/OpenSSL 版本最稳。
  const raw = Buffer.from(encryptedBase64, 'base64');
  const key = Buffer.from(keyBase64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function publicSession(record) {
  return {
    pairing_id: record.id,
    platform: record.platform,
    status: record.status,
    qr_payload: record.qrPayload || null,
    poll_after_ms: Math.max(1500, record.interval * 1000),
    user_openid: record.userOpenId || null,
    expires_at: new Date(record.expiresAt).toISOString(),
    error: record.error || null,
  };
}

export class ChatOnboarding {
  constructor({ fetchImpl = fetch, now = () => Date.now(), keyGen = () => randomBytes(32).toString('base64') } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.keyGen = keyGen;
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
    if (!record) throw Object.assign(new Error('扫码会话不存在或已过期，请重新开始'), { statusCode: 404 });
    return record;
  }

  async start(platform) {
    this.prune();
    if (platform === 'weixin') return this.startWeixin();
    if (platform === 'qqbot') return this.startQqbot();
    throw new Error(`不支持的扫码平台：${platform}`);
  }

  async startWeixin() {
    const response = await this.fetchImpl(`${ILINK_BASE_URL}/${EP_GET_BOT_QR}?bot_type=3`, {
      headers: iLinkHeaders(),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`微信 iLink 配置服务返回了无法解析的响应 (${response.status})`); }
    if (!response.ok && !data.error) throw new Error(`微信 iLink 配置服务请求失败 (${response.status})`);
    const qrcodeValue = String(data.qrcode || '');
    const qrLiteAppUrl = String(data.qrcode_img_content || '');
    if (!qrcodeValue) throw new Error('iLink 没有返回二维码，请确认 NAS 可以访问 ilinkai.weixin.qq.com');
    const id = randomBytes(24).toString('base64url');
    const record = {
      id, platform: 'weixin', status: 'waiting', interval: 2,
      // 微信必须扫 liteapp URL（qrcode_img_content），不是裸 hex token（与核心 _print_qr 一致）
      qrPayload: qrLiteAppUrl || qrcodeValue, qrcodeValue, baseUrl: ILINK_BASE_URL,
      credentials: null, userOpenId: '', error: '',
      expiresAt: this.now() + WEIXIN_QR_TTL_MS, nextPollAt: 0,
    };
    this.sessions.set(id, record);
    return publicSession(record);
  }

  async startQqbot() {
    const key = this.keyGen();
    const response = await this.fetchImpl(`https://${QQ_PORTAL_HOST}${QQ_CREATE_PATH}`, {
      method: 'POST', headers: qqHeaders(),
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`QQ 绑定服务返回了无法解析的响应 (${response.status})`); }
    if (data.retcode !== 0) throw new Error(String(data.msg || `QQ 绑定服务请求失败 (${response.status})`));
    const taskId = String((data.data || {}).task_id || '');
    if (!taskId) throw new Error('创建 QQ 绑定任务失败：缺少 task_id');
    const id = randomBytes(24).toString('base64url');
    const record = {
      id, platform: 'qqbot', status: 'waiting', interval: 2,
      qrPayload: QQ_QR_URL(taskId), taskId, aesKey: key,
      credentials: null, userOpenId: '', error: '',
      expiresAt: this.now() + QQ_TTL_MS, nextPollAt: 0,
    };
    this.sessions.set(id, record);
    return publicSession(record);
  }

  async poll(id) {
    const record = this.require(id);
    if (record.status !== 'waiting') return publicSession(record);
    if (this.now() >= record.expiresAt) {
      record.status = 'expired';
      record.error = '二维码已过期，请重新开始';
      return publicSession(record);
    }
    if (this.now() < record.nextPollAt) return publicSession(record);
    record.nextPollAt = this.now() + record.interval * 1000;

    if (record.platform === 'weixin') await this.pollWeixin(record);
    else await this.pollQqbot(record);
    return publicSession(record);
  }

  async pollWeixin(record) {
    let data;
    try {
      const response = await this.fetchImpl(
        `${record.baseUrl.replace(/\/$/, '')}/${EP_GET_QR_STATUS}?qrcode=${encodeURIComponent(record.qrcodeValue)}`,
        { headers: iLinkHeaders(), signal: AbortSignal.timeout(35_000) },
      );
      const text = await response.text();
      try { data = text ? JSON.parse(text) : {}; }
      catch { return; } // 瞬态解析错误：保持 waiting，下次轮询重试
      if (!response.ok) { record.status = 'error'; record.error = `iLink 状态查询失败 (${response.status})`; return; }
    } catch { return; }
    const status = String(data.status || 'wait');
    if (status === 'confirmed') {
      const account_id = String(data.ilink_bot_id || '');
      const token = String(data.bot_token || '');
      if (!account_id || !token) {
        record.status = 'error'; record.error = 'iLink 确认成功但凭据不完整，请重新扫码';
      } else {
        record.credentials = {
          account_id, token,
          base_url: String(data.baseurl || record.baseUrl),
          user_id: String(data.ilink_user_id || ''),
        };
        record.userOpenId = record.credentials.user_id;
        record.status = 'ready';
      }
    } else if (status === 'scaned_but_redirect' && data.redirect_host) {
      record.baseUrl = `https://${data.redirect_host}`;
    } else if (status === 'expired') {
      record.status = 'expired'; record.error = '二维码已过期，请重新开始';
    }
    // wait / scaned / scaned_but_redirect：继续 waiting
  }

  async pollQqbot(record) {
    let data;
    try {
      const response = await this.fetchImpl(`https://${QQ_PORTAL_HOST}${QQ_POLL_PATH}`, {
        method: 'POST', headers: qqHeaders(),
        body: JSON.stringify({ task_id: record.taskId }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      try { data = text ? JSON.parse(text) : {}; }
      catch { return; }
      if (data.retcode !== 0) { record.status = 'error'; record.error = String(data.msg || 'QQ 绑定轮询失败'); return; }
    } catch { return; }
    const d = data.data || {};
    const status = Number(d.status ?? QQ_STATUS.NONE);
    if (status === QQ_STATUS.COMPLETED) {
      const app_id = String(d.bot_appid || '');
      if (!app_id || !d.bot_encrypt_secret) {
        record.status = 'error'; record.error = 'QQ 绑定完成但凭据不完整，请重新扫码';
      } else {
        let client_secret;
        try {
          client_secret = decryptQqSecret(String(d.bot_encrypt_secret), record.aesKey);
        } catch {
          record.status = 'error'; record.error = 'QQ 凭据解密失败（绑定密钥不匹配），请重新开始扫码';
          return;
        }
        record.credentials = { app_id, client_secret, user_openid: String(d.user_openid || '') };
        record.userOpenId = record.credentials.user_openid;
        record.status = 'ready';
      }
    } else if (status === QQ_STATUS.EXPIRED) {
      record.status = 'expired'; record.error = '二维码已过期，请重新开始';
    }
    // NONE / PENDING：继续 waiting
  }

  credentials(id) {
    const record = this.require(id);
    if (record.status !== 'ready' || !record.credentials) {
      throw Object.assign(new Error('请先完成扫码授权'), { statusCode: 409 });
    }
    return { ...record.credentials, user_openid: record.userOpenId || '' };
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
