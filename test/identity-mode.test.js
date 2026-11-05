const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createBaseHandlers, INGRESS_STATE_PATH, renderAppEnvFile } = require('../executor/handlers');
const { normalizeAction, compileAction } = require('../executor/actions');
const { PROTOCOL_VERSION } = require('../executor/protocol');
const { buildAppIdentityModePlan } = require('../src/operations/compilers/lifecycle');
const { validateOperationPolicy } = require('../src/operations/policy');
const { appLayout } = require('../src/operations/app-layout');
const { IDENTITY_SNAPSHOT } = require('../src/operations/paths');
const { keepIdentityEnv, parseDotEnv, setIdentityEnv } = require('../src/operations/env');
const { validateManifestEntry } = require('../src/manifest-schema');
const { getAppById } = require('../src/catalog');
const { createIngressControl } = require('../src/services/ingress-control');
const { createIngressRoutes } = require('../src/ingress-routes');
const { JobRunner } = require('../src/services/job-runner');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { DEFAULT_SNAPSHOT_PATH } = require('sovereign-auth');
const { createFakeFs } = require('./fixtures/fake-fs');
const { users } = require('./fixtures/users');

// Feature-10 SID-007 slice 1: Home Base switches an installed app between its own sign-in and members' tailnet
// identity. No catalog app supports tailnet identity yet, so these tests give one (Pulse, on its socket) the flag.

const withIdentity = (appId, identity = 'tailnet') => {
  const app = getAppById(appId);
  return { ...app, runtime: { ...app.runtime, identity } };
};
// The catalog entry itself, for code that looks the app up by id; restored after the test.
function supportTailnet(t, appId) {
  const runtime = getAppById(appId).runtime;
  const before = runtime.identity;
  runtime.identity = 'tailnet';
  t.after(() => { if (before === undefined) delete runtime.identity; else runtime.identity = before; });
}

const PULSE_ENV = '/opt/sovereign-home/apps/familyPulse/.env';
const CUT_OVER = JSON.stringify({ mode: 'sockets', instance: 'smith', domain: 'example-tailnet.ts.net' });
const base = (fields = {}) => ({ id: 'op', type: 'app.set-identity-mode', title: 't', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields });

// A cut-over host with Pulse installed as its own user, and Home Base (uid 990) publishing the snapshot.
function host(files = {}) {
  const fsImpl = createFakeFs(Object.fromEntries(Object.entries({
    '/opt/sovereign-home/apps/familyPulse': { kind: 'dir', uid: 1101 },
    [PULSE_ENV]: { kind: 'file', content: 'DATABASE_URL=postgresql://familypulse:pw@127.0.0.1:5432/familypulse\nPLAID_ENV=sandbox\nSOVEREIGN_IDENTITY_MODE=local\n', uid: 1101, mode: 0o600 },
    [INGRESS_STATE_PATH]: CUT_OVER,
    '/var/lib/sovereign-home/identity': { kind: 'dir', uid: 990, mode: 0o755 },
    [IDENTITY_SNAPSHOT]: { kind: 'file', content: '{}', uid: 990, mode: 0o644 },
    ...files,
  }).filter(([, entry]) => entry !== undefined)));
  const as = [];
  const handlers = createBaseHandlers({ fsImpl, run: async () => ({ stdout: '' }), lookupUser: users(), asUser: (user, fn) => { as.push(user.uid); return fn(); } });
  return { fsImpl, as, handlers, set: (mode, layout = appLayout(withIdentity('family-pulse'))) => handlers['app.set-identity-mode'](base({ mode }), { layout }) };
}

test('the catalog says which apps can trust tailnet identity, only on their socket', () => {
  assert.equal(IDENTITY_SNAPSHOT, DEFAULT_SNAPSHOT_PATH, 'the executor looks where sovereignAuth reads');
  assert.deepEqual(appLayout(getAppById('family-pulse')).identityModes, ['local']);
  assert.deepEqual(appLayout(withIdentity('family-pulse')).identityModes, ['local', 'tailnet']);
  // Family Plan still listens on loopback TCP, where any local process could forge identity headers.
  assert.throws(() => appLayout(withIdentity('family-plan')), /needs runtime.listen 'unix'/);
  assert.match(validateManifestEntry(withIdentity('family-plan')).join('; '), /runtime.identity 'tailnet' needs runtime.listen 'unix'/);
  assert.match(validateManifestEntry(withIdentity('family-pulse', 'headers')).join('; '), /runtime.identity must be 'local' or 'tailnet'/);
  assert.deepEqual(validateManifestEntry(withIdentity('family-pulse')), []);
});

