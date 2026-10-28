const test = require('node:test');
const assert = require('node:assert/strict');
const { appLayout } = require('../src/operations/app-layout');
const { getAppById } = require('../src/catalog');
const { renderAppLocations } = require('../src/operations/ingress-layout');
const { createBaseHandlers, renderManagedFile, renderAppEnvFile } = require('../executor/handlers');
const { createLifecycleHandlers } = require('../executor/lifecycle-handlers');
const { buildAppInstallPlan } = require('../src/operations/compilers/install');
const { buildAppMoveUserPlan } = require('../src/operations/compilers/lifecycle');
const { validateOperationPolicy } = require('../src/operations/policy');
const { createFakeFs } = require('./fixtures/fake-fs');
const { SHARED_IDENTITY, ownIdentity, users } = require('./fixtures/users');

const SITE = { hostname: 'homebase', domain: 'tailnet', householdTimezone: 'America/New_York' };
const op = (type, fields = {}) => ({ id: 'op', type, title: 't', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields });

// No catalog app declares a socket until its own release supports SOVEREIGN_LISTEN; these tests switch
// one on for the duration (the policy reads the catalog itself).
function withSocket(appId, fn) {
  const app = getAppById(appId);
  const previous = app.runtime.listen;
  app.runtime.listen = 'unix';
  try { return fn(appLayout(app)); } finally { if (previous === undefined) delete app.runtime.listen; else app.runtime.listen = previous; }
}
async function withSocketAsync(appId, fn) {
  const app = getAppById(appId);
  const previous = app.runtime.listen;
  app.runtime.listen = 'unix';
  try { return await fn(appLayout(app)); } finally { if (previous === undefined) delete app.runtime.listen; else app.runtime.listen = previous; }
}

