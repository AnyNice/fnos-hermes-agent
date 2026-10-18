import assert from 'node:assert/strict';
import test from 'node:test';
import { checkOfficialCoreRelease, parseCoreVersion } from '../app/server/core-release.js';

function release(tag, name = '') {
  return async () => new Response(JSON.stringify({ tag_name: tag, name, html_url: 'https://github.com/NousResearch/hermes-agent/releases/tag/' + tag }));
}

test('compares actual official releases instead of returning the installed version', async () => {
  const result = await checkOfficialCoreRelease('v0.22.1 (2026.10.14)', release('v0.22.2'));
  assert.equal(result.latest, 'v0.22.2');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.updateMechanism, 'external');
  assert.equal((await checkOfficialCoreRelease('0.22.2', release('v0.22.2'))).updateAvailable, false);
  assert.equal((await checkOfficialCoreRelease('0.23.0', release('v0.22.2'))).updateAvailable, false);
});

test('supports historical date tags through the release name', async () => {
  const result = await checkOfficialCoreRelease('0.20.0', release('v2026.9.24', 'Hermes Agent v0.22.0'));
  assert.equal(result.latest, 'v0.22.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(parseCoreVersion('v2026.9.24'), null);
});

test('reports network and invalid-release failures without claiming to be current', async () => {
  await assert.rejects(checkOfficialCoreRelease('0.22.2', async () => new Response('', { status: 403 })), /403/);
  await assert.rejects(checkOfficialCoreRelease('0.22.2', release('v0.23.0-rc1')), /稳定版/);
});