test('the .env says which identity the app trusts, and an update or restore keeps it', () => {
  const capable = appLayout(withIdentity('family-pulse'));
  const plain = appLayout(getAppById('family-pulse'));
  assert.deepEqual(setIdentityEnv({ A: '1', SOVEREIGN_IDENTITY_MODE: 'tailnet' }, { mode: 'tailnet', homeBaseUid: 990 }), { A: '1', SOVEREIGN_AUTH_MODE: 'tailnet', SOVEREIGN_HOMEBASE_UID: '990' });
  assert.deepEqual(setIdentityEnv({ A: '1', SOVEREIGN_AUTH_MODE: 'tailnet', SOVEREIGN_HOMEBASE_UID: '990' }, { mode: 'local' }), { A: '1', SOVEREIGN_AUTH_MODE: 'local' });
  assert.throws(() => setIdentityEnv({}, { mode: 'tailnet', homeBaseUid: 0 }), /uid/);
  assert.throws(() => setIdentityEnv({}, { mode: 'headers' }), /unknown identity mode/);
  // The app's current .env decides, never the incoming one (a template, or a backup).
  const tailnet = { SOVEREIGN_AUTH_MODE: 'tailnet', SOVEREIGN_HOMEBASE_UID: '990' };
  const written = 'SOVEREIGN_AUTH_MODE=tailnet\nSOVEREIGN_HOMEBASE_UID=990\n';
  assert.deepEqual(keepIdentityEnv({ A: '1', SOVEREIGN_AUTH_MODE: 'local' }, `A=1\n${written}`, capable), { A: '1', ...tailnet });
  assert.deepEqual(keepIdentityEnv({ A: '1', ...tailnet }, 'SOVEREIGN_AUTH_MODE=local\n', capable), { A: '1', SOVEREIGN_AUTH_MODE: 'local' }, 'a backup taken in tailnet mode does not bring it back');
  assert.deepEqual(keepIdentityEnv({ A: '1' }, '', capable), { A: '1', SOVEREIGN_AUTH_MODE: 'local' }, 'sovereignAuth refuses to start without a mode');
  assert.deepEqual(keepIdentityEnv({ A: '1', ...tailnet, SOVEREIGN_IDENTITY_MODE: 'tailnet', 'export SOVEREIGN_AUTH_MODE': 'tailnet' }, written, plain), { A: '1' }, 'an app that cannot trust the directory gets no mode');
  // Tailnet survives only as the executor wrote it. A hand edit never turns trust on, since that would skip every
  // gate (dotenv reads `local#pilot` as local); it falls back to local, which the rollback guard still counts.
  const { trustsIdentityHeaders } = require('../executor/handlers');
  for (const content of [
    'SOVEREIGN_AUTH_MODE=local#pilot\nSOVEREIGN_HOMEBASE_UID=990', 'SOVEREIGN_AUTH_MODE=`local`\nSOVEREIGN_HOMEBASE_UID=990',
    'export SOVEREIGN_AUTH_MODE=tailnet\nSOVEREIGN_HOMEBASE_UID=990', 'SOVEREIGN_AUTH_MODE: tailnet\nSOVEREIGN_HOMEBASE_UID=990',
    'SOVEREIGN_AUTH_MODE=tailnet # pilot\nSOVEREIGN_HOMEBASE_UID=990', `${written}SOVEREIGN_AUTH_MODE: local`, `${written}SOVEREIGN_IDENTITY_MODE=tailnet`,
    'SOVEREIGN_AUTH_MODE=tailnet', `${written}export SOVEREIGN_HOMEBASE_UID=0`, 'SOVEREIGN_AUTH_MODE=tailnet\nSOVEREIGN_HOMEBASE_UID=0',
    // Inside another key's multi-line quoted value, these lines are not assignments at all.
    `NOTES="\n${written}"`, `NOTES='\n${written}'\n`, `${written}KEY="-----BEGIN\nabc\n-----END"`,
    `SOVEREIGN_AUTH_MODE\n=local\nNOTES=\n"\n${written}"\n`, `${written}# a note\n`, `${written}\n`, written.replace(/\n/g, '\r\n'),
    // dotenv doesn't decode JSON escapes: it reads this literally, which sovereignAuth refuses.
    'SOVEREIGN_AUTH_MODE="\\u0074ailnet"\nSOVEREIGN_HOMEBASE_UID=990\n', `NOTES="\\q"\n${written}`, `A="x\u2028y"\n${written}`,
    // Not a uid (a hand edit): no number to keep.
    `SOVEREIGN_AUTH_MODE=tailnet\nSOVEREIGN_HOMEBASE_UID=${'9'.repeat(309)}\n`, 'SOVEREIGN_AUTH_MODE=tailnet\nSOVEREIGN_HOMEBASE_UID=4294967295\n',
  ]) {
    assert.deepEqual(keepIdentityEnv({ A: '1', 'export SOVEREIGN_AUTH_MODE': 'tailnet', SOVEREIGN_HOMEBASE_UID: '990' }, content, capable), { A: '1', SOVEREIGN_AUTH_MODE: 'local' }, JSON.stringify(content));
  }
  // Home Base's own values: plain or quoted ones keep tailnet; one that needs escaping (a backslash, a quote) is read
  // differently by different loaders, so that file falls back to local too.
  const { renderEnv } = require('../src/operations/env');
  assert.deepEqual(keepIdentityEnv({ A: '1' }, renderEnv({ PATHS: '/a b/c', NOTE: 'say hi # not a comment', ...tailnet }), capable), { A: '1', ...tailnet });
  assert.deepEqual(keepIdentityEnv({ A: '1' }, renderEnv({ QUOTE: 'say "hi"', ...tailnet }), capable), { A: '1', SOVEREIGN_AUTH_MODE: 'local' });
  assert.doesNotThrow(() => keepIdentityEnv({}, 'NOTES="\\q"\nSOVEREIGN_AUTH_MODE=local\n', capable));
  for (const content of ['export SOVEREIGN_AUTH_MODE=tailnet', 'SOVEREIGN_AUTH_MODE: tailnet', 'SOVEREIGN_AUTH_MODE=tailnet # pilot', `${written}SOVEREIGN_AUTH_MODE: local`, 'SOVEREIGN_AUTH_MODE\n=tailnet\nSOVEREIGN_HOMEBASE_UID=990']) {
    assert.equal(trustsIdentityHeaders(content), true, `the rollback guard still counts ${JSON.stringify(content)}`);
  }
});