test('nginx keeps each app\'s URI behavior over the socket: prefix-stripping and mount-preserving', () => {
  withSocket('family-pulse', (pulse) => {
    assert.deepEqual(pulse.listen, { kind: 'unix', directory: '/run/sovereign-apps/family-pulse', socket: '/run/sovereign-apps/family-pulse/app.sock', tmpfiles: '/etc/tmpfiles.d/sovereign-app-family-pulse.conf' });
    assert.match(renderAppLocations(pulse), /proxy_pass http:\/\/unix:\/run\/sovereign-apps\/family-pulse\/app\.sock:\/;/);
  });
  withSocket('helm', (helm) => {
    assert.match(renderAppLocations(helm), /proxy_pass http:\/\/unix:\/run\/sovereign-apps\/helm\/app\.sock;/);
    assert.doesNotMatch(renderAppLocations(helm), /app\.sock:\//, 'mount-preserving: no URI, so /helm/... passes through');
  });
  const tcp = appLayout(getAppById('family-dinner'));
  assert.deepEqual(tcp.listen, { kind: 'tcp' });
  assert.match(renderAppLocations(tcp), /proxy_pass http:\/\/127\.0\.0\.1:3000\/;/);
});

test('the .env says where to listen: the socket, or loopback for apps that do not support one yet', () => {
  const password = 'Pass-word-1234';
  const env = (layout) => renderAppEnvFile({ layout, password, site: SITE });
  assert.match(env(appLayout(getAppById('family-dinner'))), /^HOST=127\.0\.0\.1$/m);
  assert.doesNotMatch(env(appLayout(getAppById('family-dinner'))), /SOVEREIGN_LISTEN/);
  withSocket('family-pulse', (pulse) => {
    const text = env(pulse);
    assert.match(text, /^SOVEREIGN_LISTEN=unix:\/run\/sovereign-apps\/family-pulse\/app\.sock$/m);
    assert.doesNotMatch(text, /^HOST=/m);
  });
  // An operator's HOST=0.0.0.0 never survives a reinstall.
  assert.match(renderAppEnvFile({ layout: appLayout(getAppById('family-dinner')), password, site: SITE, existingContent: 'HOST=0.0.0.0\n' }), /^HOST=127\.0\.0\.1$/m);
  // Switching modes drops the other mode's key: a TCP app keeping SOVEREIGN_LISTEN would stay on the
  // socket while nginx points at its port.
  withSocket('family-pulse', (pulse) => {
    assert.doesNotMatch(renderAppEnvFile({ layout: pulse, password, site: SITE, existingContent: 'HOST=127.0.0.1\n' }), /^HOST=/m, 'TCP to socket');
  });
  const tcpPulse = { ...appLayout(getAppById('family-pulse')), listen: { kind: 'tcp' } };
  const back = renderAppEnvFile({ layout: tcpPulse, password, site: SITE, existingContent: 'SOVEREIGN_LISTEN=unix:/run/sovereign-apps/family-pulse/app.sock\n' });
  assert.doesNotMatch(back, /SOVEREIGN_LISTEN/, 'socket to TCP');
  assert.match(back, /^HOST=127\.0\.0\.1$/m);
});

test('the socket directory: owned by the app user, nginx\'s group, 2750, recreated at boot; checked after systemd-tmpfiles', async () => {
  await withSocketAsync('family-pulse', async (pulse) => {
    const file = renderManagedFile(op('filesystem.write-managed-file', { purpose: 'app-tmpfiles', template: 'app-tmpfiles-v1' }), { layout: pulse, identity: ownIdentity('sovereign-pulse', 'family-pulse') });
    assert.equal(file.path, '/etc/tmpfiles.d/sovereign-app-family-pulse.conf');
    assert.equal(file.content, 'd /run/sovereign-apps 0755 root root -\nd /run/sovereign-apps/family-pulse 2750 sovereign-pulse www-data -\n');
    const calls = [];
    const made = { kind: 'dir', uid: 1101, gid: 33, mode: 0o42750 };
    const fsImpl = createFakeFs({ '/etc/group': 'www-data:x:33:\n' });
    const handlers = createBaseHandlers({ fsImpl, lookupUser: users(), run: async (input) => { calls.push(input); fsImpl.entries.set('/run/sovereign-apps/family-pulse', { ...made }); return { stdout: '' }; } });
    assert.match(await handlers['systemd.apply-tmpfiles'](op('systemd.apply-tmpfiles'), { layout: pulse }), /sovereign-pulse:www-data 2750/);
    assert.deepEqual([calls[0].binary, calls[0].args, calls[0].uid], ['/usr/bin/systemd-tmpfiles', ['--create', '/etc/tmpfiles.d/sovereign-app-family-pulse.conf'], 0]);
    for (const wrong of [{ ...made, gid: 1101 }, { ...made, uid: 1001 }, { ...made, mode: 0o40755 }, { kind: 'link', target: '/root', uid: 1101, gid: 33, mode: 0o777 }]) {
      const bad = createBaseHandlers({ fsImpl, lookupUser: users(), run: async () => { fsImpl.entries.set('/run/sovereign-apps/family-pulse', wrong); return { stdout: '' }; } });
      await assert.rejects(() => bad['systemd.apply-tmpfiles'](op('systemd.apply-tmpfiles'), { layout: pulse }), /is not sovereign-pulse:www-data 2750/);
    }
  });
  assert.throws(() => renderManagedFile(op('filesystem.write-managed-file', { purpose: 'app-tmpfiles', template: 'app-tmpfiles-v1' }), { layout: appLayout(getAppById('family-dinner')), identity: SHARED_IDENTITY }), (error) => error.code === 'POLICY_DENIED');
  await assert.rejects(() => createBaseHandlers({ lookupUser: users() })['systemd.apply-tmpfiles'](op('systemd.apply-tmpfiles'), { layout: appLayout(getAppById('family-dinner')) }), /does not listen on a socket/);
});

test('install and move plans create the socket directory before the app starts; tcp apps may not', () => {
  withSocket('family-pulse', () => {
    const ids = buildAppInstallPlan({ appId: 'family-pulse' }).operations.map((operation) => operation.id);
    assert.ok(ids.indexOf('ensure-socket-directory') > ids.indexOf('write-socket-tmpfiles') && ids.indexOf('ensure-socket-directory') < ids.indexOf('start-service'));
    validateOperationPolicy(buildAppInstallPlan({ appId: 'family-pulse' }));
    const move = buildAppMoveUserPlan({ appId: 'family-pulse', site: SITE });
    const moveIds = move.operations.map((operation) => operation.id);
    assert.ok(moveIds.indexOf('reown-app') < moveIds.indexOf('ensure-socket-directory') && moveIds.indexOf('ensure-socket-directory') < moveIds.indexOf('start-service'));
    validateOperationPolicy(move);
  });
  const dinner = JSON.parse(JSON.stringify(buildAppInstallPlan({ appId: 'family-dinner' })));
  assert.equal(dinner.operations.some((operation) => operation.type === 'systemd.apply-tmpfiles'), false);
  // A well-formed step a tcp app's plan was never compiled with: policy refuses it.
  const sneak = JSON.parse(JSON.stringify(dinner));
  const reload = sneak.operations.find((operation) => operation.type === 'systemd.daemon-reload');
  sneak.operations.splice(sneak.operations.indexOf(reload) + 1, 0, { ...reload, id: 'sneak', type: 'systemd.apply-tmpfiles', dependsOn: [reload.id] });
  assert.throws(() => validateOperationPolicy(sneak), /does not listen on a socket/);
});

test('uninstall removes the socket directory entry and the directory itself', async () => {
  await withSocketAsync('family-pulse', async (pulse) => {
    const fsImpl = createFakeFs({
      '/etc/tmpfiles.d/sovereign-app-family-pulse.conf': 'd ...\n',
      '/run/sovereign-apps/family-pulse': { kind: 'dir', uid: 1101, gid: 33, mode: 0o42750 },
      '/run/sovereign-apps/family-pulse/app.sock': { kind: 'file', uid: 1101, gid: 33 },
      '/opt/sovereign-home/apps/familyPulse': { kind: 'dir', uid: 1101 },
    });
    const handlers = createLifecycleHandlers({ fsImpl, lookupUser: users(), asUser: (_user, fn) => fn() });
    await handlers['filesystem.remove-app-artifacts'](op('filesystem.remove-app-artifacts', { risk: 'destructive' }), { layout: pulse });
    assert.equal(fsImpl.existsSync('/etc/tmpfiles.d/sovereign-app-family-pulse.conf'), false);
    assert.equal(fsImpl.existsSync('/run/sovereign-apps/family-pulse'), false);
  });
});

test('the executor probes a socket app at catalog paths only, with bounded replies', async (t) => {
  const http = require('node:http');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createAppProber } = require('../executor/app-probe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sock-'));
  const socket = path.join(dir, 'app.sock');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/api/bootstrap') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ household_initialized: true })); }
    if (req.url === '/api/health') return res.end('ok');
    res.statusCode = 404; return res.end();
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // Point the probe at this test socket instead of /run/sovereign-apps.
  const request = (options, callback) => http.request({ ...options, socketPath: options.socketPath ? socket : undefined }, callback);
  const probeApp = createAppProber({ request, hasSocket: () => true });
  await withSocketAsync('family-pulse', async () => {
    const readiness = await probeApp({ appId: 'family-pulse', probe: 'readiness' });
    assert.deepEqual([readiness.via, readiness.statusCode], ['unix', 200]);
    assert.equal('payload' in readiness, false, 'only onboarding returns a body');
    const onboarding = await probeApp({ appId: 'family-pulse', probe: 'onboarding' });
    assert.deepEqual(onboarding.payload, { household_initialized: true });
  });
  assert.ok(seen.every((url) => ['/api/health', '/api/bootstrap'].includes(url)), 'paths come from the catalog');
  assert.throws(() => probeApp({ appId: 'family-pulse', probe: 'shell' }), /liveness, readiness, or onboarding/);
  const down = await withSocketAsync('family-pulse', () => createAppProber({ hasSocket: () => true, request: (options, callback) => http.request({ ...options, socketPath: path.join(dir, 'missing.sock') }, callback) })({ appId: 'family-pulse', probe: 'readiness' }));
  // Home Base updated but the app not yet: no socket, so the probe asks its loopback port as before SID-002.
  const asked = [];
  const notYet = await withSocketAsync('family-pulse', () => createAppProber({ hasSocket: () => false, request: (options, callback) => { asked.push(options); return http.request({ ...options, host: undefined, port: undefined, socketPath: socket }, callback); } })({ appId: 'family-pulse', probe: 'readiness' }));
  assert.deepEqual([notYet.via, notYet.statusCode], ['tcp-until-updated', 200]);
  assert.deepEqual([asked[0].host, asked[0].port, asked[0].socketPath], ['127.0.0.1', 3003, undefined]);
  assert.deepEqual([down.statusCode, down.error], [null, 'ENOENT']);
});

