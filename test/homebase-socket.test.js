// Feature-10 SID-006 slice 3: Home Base on its own socket, where only nginx connects. Once the cutover the
// executor ran says nginx reaches Home Base there, the loopback port stops being Home Base: a local process could
// set X-Forwarded-For on it and be taken for any member. It keeps the health probe and redirects pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { catalog } = require('../src/catalog');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { renderGatewaySite } = require('../src/operations/ingress-layout');
const { NGINX_GATEWAY_CONTENT } = require('../executor/handlers');
const { DOMAIN, PARENT, browser, startServer } = require('./support/household');

const HOMEBASE_ORIGIN = `https://smith-homebase.${DOMAIN}`;

// The gateway on disk, and the executor's record of where the gateway nginx last reloaded reaches Home Base.
function writeGateway({ gateway, applied }, { site = 'socket', reloaded = site } = {}) {
  fs.writeFileSync(gateway, site === 'rolled-back' ? NGINX_GATEWAY_CONTENT : renderGatewaySite({ instance: 'smith', domain: DOMAIN, apps: catalog, homeBase: site }));
  fs.writeFileSync(applied, `${JSON.stringify({ homeBase: reloaded === 'socket' ? 'socket' : 'tcp' })}\n`);
}

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

// adminSocket 'in-root': Home Base listens on homebase.sock in the test's own directory. files: the nginx
// gateway site and the applied record Home Base reads (none yet). The household is cut over, as far as Home Base's jobs know.
async function socketHousehold(t, { adminSocket = '', ...config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, 'homebase.sock');
  const files = { gateway: path.join(dir, 'sovereign-home'), applied: path.join(dir, 'sovereign-ingress-applied.json') };
  const server = await startServer(t, { config: { adminSocket: adminSocket === 'in-root' ? socket : adminSocket, nginxGatewaySite: files.gateway, nginxGatewayApplied: files.applied, gatewayReadIntervalMs: 0, ...config } });
  return { ...server, socket, files };
}

test('passkeys run only on Home Base\'s socket: over TCP a local process could pass as a member', async (t) => {
  const { base, app, socket } = await socketHousehold(t, { adminSocket: 'in-root', passkeysOverTcp: false });
  await until(() => app.socketServer.listening, 'the socket');
  const headers = { 'x-forwarded-for': PARENT, 'x-forwarded-host': `smith-homebase.${DOMAIN}`, origin: `https://smith-homebase.${DOMAIN}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const tcp = await loopback(base, 'POST', '/_sovereign/auth/check/options', headers);
  const viaSocket = await overSocket(socket, 'POST', '/_sovereign/auth/check/options', headers);
  assert.equal(tcp.status, 404, 'not there over TCP, whoever the headers name');
  assert.notEqual(viaSocket.status, 404, 'the same request reaches the passkey service on the socket');
});

test('Home Base answers on its socket as it does on the port, and only the directory decides who connects', async (t) => {
  // The cutover makes the socket's directory (tmpfiles.d, 0750 homebase:www-data); here it already exists.
  const { app, socket } = await socketHousehold(t, { adminSocket: 'in-root' });
  await until(() => app.socketServer.listening, 'the socket');
  assert.equal(fs.statSync(socket).mode & 0o777, 0o666);
  assert.equal((await overSocket(socket, 'GET', '/api/homebase/health')).status, 200);
  const whoami = await overSocket(socket, 'GET', '/api/identity/whoami', { 'x-forwarded-for': PARENT, 'x-forwarded-host': `smith-homebase.${DOMAIN}` });
  assert.equal(whoami.status, 200, JSON.stringify(whoami.body));
});

test('the port stays Home Base until nginx runs a gateway that reaches it on its socket, then only redirects', async (t) => {
  const { base, files, root } = await socketHousehold(t);
  const parent = browser(base, PARENT);
  const served = async (why) => assert.equal((await parent.get('/api/identity/whoami')).status, 200, why);
  const redirected = async (why) => assert.equal((await loopback(base, 'GET', '/api/identity/whoami')).status, 308, why);
  await served('no gateway: the port is Home Base');
  // The jobs may say otherwise (a cutover that put Home Base on its socket), but nginx runs the gateway.
  const store = new SqliteStateStore(path.join(root, 'state.sqlite3'));
  const operations = [{ id: 'install-socket-gateway', type: 'nginx.ensure-socket-gateway', instance: 'smith', domain: DOMAIN, homeBase: 'socket' }];
  const { id } = store.createJob({ kind: 'ingress-cutover', target: 'local-host', status: 'queued', dryRun: false, createdAt: new Date().toISOString(), currentStep: null, planJson: JSON.stringify({ operationPlan: { operations } }) });
  store.updateJob(id, { status: 'completed', finishedAt: new Date(Date.now() + 1000).toISOString() });
  writeGateway(files, { site: 'tcp' });
  await served('a gateway from before SID-006 reaches Home Base on the port');
  writeGateway(files, { site: 'socket', reloaded: 'tcp' });
  await served('the socket gateway is written but nginx has not reloaded it (or refused it)');

  writeGateway(files);
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
  assert.deepEqual(await moved.json(), { error: `Home Base is on its own hostname now, ${HOMEBASE_ORIGIN}/; this port only redirects there.`, code: 'HOME_BASE_MOVED', location: `${HOMEBASE_ORIGIN}/api/admin/unlock` });
  // The installer and updates still find out whether Home Base is up, and learn nothing else.
  const health = await loopback(base, 'GET', '/api/homebase/health');
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(await health.json()).sort(), ['status', 'timestamp']);
  // A path can't send the redirect to another host.
  assert.ok((await loopback(base, 'GET', '//evil.example/x')).headers.get('location').startsWith(`${HOMEBASE_ORIGIN}/`));

  // An app install rewrites the gateway: until its reload, nginx still runs the one it had.
  fs.writeFileSync(files.gateway, renderGatewaySite({ instance: 'smith', domain: DOMAIN, apps: catalog, homeBase: 'socket' }));
  await redirected('a rewrite waiting for its reload (or whose reload failed) keeps the port closed to Home Base');
  // An older executor rewrote the gateway back to the port and reloaded, leaving the record behind.
  fs.writeFileSync(files.gateway, renderGatewaySite({ instance: 'smith', domain: DOMAIN, apps: catalog, homeBase: 'tcp' }));
  await served('redirecting would loop: nginx sends Home Base the port');
  writeGateway(files, { site: 'rolled-back' });
  await served('rolled back to the TCP gateway: Serve reaches Home Base on the port again');
});

test('HOME_BASE_LOOPBACK=off closes the port once Home Base is on its socket, and reopens it on a rollback', async (t) => {
  const { app, base, files } = await socketHousehold(t, { loopback: 'off', loopbackCheckIntervalMs: 20 });
  const port = app.server.address().port;
  assert.equal(app.server.listening, true, 'not on the socket yet: the port is still Home Base');
  writeGateway(files);
  await until(() => !app.server.listening, 'the port to close');
  await assert.rejects(() => fetch(`${base}/api/homebase/health`), 'nothing listens on the port');
  writeGateway(files, { site: 'rolled-back' });
  await until(() => app.server.listening, 'the port to reopen');
  assert.equal(app.server.address().port, port);
  assert.equal((await fetch(`${base}/api/homebase/health`)).status, 200);
});