test('an update re-renders the .env and keeps the identity mode the app is in', () => {
  const layout = appLayout(withIdentity('family-pulse'));
  const site = { hostname: 'host', domain: 'example-tailnet.ts.net', householdTimezone: 'America/New_York' };
  const render = (existingContent) => parseDotEnv(renderAppEnvFile({ layout, password: 'pw-123456789012', site, existingContent, fsImpl: createFakeFs() }));
  assert.equal(render('').SOVEREIGN_AUTH_MODE, 'local', 'a fresh install starts local');
  const updated = render('SOVEREIGN_AUTH_MODE=tailnet\nSOVEREIGN_HOMEBASE_UID=990\n');
  assert.deepEqual([updated.SOVEREIGN_AUTH_MODE, updated.SOVEREIGN_HOMEBASE_UID], ['tailnet', '990']);
});

test('the plan: the switch, then a restart, only for an app that supports the mode', (t) => {
  assert.throws(() => buildAppIdentityModePlan({ appId: 'family-pulse', mode: 'tailnet' }), /does not support tailnet identity/);
  // Forged: a plan naming tailnet mode for an app whose catalog entry doesn't support it.
  const local = buildAppIdentityModePlan({ appId: 'family-pulse', mode: 'local' });
  const forged = { ...local, operations: local.operations.map((operation) => (operation.type === 'app.set-identity-mode' ? { ...operation, mode: 'tailnet' } : operation)) };
  assert.throws(() => validateOperationPolicy(forged), /does not support tailnet identity/);
  supportTailnet(t, 'family-pulse');
  const { plan } = compileAction(normalizeAction({ action: 'identity-mode', appId: 'family-pulse', mode: 'tailnet' }));
  assert.equal(plan.kind, 'app-identity-mode');
  const layout = appLayout(getAppById('family-pulse'));
  const types = plan.operations.map((operation) => operation.type);
  assert.deepEqual([types[0], types.at(-1)], ['app.set-identity-mode', 'http.wait-ready']);
  assert.ok(types.slice(1, -1).length >= 1 && types.slice(1, -1).every((type) => type === 'systemd.ensure-service'), types.join(', '));
  assert.equal(plan.operations[0].mode, 'tailnet');
  const restarts = plan.operations.filter((operation) => operation.type === 'systemd.ensure-service');
  assert.equal(restarts[0].unit, layout.service.unit, 'the app first');
  assert.ok(restarts.every((operation) => operation.action === 'enable-and-restart'), 'restarts only: nothing stops');
  assert.throws(() => normalizeAction({ action: 'identity-mode', appId: 'family-pulse', mode: 'headers' }), /mode must be local or tailnet/);
  assert.throws(() => normalizeAction({ action: 'identity-mode', appId: 'family-pulse', mode: 'local', site: {} }), /site is not accepted/);
});

