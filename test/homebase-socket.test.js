// Feature-10 SID-006 slice 3: Home Base on its own socket, where only nginx connects. Once the cutover the
// executor ran says nginx reaches Home Base there, the loopback port stops being Home Base: a local process could
// set X-Forwarded-For on it and be taken for any member. It keeps the health probe and redirects pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { DOMAIN, PARENT, browser, startServer } = require('./support/household');

const HOMEBASE_ORIGIN = `https://smith-homebase.${DOMAIN}`;

// A finished ingress job, as the job runner records it once the executor has run the plan.
function recordIngress(root, kind, operations = []) {
  const store = new SqliteStateStore(path.join(root, 'state.sqlite3'));
  const planJson = JSON.stringify({ action: { action: kind }, operationPlan: { kind, operations } });
  const { id } = store.createJob({ kind, target: 'local-host', status: 'queued', dryRun: false, createdAt: new Date().toISOString(), currentStep: null, planJson });
  store.updateJob(id, { status: 'completed', finishedAt: new Date(Date.now() + id).toISOString() });
}
const socketCutover = (root) => recordIngress(root, 'ingress-cutover', [{ id: 'install-socket-gateway', type: 'nginx.ensure-socket-gateway', instance: 'smith', domain: DOMAIN, homeBase: 'socket' }]);
const olderCutover = (root) => recordIngress(root, 'ingress-cutover', [{ id: 'install-socket-gateway', type: 'nginx.ensure-socket-gateway', instance: 'smith', domain: DOMAIN }]);
const rollback = (root) => recordIngress(root, 'ingress-rollback');

// What nginx sends on the socket: the member's tailnet address and hostname, from Serve.
function overSocket(socketPath, method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: url, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function until(condition, what) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const loopback = (base, method, url, headers = {}) => fetch(`${base}${url}`, { method, redirect: 'manual', headers: { 'x-forwarded-for': PARENT, 'x-forwarded-host': `smith-homebase.${DOMAIN}`, ...headers } });

// adminSocket 'in-root': Home Base listens on homebase.sock in the test's own directory.
async function socketHousehold(t, { adminSocket = '', ...config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, 'homebase.sock');
  const server = await startServer(t, { cutOver: false, config: { adminSocket: adminSocket === 'in-root' ? socket : adminSocket, ...config } });
  return { ...server, socket };
}

test('Home Base answers on its socket as it does on the port, and only the directory decides who connects', async (t) => {
  // The cutover makes the socket's directory (tmpfiles.d, 0750 homebase:www-data); here it already exists.
  const { app, socket } = await socketHousehold(t, { adminSocket: 'in-root' });
  await until(() => app.socketServer.listening, 'the socket');
  assert.equal(fs.statSync(socket).mode & 0o777, 0o666);
  assert.equal((await overSocket(socket, 'GET', '/api/homebase/health')).status, 200);
  const whoami = await overSocket(socket, 'GET', '/api/identity/whoami', { 'x-forwarded-for': PARENT, 'x-forwarded-host': `smith-homebase.${DOMAIN}` });
  assert.equal(whoami.status, 200, JSON.stringify(whoami.body));
});

test('the port stays Home Base until the cutover the executor ran puts it on its socket, then only redirects', async (t) => {
  const { base, root } = await socketHousehold(t);
  const parent = browser(base, PARENT);
  assert.equal((await parent.get('/api/identity/whoami')).status, 200, 'no cutover: the port is Home Base');
  olderCutover(root);
  assert.equal((await parent.get('/api/identity/whoami')).status, 200, 'a cutover from before SID-006 left nginx on the port');

  socketCutover(root);
  const page = await loopback(base, 'GET', '/apps?tab=updates');
  assert.equal(page.status, 308);
  assert.equal(page.headers.get('location'), `${HOMEBASE_ORIGIN}/apps?tab=updates`);
  assert.equal((await loopback(base, 'HEAD', '/admin')).headers.get('location'), `${HOMEBASE_ORIGIN}/admin`);
  // A forged caller gets no identity and no data: whoami and the API redirect like any page.
  const forged = await loopback(base, 'GET', '/api/identity/whoami');
  assert.equal(forged.status, 308);
  assert.equal(await forged.text(), '');
  const moved = await loopback(base, 'POST', '/api/admin/unlock', { 'content-type': 'application/json' });
  assert.equal(moved.status, 421);
  assert.deepEqual(await moved.json(), { error: `Home Base is at ${HOMEBASE_ORIGIN}/ now; this port only redirects there.`, code: 'HOME_BASE_MOVED', location: `${HOMEBASE_ORIGIN}/api/admin/unlock` });
  // The installer and updates still find out whether Home Base is up, and learn nothing else.
  const health = await loopback(base, 'GET', '/api/homebase/health');
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(await health.json()).sort(), ['status', 'timestamp']);
  // A path can't send the redirect to another host.
  assert.ok((await loopback(base, 'GET', '//evil.example/x')).headers.get('location').startsWith(`${HOMEBASE_ORIGIN}/`));

  rollback(root);
  assert.equal((await parent.get('/api/identity/whoami')).status, 200, 'rolled back: Serve reaches Home Base on the port again');
});

test('HOME_BASE_LOOPBACK=off closes the port once Home Base is on its socket, and reopens it on a rollback', async (t) => {
  const { app, base, root } = await socketHousehold(t, { loopback: 'off', loopbackCheckIntervalMs: 20 });
  const port = app.server.address().port;
  assert.equal(app.server.listening, true, 'not on the socket yet: the port is still Home Base');
  socketCutover(root);
  await until(() => !app.server.listening, 'the port to close');
  await assert.rejects(() => fetch(`${base}/api/homebase/health`), 'nothing listens on the port');
  rollback(root);
  await until(() => app.server.listening, 'the port to reopen');
  assert.equal(app.server.address().port, port);
  assert.equal((await fetch(`${base}/api/homebase/health`)).status, 200);
});