test('a probe has a deadline for the whole exchange: an app trickling bytes can\'t hold root\'s request open', async (t) => {
  const http = require('node:http');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createAppProber } = require('../executor/app-probe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sock-'));
  const socket = path.join(dir, 'app.sock');
  const timers = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    timers.push(setInterval(() => res.write('.'), 10));
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => { timers.forEach(clearInterval); server.closeAllConnections?.(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const probeApp = createAppProber({ timeoutMs: 100, hasSocket: () => true, request: (options, callback) => http.request({ ...options, socketPath: socket }, callback) });
  const started = Date.now();
  const result = await withSocketAsync('family-pulse', () => probeApp({ appId: 'family-pulse', probe: 'readiness' }));
  assert.deepEqual([result.statusCode, result.error], [null, 'deadline'], 'never reported as an answer');
  assert.ok(Date.now() - started < 1000);
});

test('readiness and health for a socket app go through the executor', async () => {
  const { waitForAppReadiness } = require('../src/services/job-runner');
  const { HealthMonitor } = require('../src/services/health-monitor');
  await withSocketAsync('family-pulse', async () => {
    const app = getAppById('family-pulse');
    let asked = 0;
    await waitForAppReadiness({ app, attempts: 3, delayMs: 1, probeStatus: async () => { asked += 1; return asked < 2 ? null : 200; }, fetchImpl: async () => { throw new Error('never on loopback'); } });
    assert.equal(asked, 2);
    await assert.rejects(() => waitForAppReadiness({ app, attempts: 2, delayMs: 1, probeStatus: async () => 503 }), /readiness returned HTTP 503/);

    const probes = [];
    const monitor = new HealthMonitor({
      catalogById: new Map([[app.id, app]]),
      probeServiceState: () => ({ state: 'active', ok: true, message: 'Service active' }),
      probeUnits: () => new Map(),
      probeHttp: async () => { throw new Error('never on loopback'); },
      probeHttpJson: async () => { throw new Error('never on loopback'); },
      probeApp: async (appId, probe) => { probes.push([appId, probe]); return probe === 'onboarding' ? { statusCode: 200, payload: { household_initialized: true } } : { statusCode: 200 }; },
    });
    const snapshot = await monitor.getAppHealthSnapshot([{ appId: app.id, status: 'installed', serviceName: 'family-pulse', port: 3003, externalUrl: 'https://x/pulse/' }], { force: true });
    assert.deepEqual(probes.map(([, probe]) => probe), ['liveness', 'readiness', 'onboarding']);
    assert.equal(snapshot.byAppId['family-pulse'].readiness.ok, true);
    const silent = new HealthMonitor({ catalogById: new Map([[app.id, app]]), probeServiceState: () => ({ state: 'active', ok: true }), probeUnits: () => new Map(), probeApp: async () => ({ statusCode: null, error: 'ECONNREFUSED' }) });
    const failing = await silent.getAppHealthSnapshot([{ appId: app.id, status: 'installed', serviceName: 'family-pulse', port: 3003 }], { force: true });
    assert.equal(failing.byAppId['family-pulse'].readiness.ok, false);
    assert.match(failing.byAppId['family-pulse'].readiness.message, /No answer on its socket \(ECONNREFUSED\)/);
  });
});