test('the executor switches to tailnet mode only on a cut-over host with the snapshot in place, as the app', async () => {
  const { fsImpl, as, set } = host();
  assert.match(await set('tailnet'), /trusts tailnet identity \(Home Base uid 990\)/);
  const env = parseDotEnv(fsImpl.readFileSync(PULSE_ENV));
  assert.deepEqual([env.SOVEREIGN_AUTH_MODE, env.SOVEREIGN_HOMEBASE_UID, env.SOVEREIGN_IDENTITY_MODE, env.PLAID_ENV], ['tailnet', '990', undefined, 'sandbox']);
  assert.equal(fsImpl.entries.get(PULSE_ENV).mode, 0o600);
  assert.deepEqual([...new Set(as)], [1101], 'the .env is read and written as Pulse, never as root');
  assert.match(await set('local'), /uses its own sign-in/);
  const back = parseDotEnv(fsImpl.readFileSync(PULSE_ENV));
  assert.deepEqual([back.SOVEREIGN_AUTH_MODE, back.SOVEREIGN_HOMEBASE_UID], ['local', undefined]);
  // An app that can't trust the directory: back to local leaves no mode in its .env (as an update would).
  await set('local', appLayout(getAppById('family-pulse')));
  assert.doesNotMatch(fsImpl.readFileSync(PULSE_ENV), /SOVEREIGN_/);
});

test('the executor refuses tailnet mode wherever identity headers or the snapshot could not be trusted', async () => {
  const refused = async (files, pattern, layout) => {
    const { fsImpl, set } = host(files);
    await assert.rejects(() => set('tailnet', layout), pattern);
    assert.doesNotMatch(fsImpl.readFileSync(PULSE_ENV), /SOVEREIGN_AUTH_MODE/, 'nothing written');
  };
  await refused({}, /does not support tailnet identity/, appLayout(getAppById('family-pulse')));
  await refused({ [INGRESS_STATE_PATH]: undefined }, /not cut over/);
  await refused({ '/var/lib/sovereign-home/identity': { kind: 'dir', uid: 0, mode: 0o755 }, [IDENTITY_SNAPSHOT]: { kind: 'file', content: '{}', uid: 0 } }, /owned by the Home Base user/);
  await refused({ '/var/lib/sovereign-home/identity': { kind: 'dir', uid: 990, mode: 0o777 } }, /writable by no one else/);
  await refused({ [IDENTITY_SNAPSHOT]: { kind: 'file', content: '{}', uid: 1101 } }, /has not published the household directory snapshot/);
  await refused({ [IDENTITY_SNAPSHOT]: { kind: 'link', target: '/tmp/x' } }, /has not published/);
  const { set } = host({ [PULSE_ENV]: { kind: 'link', target: '/etc/shadow' } });
  await assert.rejects(() => set('local'), /has no \.env/);
  // Installed before SID-002 and not moved yet: it still runs as the shared user, whose other apps reach its socket.
  await refused({ '/opt/sovereign-home/apps/familyPulse': { kind: 'dir', uid: 1001 }, [PULSE_ENV]: { kind: 'file', content: 'PLAID_ENV=sandbox\n', uid: 1001, mode: 0o640 } }, /still runs as sovereign; move it to sovereign-pulse first/);
});

