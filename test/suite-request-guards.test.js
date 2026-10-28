const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const { createSuiteRequestGuard } = require('../src/request-guard');

const HOMEBASE = 'smith-homebase.example-tailnet.ts.net';
const PULSE = 'smith-pulse.example-tailnet.ts.net';
const SIBLING = 'https://smith-home.example-tailnet.ts.net';

async function startServer(requestGuards) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-guards-'));
  const app = createApp({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: path.join(tempDir, 'apps'),
    baseBackupDir: path.join(tempDir, 'backups'),
    baseConfigDir: path.join(tempDir, 'config'),
    identitySocket: '',
    requestGuards,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return {
    url,
    close: () => new Promise((resolve) => app.server.close(resolve)),
  };
}

// What Serve and nginx forward for a member's browser on a hostname, plus the browser's own headers.
const via = (host, headers = {}) => ({ 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.5', ...headers });
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const json = (host) => ({ ...SAME_ORIGIN, origin: `https://${host}`, 'content-type': 'application/json' });

// node:http, not fetch: fetch replaces Sec-Fetch-Mode with its own, so it can't send a navigation.
function call(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, payload });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('enforce: Home Base admin refuses everything but its own pages and top-level navigations', async (t) => {
  const server = await startServer('enforce');
  t.after(() => server.close());
  const health = (headers) => call(server.url, '/api/homebase/health', { headers });

  assert.equal((await health({})).status, 200, 'straight to loopback (the installer\'s probe) is not a browser through Serve');
  assert.equal((await health(via(HOMEBASE, SAME_ORIGIN))).status, 200);
  assert.equal((await call(server.url, '/', { headers: via(HOMEBASE, { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }) })).status, 200, 'a sibling\'s link opens Home Base');

  for (const [name, headers, reason] of [
    ['no fetch metadata', {}, 'fetch_metadata_missing'],
    ['malformed fetch metadata', { 'sec-fetch-site': 'Same-Origin' }, 'fetch_metadata_malformed'],
    ['sibling fetch', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: SIBLING }, 'not_same_origin'],
    ['sibling image', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }, 'not_same_origin'],
    ['sibling script', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' }, 'not_same_origin'],
    ['sibling iframe', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, 'not_same_origin'],
  ]) {
    const res = await health(via(HOMEBASE, headers));
    assert.equal(res.status, 403, name);
    assert.equal(res.payload.error, 'request_refused', name);
    assert.equal(res.payload.reason, reason, name);
  }
});

test('enforce: a mutation must come from the hostname it arrived on, and a refused one changes nothing', async (t) => {
  const server = await startServer('enforce');
  t.after(() => server.close());
  const setup = (headers) => call(server.url, '/api/admin/setup', { method: 'POST', headers, body: JSON.stringify({ passphrase: 'test-admin-passphrase' }) });

  for (const [name, headers, reason] of [
    ['sibling form post', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', origin: SIBLING, 'content-type': 'text/plain' }, 'not_same_origin'],
    ['same-origin but another hostname\'s Origin', { ...json(HOMEBASE), origin: `https://${PULSE}` }, 'origin_mismatch'],
    ['no Origin', { ...json(HOMEBASE), origin: '' }, 'origin_missing'],
  ]) {
    const res = await setup(via(HOMEBASE, headers));
    assert.equal(res.status, 403, name);
    assert.equal(res.payload.reason, reason, name);
  }
  // The passkey mount on a sensitive app's hostname reaches Home Base too, with that hostname's origin.
  assert.equal((await setup(via(PULSE, json(HOMEBASE)))).payload.reason, 'origin_mismatch');
  // Serve may name the default port; the origin doesn't.
  const created = await setup(via(`${HOMEBASE}:443`, json(HOMEBASE)));
  assert.equal(created.status, 200, 'the first accepted setup is the one that sets the passphrase');
});

test('enforce: a forwarded host that is not a hostname is refused', async (t) => {
  const server = await startServer('enforce');
  t.after(() => server.close());
  const res = await call(server.url, '/api/homebase/health', { headers: via('evil.example/path', SAME_ORIGIN) });
  assert.equal(res.status, 400);
  assert.equal(res.payload.reason, 'forwarded_host');
});

test('off (the default) and report change no answer', async (t) => {
  for (const mode of [undefined, 'off', 'report']) {
    const server = await startServer(mode);
    t.after(() => server.close());
    assert.equal((await call(server.url, '/api/homebase/health', { headers: via(HOMEBASE) })).status, 200, String(mode));
  }
});

test('report logs what enforce would refuse, once per request, without the query', () => {
  const logs = [];
  const guard = createSuiteRequestGuard({ mode: 'report', log: (line) => logs.push(line) });
  const res = { writeHead: () => assert.fail('report never answers'), end: () => assert.fail('report never answers') };
  assert.equal(guard({ method: 'GET', url: '/api/apps/health?refresh=1', headers: via(HOMEBASE) }, res), true);
  assert.equal(guard({ method: 'GET', url: '/', headers: via('bad host') }, res), true);
  assert.equal(guard({ method: 'GET', url: '/', headers: {} }, res), true);
  assert.deepEqual(logs, [
    '[sovereign-auth] would refuse GET /api/apps/health: fetch_metadata_missing (origin -, sec-fetch-site -)',
    '[homebase] would refuse GET /: forwarded host is not a hostname',
  ]);
});

test('an unknown mode stops Home Base from starting', () => {
  assert.throws(() => createSuiteRequestGuard({ mode: 'on' }), /off, report or enforce/);
  assert.throws(() => createApp({ stateDbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-guards-')), 's.sqlite3'), requestGuards: 'enforcing' }), /HOME_BASE_REQUEST_GUARDS/);
});
