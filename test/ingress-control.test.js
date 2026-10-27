const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createIngressControl, readConfirmations } = require('../src/services/ingress-control');
const { createIngressRoutes } = require('../src/ingress-routes');
const { createTailscaleApi, readCredential } = require('../src/services/tailscale-api');
const { normalizeAction, compileAction } = require('../executor/actions');
const { PROTOCOL_VERSION } = require('../executor/protocol');

const SELF = 'nSelf1CNTRL';
const OTHER = 'nOther2CNTRL';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ingress-'));
const CONFIG = (dataDir, extra = {}) => ({ instance: 'smith', defaultDomain: 'Example-Tailnet.ts.net', dataDir, tailscaleManagedServiceId: 'svc:home', homeBaseExecutionMode: 'executor', homeBaseEnablePrivilegedJobs: true, homeBaseExecutorSocket: '/nonexistent', ...extra });

// tailscale CLI answers for this host: tagged, svc:home still published, svc:smith-home already on its socket.
function cli({ tags = ['tag:smith-host'], services = { 'svc:home': { endpoints: { 'tcp:443': 'https+insecure://localhost:443' } }, 'svc:smith-home': { endpoints: { 'tcp:443': 'https://unix:/run/sovereign-serve/home.sock' } } } } = {}) {
  return async (args) => {
    if (args[0] === 'status') return { Self: { ID: SELF, Tags: tags, TailscaleIPs: ['100.64.0.1'] } };
    if (args[0] === 'serve') return { version: '0.0.1', services };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
}

// A read-only API: svc:smith-pulse also has another approved host.
function fakeApi({ hosts = {} } = {}) {
  const inventory = { 'svc:smith-home': [{ nodeId: SELF, approvalLevel: 'approved:auto', configured: 'ready' }], 'svc:smith-pulse': [{ nodeId: OTHER, approvalLevel: 'approved:manual' }], ...hosts };
  return {
    listServiceHosts: async (name) => ({ ok: true, status: 200, body: { hosts: inventory[name] || [] } }),
    getService: async () => ({ ok: true, status: 200, body: { addrs: ['100.100.1.2', 'fd7a:115c:a1e0::1:2'] } }),
    listDevices: async () => ({ ok: true, status: 200, body: { devices: [{ nodeId: SELF, tags: ['tag:smith-host'] }] } }),
    getPolicy: async () => ({ ok: true, status: 200, body: { tagOwners: { 'tag:smith-host': ['admin@example.com'] }, autoApprovers: { services: { 'svc:smith-home': ['tag:smith-host'] } } } }),
  };
}

test('status with an API credential: verified, publishable, and blocked services, before the directory exists', async () => {
  const status = await createIngressControl({ config: CONFIG(tmp()), api: fakeApi(), cli: cli() }).status();
  assert.equal(status.domain, 'example-tailnet.ts.net');
  assert.equal(status.lifecycleState, 'none');
  assert.equal(status.legacyServicePresent, true);
  assert.deepEqual(status.self, { nodeId: SELF, tagged: true, hostTag: 'tag:smith-host', holdsHostTag: true });
  const byKey = Object.fromEntries(status.services.map((entry) => [entry.key, entry]));
  assert.equal(byKey.home.published, true);
  assert.equal(byKey.home.verification.state, 'verified');
  assert.deepEqual(byKey.home.warnings, []);
  assert.equal(byKey.home.gates.publish.allowed, true);
  assert.match(byKey.home.gates.tailnetMode.reason, /no household directory yet/);
  assert.equal(byKey.homebase.verification.reason, 'self-missing');
  assert.equal(byKey.homebase.gates.publish.allowed, true, 'nothing else is approved, so this host may become its host');
  assert.equal(byKey.pulse.verification.reason, 'other-host-approved');
  assert.equal(byKey.pulse.gates.publish.allowed, false);
});

test('an untagged host can publish nothing', async () => {
  const status = await createIngressControl({ config: CONFIG(tmp()), api: fakeApi(), cli: cli({ tags: [] }) }).status();
  assert.ok(status.services.every((entry) => !entry.gates.publish.allowed && /untagged/.test(entry.gates.publish.reason)));
});

test('without a credential: administrator confirmation, bound to this host, written to a file', async () => {
  const dataDir = tmp();
  const control = createIngressControl({ config: CONFIG(dataDir), cli: cli() });
  let byKey = Object.fromEntries((await control.status()).services.map((entry) => [entry.key, entry]));
  assert.equal(byKey.pulse.verification.mode, 'confirmation');
  assert.equal(byKey.pulse.gates.publish.allowed, false);
  assert.equal(byKey.pulse.warnings[0].id, 'policy-not-checked');
  await assert.rejects(() => control.confirm('pulse', { hostNodeId: OTHER }), /must name this host/);
  await assert.rejects(() => control.confirm('nope', { hostNodeId: SELF }), /not a service this host can serve/);
  const record = await control.confirm('pulse', { hostNodeId: SELF, confirmedBy: 'administrator' });
  assert.equal(record.service, 'svc:smith-pulse');
  assert.equal(fs.statSync(path.join(dataDir, 'ingress-confirmations.json')).mode & 0o777, 0o600);
  byKey = Object.fromEntries((await control.status()).services.map((entry) => [entry.key, entry]));
  assert.equal(byKey.pulse.verification.state, 'confirmed');
  assert.equal(byKey.pulse.verification.assurance, 'passphrase-session');
  assert.equal(byKey.pulse.gates.publish.allowed, true);
  fs.writeFileSync(path.join(dataDir, 'ingress-confirmations.json'), 'garbage');
  assert.deepEqual(readConfirmations(dataDir), {}, 'an unreadable file confirms nothing');
});

test('not configured: no instance, or a domain that is not the tailnet', async () => {
  assert.match((await createIngressControl({ config: CONFIG(tmp(), { instance: '' }), cli: cli() }).status()).problem, /HOME_BASE_INSTANCE is not set/);
  assert.match((await createIngressControl({ config: CONFIG(tmp(), { defaultDomain: 'tailnet' }), cli: cli() }).status()).problem, /tailnet domain/);
});

test('warm-up requests the service hostname at its service address', async () => {
  const control = createIngressControl({ config: CONFIG(tmp()), api: fakeApi(), cli: cli() });
  const seen = {};
  const request = (options, onResponse) => {
    Object.assign(seen, { host: options.host, servername: options.servername });
    options.lookup(options.host, {}, (error, address) => { seen.address = address; });
    const req = new (require('node:events'))();
    req.end = () => onResponse({ statusCode: 404, resume() {} });
    req.destroy = () => {};
    return req;
  };
  const result = await control.warmUp('home', { request });
  assert.deepEqual(seen, { host: 'smith-home.example-tailnet.ts.net', servername: 'smith-home.example-tailnet.ts.net', address: '100.100.1.2' });
  assert.equal(result.ok, true);
  assert.match((await createIngressControl({ config: CONFIG(tmp()), cli: cli() }).warmUp('home')).detail, /no Tailscale API credential/);
});

test('API client: reads the credential file, exchanges and reuses a token, only GETs', async (t) => {
  const dir = tmp();
  const file = path.join(dir, 'tailscale-api.env');
  fs.writeFileSync(file, 'TS_OAUTH_CLIENT_ID=cid\nTS_OAUTH_CLIENT_SECRET="secret"\n');
  assert.deepEqual(readCredential(file), { clientId: 'cid', clientSecret: 'secret' });
  assert.equal(createTailscaleApi({ credentialPath: path.join(dir, 'missing.env') }), null);
  fs.writeFileSync(path.join(dir, 'half.env'), 'TS_OAUTH_CLIENT_ID=cid\n');
  assert.throws(() => createTailscaleApi({ credentialPath: path.join(dir, 'half.env') }), /needs TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET/);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', auth: options.headers?.Authorization });
    if (url.endsWith('/oauth/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600, scope: 'services:read devices:core:read' }) };
    return { ok: true, status: 200, json: async () => ({ hosts: [] }) };
  };
  const api = createTailscaleApi({ credentialPath: file, fetchImpl });
  await api.listServiceHosts('svc:smith-home');
  await api.getService('svc:smith-home');
  assert.deepEqual(calls.map((call) => [call.method, call.url.replace('https://api.tailscale.com/api/v2', '')]), [
    ['POST', '/oauth/token'], ['GET', '/tailnet/-/services/svc:smith-home/devices'], ['GET', '/tailnet/-/services/svc:smith-home'],
  ]);
  assert.equal(calls[1].auth, 'Bearer tok');
  assert.equal(api.grantedScopes(), 'services:read devices:core:read');
  await assert.rejects(() => api.listServiceHosts('svc:../acl'), /not a service name/);
  const refused = createTailscaleApi({ credentialPath: file, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.deepEqual(await refused.listServiceHosts('svc:smith-home'), { ok: false, status: 401, error: 'token exchange refused (HTTP 401)' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('executor actions: the three ingress actions compile to policy-valid plans and refuse stray fields', () => {
  const cutover = compileAction(normalizeAction({ action: 'ingress-cutover', instance: 'smith', domain: 'example-tailnet.ts.net', legacyService: 'svc:home' })).plan;
  assert.deepEqual(cutover.operations.map((operation) => operation.type), ['nginx.ensure-socket-gateway', 'nginx.validate-and-reload', 'tailscale.retire-service']);
  assert.equal(compileAction(normalizeAction({ action: 'service-publish', serviceKey: 'pulse' })).plan.operations[0].serviceKey, 'pulse');
  assert.equal(compileAction(normalizeAction({ action: 'ingress-rollback' })).plan.kind, 'ingress-rollback');
  assert.throws(() => normalizeAction({ action: 'service-publish', serviceKey: '../x' }), /serviceKey/);
  assert.throws(() => normalizeAction({ action: 'ingress-rollback', appId: 'family-dinner' }), /appId is not accepted/);
  assert.throws(() => normalizeAction({ action: 'ingress-cutover', instance: 'smith', domain: 'example-tailnet.ts.net', legacyService: 'home; rm -rf /' }), /legacyService/);
  assert.throws(() => compileAction(normalizeAction({ action: 'ingress-cutover', instance: 'smith', domain: 'example.com' })), /tailnet domain/);
});

// The route module behind a real HTTP server, with the admin check, executor, and jobs faked.
async function routes(t, { unlocked = true, config = CONFIG(tmp()), api = fakeApi(), capabilities = { protocolVersions: [PROTOCOL_VERSION], mutationsEnabled: true, actions: ['install', 'ingress-cutover', 'service-publish', 'ingress-rollback'] }, installations = {} } = {}) {
  const audits = [];
  const jobs = [];
  const logs = [];
  const handle = createIngressRoutes({
    stateStore: { appendJobLog: (id, text) => logs.push([id, text]) },
    jobRunner: { startTypedActionJob: (job) => { jobs.push(job); return jobs.length; } },
    sendJson: (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); },
    parseBody: (req) => new Promise((resolve) => { let text = ''; req.on('data', (chunk) => { text += chunk; }); req.on('end', () => resolve(text ? JSON.parse(text) : {})); }),
    recordAdminAudit: (_store, record) => audits.push(record),
    executionBlockOutcome: () => 'blocked-auth',
    controlFactory: (options) => createIngressControl({ ...options, cli: cli() }),
    apiFactory: () => api,
    adminStatus: async () => ({ unlocked }),
    requireAdmin: async () => (unlocked ? { ok: true, sessionTokenHash: 'h' } : { ok: false, statusCode: 401, payload: { error: 'Admin unlock is required before real execution.' } }),
    executorCapabilities: async () => capabilities,
  });
  const server = http.createServer(async (req, res) => {
    const handled = await handle({ req, res, method: req.method, pathname: new URL(req.url, 'http://x').pathname, config, state: { installations } });
    if (!handled) { res.writeHead(418); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => { const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const get = async (url) => { const res = await fetch(`${base}${url}`); return { status: res.status, body: await res.json() }; };
  return { base, post, get, audits, jobs, logs };
}

test('routes: status needs an unlocked admin; other paths are left alone', async (t) => {
  const locked = await routes(t, { unlocked: false });
  assert.equal((await locked.get('/api/ingress')).status, 401);
  const open = await routes(t);
  const status = await open.get('/api/ingress');
  assert.equal(status.status, 200);
  assert.equal(status.body.apiCredential, 'configured');
  assert.equal((await fetch(`${open.base}/api/network/tailscale`)).status, 418, 'not an ingress route: left to the app');
});

test('routes: cutover asks the executor for the cutover, retiring the legacy service', async (t) => {
  const { post, jobs, audits } = await routes(t);
  assert.equal((await post('/api/ingress/cutover', {})).status, 400);
  const started = await post('/api/ingress/cutover', { confirm: 'CUTOVER' });
  assert.equal(started.status, 202);
  assert.deepEqual(jobs[0].action, { action: 'ingress-cutover', instance: 'smith', domain: 'example-tailnet.ts.net', legacyService: 'svc:home' });
  assert.equal(audits.at(-1).outcome, 'queued');
  const old = await routes(t, { capabilities: { protocolVersions: [PROTOCOL_VERSION], mutationsEnabled: true, actions: ['install'] } });
  assert.equal((await old.post('/api/ingress/cutover', { confirm: 'CUTOVER' })).body.code, 'EXECUTOR_INCOMPATIBLE');
  const legacy = await routes(t, { config: CONFIG(tmp(), { homeBaseExecutionMode: 'legacy-sudo' }) });
  assert.equal((await legacy.post('/api/ingress/cutover', { confirm: 'CUTOVER' })).body.code, 'EXECUTOR_REQUIRED');
});

test('routes: publish is gated per service (D23) and warms the certificate after the job', async (t) => {
  const { post, jobs, audits, logs } = await routes(t);
  const blocked = await post('/api/ingress/services/pulse/publish', { confirm: 'PUBLISH' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /nOther2CNTRL \(approved:manual\) is also approved/);
  assert.equal(audits.at(-1).outcome, 'blocked-policy');
  assert.equal((await post('/api/ingress/services/nope/publish', { confirm: 'PUBLISH' })).status, 404);
  assert.equal((await post('/api/ingress/services/home/publish', {})).status, 400);
  assert.equal((await post('/api/ingress/services/homebase/publish', { confirm: 'PUBLISH' })).status, 202);
  assert.deepEqual(jobs[0].action, { action: 'service-publish', serviceKey: 'homebase' });
  assert.equal(typeof jobs[0].onComplete, 'function');
  assert.equal(logs.length, 0);
});

test('routes: confirmation is only for hosts without a credential; rollback waits for apps to leave tailnet mode', async (t) => {
  const withApi = await routes(t);
  assert.equal((await withApi.post('/api/ingress/services/pulse/confirm', { hostNodeId: SELF })).body.code, 'CONFIRMATION_NOT_USED');
  const noApi = await routes(t, { api: null });
  assert.equal((await noApi.post('/api/ingress/services/pulse/confirm', { hostNodeId: OTHER })).status, 409);
  assert.equal((await noApi.post('/api/ingress/services/pulse/confirm', { hostNodeId: SELF })).status, 200);
  assert.equal((await noApi.post('/api/ingress/services/pulse/publish', { confirm: 'PUBLISH' })).status, 202);
  const trusting = await routes(t, { installations: { 'family-pulse': { identityMode: 'tailnet' } } });
  assert.equal((await trusting.post('/api/ingress/rollback', { confirm: 'ROLLBACK' })).body.code, 'APPS_IN_TAILNET_MODE');
  const clean = await routes(t);
  assert.equal((await clean.post('/api/ingress/rollback', { confirm: 'ROLLBACK' })).status, 202);
  assert.equal((await clean.post('/api/ingress/rollback', {})).status, 400);
});

test('routes: a confirmation needs an unlocked admin but not privileged jobs (it runs nothing)', async (t) => {
  const seen = [];
  const handle = createIngressRoutes({
    stateStore: {}, jobRunner: {}, recordAdminAudit: () => {}, executionBlockOutcome: () => 'x',
    sendJson: (res, status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)); },
    parseBody: async () => ({ hostNodeId: SELF }),
    controlFactory: (options) => createIngressControl({ ...options, cli: cli() }),
    apiFactory: () => null,
    requireAdmin: async (_req, _store, options) => { seen.push(options.privilegedJobsEnabled); return { ok: true }; },
  });
  const server = http.createServer((req, res) => handle({ req, res, method: req.method, pathname: req.url, config: CONFIG(tmp(), { homeBaseEnablePrivilegedJobs: false }), state: {} }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ingress/services/pulse/confirm`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [true]);
});

test('after cutover: config locks the address fields, readiness reflects services, the single-service publish is refused', async (t) => {
  const { createApp } = require('../src/app');
  const { SqliteStateStore } = require('../src/state/sqlite-store');
  const dir = tmp();
  const stateDbPath = path.join(dir, 'state.sqlite3');
  // A host whose Tailscale is up but has no svc:home (as after a cutover).
  const run = (command) => {
    if (command === 'command -v tailscale') return { command, ok: true, exitCode: 0, stdout: '/usr/bin/tailscale\n', stderr: '' };
    if (command === 'tailscale version') return { command, ok: true, exitCode: 0, stdout: '1.102.4\n', stderr: '' };
    if (command === 'tailscale status --json') return { command, ok: true, exitCode: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.example-tailnet.ts.net.', Online: true } }), stderr: '' };
    if (command === 'tailscale serve get-config --all') return { command, ok: true, exitCode: 0, stdout: JSON.stringify({ version: '0.0.1', services: { 'svc:smith-home': { endpoints: { 'tcp:443': 'https://unix:/run/sovereign-serve/home.sock' } } } }), stderr: '' };
    return { command, ok: false, exitCode: 1, stdout: '', stderr: '' };
  };
  const app = createApp({ appName: 'Home Base', stateDbPath, dataDir: dir, port: 0, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', baseBackupDir: '/var/lib/sovereign-home/backups', baseConfigDir: '/etc/sovereign-home', defaultHostname: 'host', defaultDomain: 'example-tailnet.ts.net', instance: 'smith', tailscaleRunCommand: run, homeBaseExecutionMode: 'legacy-sudo', homeBaseEnablePrivilegedJobs: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const json = async (url, options) => { const res = await fetch(`${base}${url}`, options); return { status: res.status, body: await res.json() }; };
  const setup = await fetch(`${base}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'test-admin-passphrase' }) });
  const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];
  const post = (url, body) => json(url, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

  assert.deepEqual((await json('/api/homebase/config')).body.ingress, { instance: 'smith', cutOver: false });
  assert.equal((await json('/api/network/tailscale')).body.readiness.state, 'authenticated-unpublished', 'before cutover: the old single service is missing');
  const store = new SqliteStateStore(stateDbPath);
  const { id } = store.createJob({ kind: 'ingress-cutover', target: 'local-host', status: 'queued', dryRun: false, createdAt: new Date().toISOString(), currentStep: null, planJson: '{}' });
  store.updateJob(id, { status: 'completed', finishedAt: new Date().toISOString() });

  assert.deepEqual((await json('/api/homebase/config')).body.ingress, { instance: 'smith', cutOver: true, homebaseUrl: 'https://smith-homebase.example-tailnet.ts.net/', appsUrl: 'https://smith-home.example-tailnet.ts.net/' });
  assert.equal((await json('/api/network/tailscale')).body.readiness.label, 'Per-service sockets');
  const current = (await json('/api/homebase/config')).body;
  const unchanged = { hostname: current.hostname, domain: current.domain, tailscaleManagedServiceId: current.tailscaleManagedServiceId, householdTimezone: 'America/Chicago' };
  assert.equal((await post('/api/homebase/config', unchanged)).status, 200, 'other settings still save');
  const moved = await post('/api/homebase/config', { ...unchanged, domain: 'other-tailnet.ts.net' });
  assert.equal(moved.status, 409);
  assert.match(moved.body.error, /domain cannot change while this host uses per-service sockets/);
  assert.equal((await post('/api/network/tailscale/publish-execute', { dryRun: true })).body.code, 'INGRESS_CUT_OVER');
});