test('a low-friction app shares the user by design, so it may trust tailnet identity on its socket', async () => {
  // Family Plan as slice 2 will make it: on its socket, the shared user.
  const app = getAppById('family-plan');
  const layout = appLayout({ ...app, runtime: { ...app.runtime, listen: 'unix', identity: 'tailnet' } });
  assert.equal(layout.identity.own, false);
  const { fsImpl, set } = host({ '/opt/sovereign-home/apps/familyPlan': { kind: 'dir', uid: 1001 }, '/opt/sovereign-home/apps/familyPlan/.env': { kind: 'file', content: 'PORT=3001\n', uid: 1001, mode: 0o640 } });
  assert.match(await set('tailnet', layout), /trusts tailnet identity/);
  assert.match(fsImpl.readFileSync('/opt/sovereign-home/apps/familyPlan/.env'), /^SOVEREIGN_AUTH_MODE=tailnet$/m);
});

// The route module, with the admin check, Tailscale and the executor faked; Home Base active by default.
async function routes(t, { lifecycle = 'active', installations = { 'family-pulse': { appId: 'family-pulse' } }, cutOver = true, published = true, hosts = null, appBlock = () => null, actions = ['install', 'identity-mode'] } = {}) {
  const jobs = [];
  const audits = [];
  const recorded = [];
  const services = { 'svc:smith-pulse': { endpoints: { 'tcp:443': 'https://unix:/run/sovereign-serve/pulse.sock' } } };
  const cli = async (args) => (args[0] === 'status' ? { Self: { ID: 'nSelf', Tags: ['tag:smith-host'] } } : { version: '0.0.1', services: published ? services : {} });
  const api = {
    listServiceHosts: async () => ({ ok: true, status: 200, body: { hosts: hosts || [{ nodeId: 'nSelf', approvalLevel: 'approved:auto', configured: 'ready' }] } }),
    getService: async (name) => ({ ok: true, status: 200, body: { name, tags: [] } }),
    listDevices: async () => ({ ok: true, status: 200, body: { devices: [] } }),
    getPolicy: async () => ({ ok: true, status: 200, body: {} }),
  };
  const config = { instance: 'smith', defaultDomain: 'example-tailnet.ts.net', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'identity-mode-')), homeBaseExecutionMode: 'executor', homeBaseEnablePrivilegedJobs: true, homeBaseExecutorSocket: '/nonexistent' };
  const state = { installations, ingressJobs: cutOver ? [{ id: 1, kind: 'ingress-cutover', status: 'completed', dryRun: false, finishedAt: '2026-11-05T00:00:00.000Z' }] : [] };
  const handle = createIngressRoutes({
    stateStore: { setIdentityMode: (appId, mode) => { recorded.push([appId, mode, jobs.length]); state.installations[appId].identityMode = mode; } },
    jobRunner: { startTypedActionJob: (job) => { jobs.push(job); return jobs.length; } },
    sendJson: (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); },
    parseBody: (req) => new Promise((resolve) => { let text = ''; req.on('data', (chunk) => { text += chunk; }); req.on('end', () => resolve(text ? JSON.parse(text) : {})); }),
    recordAdminAudit: (_store, record) => audits.push(record),
    executionBlockOutcome: () => 'blocked-auth',
    controlFactory: (options) => createIngressControl({ ...options, cli }),
    apiFactory: () => api,
    adminStatus: async () => ({ unlocked: true }),
    requireAdmin: async () => ({ ok: true, sessionTokenHash: 'h' }),
    executorCapabilities: async () => ({ protocolVersions: [PROTOCOL_VERSION], mutationsEnabled: true, actions }),
    lifecycleState: typeof lifecycle === 'function' ? lifecycle : () => lifecycle,
    appBlock,
  });
  const server = http.createServer(async (req, res) => {
    if (!await handle({ req, res, method: req.method, pathname: new URL(req.url, 'http://x').pathname, config, state })) { res.writeHead(418); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (pathname, body) => { const res = await fetch(`${url}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const get = async (pathname) => (await fetch(`${url}${pathname}`)).json();
  return { post, get, jobs, audits, recorded, state };
}

test('routes: tailnet mode is recorded before it starts, and only once the service may use it', async (t) => {
  supportTailnet(t, 'family-pulse');
  const { post, get, jobs, recorded, audits } = await routes(t);
  assert.equal((await post('/api/ingress/apps/family-pulse/tailnet-mode', {})).status, 400);
  const started = await post('/api/ingress/apps/family-pulse/tailnet-mode', { confirm: 'TAILNET' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.deepEqual(jobs[0].action, { action: 'identity-mode', appId: 'family-pulse', mode: 'tailnet' });
  assert.deepEqual(recorded, [['family-pulse', 'tailnet', 0]], 'recorded before the job started, so an ingress rollback is refused from then on');
  assert.equal(audits.at(-1).action, 'app-tailnet-mode');
  const status = await get('/api/ingress');
  assert.equal(status.lifecycleState, 'active');
  assert.deepEqual(status.services.find((entry) => entry.key === 'pulse').identity, [{ appId: 'family-pulse', name: 'Family Pulse', mode: 'tailnet', supportsTailnet: true }]);
  // Back to local: recorded only once the job completes (the job runner does that).
  assert.equal((await post('/api/ingress/apps/family-pulse/local-mode', { confirm: 'LOCAL' })).status, 202);
  assert.deepEqual(jobs[1].action, { action: 'identity-mode', appId: 'family-pulse', mode: 'local' });
  assert.equal(recorded.length, 1);
});

test('routes: tailnet mode is refused until the app, the host, the service and Home Base are all ready', async (t) => {
  const code = async (options, expected) => {
    const { post, jobs, recorded } = await routes(t, options);
    const answer = await post('/api/ingress/apps/family-pulse/tailnet-mode', { confirm: 'TAILNET' });
    assert.equal(answer.body.code, expected, JSON.stringify(answer.body));
    assert.deepEqual([jobs.length, recorded.length], [0, 0], `${expected}: nothing started or recorded`);
    return answer.body.error;
  };
  await code({}, 'TAILNET_UNSUPPORTED');
  supportTailnet(t, 'family-pulse');
  await code({ cutOver: false }, 'NOT_CUT_OVER');
  await code({ published: false }, 'SERVICE_NOT_PUBLISHED');
  assert.match(await code({ hosts: [{ nodeId: 'nSelf', approvalLevel: 'approved:auto' }, { nodeId: 'nOther', approvalLevel: 'approved:manual' }] }, 'SERVICE_GATE'), /nOther/);
  assert.match(await code({ lifecycle: 'setup' }, 'SERVICE_GATE'), /only once it is active/);
  assert.match(await code({ lifecycle: 'none' }, 'SERVICE_GATE'), /no household directory/);
  await code({ appBlock: () => ({ error: 'Family Pulse already has job #3 (restart) in progress; wait for it to finish.', code: 'APP_BUSY' }) }, 'APP_BUSY');
  // Recovery opened while the route waited (on the admin check, Tailscale or the executor): refused at the start.
  for (const at of [1, 2]) {
    let reads = 0;
    await code({ lifecycle: () => (reads++ < at ? 'active' : 'recovery') }, 'STATE_CHANGED');
  }
  const old = await routes(t, { actions: ['install', 'restart'] });
  assert.equal((await old.post('/api/ingress/apps/family-pulse/tailnet-mode', { confirm: 'TAILNET' })).body.code, 'EXECUTOR_INCOMPATIBLE');
  assert.equal((await old.post('/api/ingress/apps/no-such-app/local-mode', { confirm: 'LOCAL' })).status, 404);
});

test('routes: a confirmation is recorded as the hardware key only when the key confirmed it', async () => {
  // Without an API credential the administrator confirms each service's hosts; in active Home Base that route is
  // a privileged plan (route matrix), so the key was tapped for it.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-mode-'));
  const cli = async (args) => (args[0] === 'status' ? { Self: { ID: 'nSelf', Tags: ['tag:smith-host'] } } : { version: '0.0.1', services: {} });
  const confirm = async (lifecycle, confirmation) => {
    const handle = createIngressRoutes({
      stateStore: {}, jobRunner: {}, recordAdminAudit: () => {}, executionBlockOutcome: () => 'blocked-auth',
      sendJson: (res, status, payload) => Object.assign(res, { status, payload }),
      parseBody: async () => ({ hostNodeId: 'nSelf' }),
      controlFactory: (options) => createIngressControl({ ...options, cli }),
      apiFactory: () => null,
      requireAdmin: async () => ({ ok: true, ...(confirmation ? { confirmation } : {}) }),
      lifecycleState: () => lifecycle,
    });
    const res = {};
    await handle({ req: {}, res, method: 'POST', pathname: '/api/ingress/services/pulse/confirm', config: { instance: 'smith', defaultDomain: 'example-tailnet.ts.net', dataDir }, state: {} });
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'ingress-confirmations.json'), 'utf8'))['svc:smith-pulse'].assurance;
  };
  assert.equal(await confirm('active', 'jti-1'), 'hardware-key');
  assert.equal(await confirm('setup'), 'passphrase-session');
  // Authorized in setup with the passphrase, finished after activation: still the passphrase.
  assert.equal(await confirm('active'), 'passphrase-session');
});

test('routes: a publish or cutover authorized in one state never starts in another', async (t) => {
  // Authorized in setup (where the passphrase is enough), activated while the route waited: no job, nothing claimed.
  for (const [pathname, body, at] of [['/api/ingress/services/homebase/publish', { confirm: 'PUBLISH' }, 1], ['/api/ingress/services/homebase/publish', { confirm: 'PUBLISH' }, 2], ['/api/ingress/cutover', { confirm: 'CUTOVER' }, 1]]) {
    let reads = 0;
    const { post, jobs } = await routes(t, { lifecycle: () => (reads++ < at ? 'setup' : 'active'), actions: ['install', 'service-publish', 'ingress-cutover'] });
    const answer = await post(pathname, body);
    assert.equal(answer.body.code, 'STATE_CHANGED', `${pathname} after ${at}: ${JSON.stringify(answer.body)}`);
    assert.equal(jobs.length, 0);
  }
  // Unchanged, it starts.
  const steady = await routes(t, { lifecycle: 'setup', actions: ['install', 'service-publish'] });
  assert.equal((await steady.post('/api/ingress/services/homebase/publish', { confirm: 'PUBLISH' })).status, 202);
});

test('the job runner records local mode when the switch completes, and the record survives updates', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-mode-'));
  const store = new SqliteStateStore(path.join(dir, 'state.sqlite3'));
  store.init();
  const record = { appId: 'family-plan', name: 'Family Plan', port: 3001, mountPath: '/plan/', externalUrl: 'https://host/plan/', installRoot: '/opt/sovereign-home/apps/familyPlan', serviceName: 'family-plan', ref: 'main', status: 'installed', plannedAt: 'x', updatedAt: 'x', managedBy: 'executor' };
  store.upsertInstallation(record);
  assert.equal(store.loadState().installations['family-plan'].identityMode, 'local');
  store.setIdentityMode('family-plan', 'tailnet');
  store.upsertInstallation({ ...record, ref: 'abc', updatedAt: 'y' });
  assert.equal(store.loadState().installations['family-plan'].identityMode, 'tailnet', 'an update keeps it');
  assert.throws(() => store.setIdentityMode('family-plan', 'headers'));

  const runner = new JobRunner(store, {
    runExecutorAction: async (_socket, _fields, { onEvent }) => { onEvent({ eventType: 'plan.accepted', planDigest: 'x', plan: { operations: [] } }); return {}; },
    readinessOptions: { attempts: 1, fetchImpl: async () => ({ ok: true, status: 200 }) },
  });
  const id = runner.startTypedActionJob({ kind: 'identity-mode', target: 'family-plan', action: { action: 'identity-mode', appId: 'family-plan', mode: 'local' } });
  for (let i = 0; i < 50 && store.getJob(id).status !== 'completed'; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.getJob(id).status, 'completed');
  assert.equal(store.loadState().installations['family-plan'].identityMode, 'local');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});
