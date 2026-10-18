import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuOnboarding } from '../app/server/feishu-onboarding.mjs';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

test('Feishu onboarding mirrors the Hermes device-code flow without exposing the secret', async () => {
  let now = 1_000;
  const calls = [];
  const replies = [
    jsonResponse({ supported_auth_methods: ['client_secret'] }),
    jsonResponse({ device_code: 'device-1', verification_uri_complete: 'https://accounts.feishu.cn/device', user_code: 'ABCD', interval: 1, expire_in: 600 }),
    jsonResponse({ error: 'authorization_pending' }, 400),
    jsonResponse({ client_id: 'cli_created', client_secret: 'secret-value', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' } }),
    jsonResponse({ tenant_access_token: 'tenant-token' }),
    jsonResponse({ code: 0, bot: { app_name: 'Hermes Bot', open_id: 'ou_bot' } }),
  ];
  const flow = new FeishuOnboarding({ now: () => now, fetchImpl: async (url, options = {}) => {
    calls.push({ url: String(url), body: String(options.body || '') });
    return replies.shift();
  } });

  const started = await flow.start({ domain: 'feishu' });
  assert.equal(started.status, 'waiting');
  assert.match(started.qr_payload, /from=hermes/);
  assert.equal('device_code' in started, false);
  assert.equal(JSON.stringify(started).includes('secret-value'), false);

  let polled = await flow.poll(started.pairing_id);
  assert.equal(polled.status, 'waiting');
  now += 1_100;
  polled = await flow.poll(started.pairing_id);
  assert.equal(polled.status, 'ready');
  assert.equal(polled.bot_name, 'Hermes Bot');
  assert.equal(JSON.stringify(polled).includes('secret-value'), false);

  assert.deepEqual(flow.credentials(started.pairing_id), {
    app_id: 'cli_created', app_secret: 'secret-value', domain: 'feishu',
    open_id: 'ou_owner', bot_name: 'Hermes Bot', bot_open_id: 'ou_bot',
  });
  assert.match(calls[1].body, /archetype=PersonalAgent/);
  assert.match(calls[2].body, /action=poll/);
});

test('Feishu onboarding switches to the Lark account service after tenant detection', async () => {
  let now = 5_000;
  const urls = [];
  const replies = [
    jsonResponse({ supported_auth_methods: ['client_secret'] }),
    jsonResponse({ device_code: 'device-2', verification_uri_complete: 'https://accounts.feishu.cn/device', interval: 1, expire_in: 600 }),
    jsonResponse({ error: 'authorization_pending', user_info: { tenant_brand: 'lark' } }, 400),
    jsonResponse({ error: 'access_denied' }, 400),
  ];
  const flow = new FeishuOnboarding({ now: () => now, fetchImpl: async url => {
    urls.push(String(url)); return replies.shift();
  } });
  const started = await flow.start();
  assert.equal((await flow.poll(started.pairing_id)).domain, 'lark');
  now += 1_100;
  const denied = await flow.poll(started.pairing_id);
  assert.equal(denied.status, 'cancelled');
  assert.match(urls.at(-1), /accounts\.larksuite\.com/);
});

