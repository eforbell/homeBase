// Feature-10 SID-006 slice 2: in active Home Base, every privileged plan runs only with the administrator's
// every-time hardware confirmation for exactly that plan and request, used once. Plans run against a fake
// executor that records what it was asked to do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createExecutorServer } = require('../executor/server');
const { MATRIX } = require('../src/route-matrix');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { verifyPassphrase } = require('../src/admin-auth');
const { PASSPHRASE, PEER_WHOIS, activeHousehold } = require('./support/household');

const APP = 'home-source';
const BACKUPS = '/var/lib/sovereign-home/backups/home-source';

// An active household on an executor host, with Home Source installed and one backup.
async function executorHousehold(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-plans-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, 'e.sock');
  const received = [];
  const executor = createExecutorServer({ logger: { info() {} }, mutationsEnabled: true, runAction: async (spec) => { received.push(spec); return { completedOperationIds: [] }; } });
  await new Promise((resolve) => executor.listen(socket, resolve));
  t.after(() => new Promise((resolve) => executor.close(resolve)));
  // Home Base reaches the executor through a pass-through the test can hold, to land something mid-plan.
  const front = path.join(dir, 'front.sock');
  let held = null;
  const open = new Set();
  const track = (sock) => { open.add(sock); sock.on('close', () => open.delete(sock)); return sock; };
  const proxy = net.createServer((client) => {
    track(client);
    Promise.resolve(held?.promise).then(() => { const upstream = track(net.connect(socket)); client.pipe(upstream).pipe(client); });
  });
  await new Promise((resolve) => proxy.listen(front, resolve));
  // A failed assertion can leave a plan's connection open; teardown cuts it rather than waiting on it.
  t.after(() => new Promise((resolve) => { held?.release(); for (const sock of open) sock.destroy(); proxy.close(resolve); }));
  const hold = () => { let release; held = { promise: new Promise((resolve) => { release = resolve; }), release: () => release() }; return () => { held = null; release(); }; };
  const household = await activeHousehold(t, { config: { homeBaseExecutionMode: 'executor', homeBaseEnablePrivilegedJobs: true, homeBaseExecutorSocket: front, jobRunnerOptions: { reconcile: { intervalMs: 20, maxWaitMs: 10_000, unknownGraceMs: 200 }, readinessOptions: { attempts: 1, delayMs: 10 }, busyRetry: { attempts: 1, delayMs: 10 } } } });
  const store = new SqliteStateStore(path.join(household.root, 'state.sqlite3'));
  store.upsertInstallation({ appId: APP, name: 'Home Source', purpose: 'x', port: 3008, mountPath: '/source/', externalUrl: 'https://homebase.tailnet/source/', installRoot: '/opt/sovereign-home/apps/homeSource', serviceName: APP, ref: 'main', status: 'installed', plannedAt: '2026-04-03T00:00:00.000Z', updatedAt: '2026-04-03T00:00:00.000Z' });
  const backup = (name) => store.recordBackup({ appId: APP, archiveDir: `${BACKUPS}/${name}`, generatedAt: '2026-09-24T10:10:10.123Z', dryRun: false, status: 'completed', includedFiles: [], jobId: null, createdAt: '2026-09-24T10:10:11.000Z' });
  backup('20260924T101010123Z');
  return { ...household, received, backup, store, hold };
}

const REAL = { dryRun: false, confirm: 'EXECUTE' };

// Waits for a started job to finish (the runner polls the fake executor quickly here), so nothing is still
// running when the test's files are removed. Returns what the executor was asked to do for action.
async function ran({ received, store }, jobId, action) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (['completed', 'failed'].includes(store.getJob(jobId)?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return received.filter((spec) => spec.action === action);
}

// The words each real run is confirmed with, besides dryRun: false.
const realBody = (entry) => (entry.path === '/api/homebase/config' ? { householdTimezone: 'America/New_York' } : {
  ...REAL,
  ...({ '/api/ingress/cutover': { confirm: 'CUTOVER' }, '/api/ingress/rollback': { confirm: 'ROLLBACK' }, '/api/ingress/services/:id/publish': { confirm: 'PUBLISH' }, '/api/apps/:id/move-user/execute': { confirm: 'MOVE' }, '/api/ingress/apps/:id/tailnet-mode': { confirm: 'TAILNET' }, '/api/ingress/apps/:id/local-mode': { confirm: 'LOCAL' } }[entry.path] || {}),
});
const sample = (entry) => entry.path.replace(':id', entry.path.startsWith('/api/ingress/services') ? 'homebase' : APP);
// The routes whose confirmation this slice adds: the passkey service's own and the passphrase's have theirs.
const plans = MATRIX.filter((entry) => entry.policy === 'privileged-plan' && entry.authority === 'session' && entry.path !== '/api/admin/rotate');

test('every privileged plan asks the unlocked administrator for the hardware key, for that plan and request', async (t) => {
  const { parent } = await executorHousehold(t);
  assert.ok(plans.length >= 15, `only ${plans.length} privileged plans`);
  const cannotRun = [];
  for (const entry of plans) {
    const url = sample(entry);
    const res = await parent.post(url, realBody(entry));
    // A plan this host can't run at all (not converted to the executor yet, or replaced by per-service
    // publishing after the cutover) is refused before it could run.
    if (['TYPED_EXECUTION_NOT_SUPPORTED', 'INGRESS_CUT_OVER', 'ADOPT_NOT_APPLICABLE'].includes(res.body.code)) {
      cannotRun.push(url);
      continue;
    }
    assert.equal(res.status, 401, `${url}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'step_up_required', url);
    assert.equal(res.body.policy, 'privileged-plan');
    assert.equal(res.body.kind, 'hardware');
    assert.match(res.body.target, new RegExp(`^POST ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} settings [A-Za-z0-9_-]{16} installs [A-Za-z0-9_-]{16}`), `${url}: target ${res.body.target}`);
    assert.match(res.body.digest, /^[A-Za-z0-9_-]{43}$/);
    assert.match(res.body.message, /^Confirm with your hardware key to /);
  }
  assert.ok(cannotRun.length <= 3, `most plans run on an executor host; these can't: ${cannotRun.join(', ')}`);
});

test('a confirmation runs exactly one plan: once, for that request, from a hardware key', async (t) => {
  const household = await executorHousehold(t);
  const { parent, phone, yubikey } = household;
  const url = `/api/apps/${APP}/restart/execute`;
  const dry = await parent.post(url, { dryRun: true });
  assert.notEqual(dry.status, 401, 'a dry run changes nothing and asks for nothing');

  assert.equal((await parent.confirmed(phone, url, REAL)).token, null, 'a synced passkey does not confirm a privileged plan');
  const run = await parent.confirmed(yubikey, url, REAL);
  assert.equal(run.first.body.message, 'Confirm with your hardware key to restart Home Source.');
  assert.equal(run.retry.status, 202, JSON.stringify(run.retry.body));
  assert.equal((await ran(household, run.retry.body.jobId, 'restart')).length, 1);

  const again = await parent.post(url, REAL, { 'x-sovereign-action-token': run.token });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'REPLAYED');
  const fresh = await parent.actionToken(yubikey, (await parent.post(url, REAL)).body);
  const changed = await parent.post(url, { ...REAL, note: 'something else' }, { 'x-sovereign-action-token': fresh.body.token });
  assert.notEqual(changed.status, 202, 'a confirmation is for the request it was given for');
  assert.equal(changed.body.error, 'step_up_required');
  const backupUrl = `/api/apps/${APP}/backup/execute`;
  const otherPlan = await parent.actionToken(yubikey, (await parent.post(backupUrl, REAL)).body);
  assert.equal((await parent.post(url, REAL, { 'x-sovereign-action-token': otherPlan.body.token })).body.error, 'step_up_required', 'nor another plan');
});

test('restore freezes "latest" to the backup it names: a newer backup before the retry refuses the retry', async (t) => {
  const household = await executorHousehold(t);
  const { parent, yubikey, backup, received } = household;
  const url = `/api/apps/${APP}/restore/execute`;
  const asked = await parent.post(url, REAL);
  assert.match(asked.body.target, new RegExp(`^POST ${url} settings [A-Za-z0-9_-]{16} installs [A-Za-z0-9_-]{16} backup 20260924T101010123Z$`));
  const token = await parent.actionToken(yubikey, asked.body);
  backup('20260925T090000000Z');
  const retried = await parent.post(url, REAL, { 'x-sovereign-action-token': token.body.token });
  assert.equal(retried.status, 401, 'the confirmed plan is not the one that would run now');
  assert.match(retried.body.target, /backup 20260925T090000000Z$/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received.filter((spec) => spec.action === 'restore').length, 0, 'nothing ran');

  const run = await parent.confirmed(yubikey, url, REAL);
  assert.equal(run.retry.status, 202, JSON.stringify(run.retry.body));
  const [restore] = await ran(household, run.retry.body.jobId, 'restore');
  assert.ok(restore, JSON.stringify(received.map((spec) => spec.action)));
  assert.equal(restore.backupId, '20260925T090000000Z', 'the newer backup, which was confirmed');
});

test('changing the admin passphrase takes the hardware key, asked after the passphrases are checked', async (t) => {
  const { parent, yubikey } = await executorHousehold(t);
  const wrong = await parent.post('/api/admin/rotate', { currentPassphrase: 'not it at all', newPassphrase: 'a new passphrase' });
  assert.equal(wrong.status, 403, 'a mistyped passphrase spends nothing');
  const run = await parent.confirmed(yubikey, '/api/admin/rotate', { currentPassphrase: PASSPHRASE, newPassphrase: 'a new passphrase' });
  assert.equal(run.first.status, 401);
  assert.equal(run.first.body.message, 'Confirm with your hardware key to change the admin passphrase.');
  assert.equal(run.retry.status, 200, JSON.stringify(run.retry.body));
});

test('a legacy host freezes "latest" too: the archive it plans now is the one confirmed', async (t) => {
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-legacy-backups-'));
  t.after(() => fs.rmSync(backups, { recursive: true, force: true }));
  const archive = (name) => fs.mkdirSync(path.join(backups, APP, name), { recursive: true });
  archive('20260924T101010123Z');
  const { parent, yubikey, root } = await activeHousehold(t, { config: { homeBaseExecutionMode: 'legacy-sudo', homeBaseEnablePrivilegedJobs: true, baseBackupDir: backups } });
  const store = new SqliteStateStore(path.join(root, 'state.sqlite3'));
  store.upsertInstallation({ appId: APP, name: 'Home Source', purpose: 'x', port: 3008, mountPath: '/source/', externalUrl: 'https://homebase.tailnet/source/', installRoot: '/opt/sovereign-home/apps/homeSource', serviceName: APP, ref: 'main', status: 'installed', plannedAt: '2026-04-03T00:00:00.000Z', updatedAt: '2026-04-03T00:00:00.000Z' });
  const url = `/api/apps/${APP}/restore/execute`;
  const asked = await parent.post(url, REAL);
  assert.ok(asked.body.target.endsWith(` backup ${path.join(backups, APP, '20260924T101010123Z')}`), asked.body.target);
  const token = await parent.actionToken(yubikey, asked.body);
  archive('20260925T090000000Z');
  // Refused before anything could run (on a host where it could, the preflight would come next).
  const retried = await parent.post(url, REAL, { 'x-sovereign-action-token': token.body.token });
  assert.equal(retried.status, 401, JSON.stringify(retried.body));
  assert.ok(retried.body.target.endsWith(` backup ${path.join(backups, APP, '20260925T090000000Z')}`), retried.body.target);
});

test('a setting that can\'t be saved is refused before the hardware key is asked for', async (t) => {
  const { parent, yubikey } = await executorHousehold(t);
  const bad = await parent.post('/api/homebase/config', { hostname: 'not a hostname!' });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  const good = await parent.confirmed(yubikey, '/api/homebase/config', { householdTimezone: 'America/New_York' });
  assert.equal(good.first.status, 401);
  assert.equal(good.retry.status, 200, JSON.stringify(good.retry.body));
});

test('a plan resolved when it runs is confirmed resolved: a setting that changes before the retry refuses it', async (t) => {
  const household = await executorHousehold(t);
  const { parent, yubikey, received, store } = household;
  const url = `/api/apps/${APP}/execute`;
  const asked = await parent.post(url, REAL);
  assert.equal(asked.status, 401, JSON.stringify(asked.body));
  assert.match(asked.body.target, new RegExp(`^POST ${url} settings [A-Za-z0-9_-]{16} installs [A-Za-z0-9_-]{16} plan [A-Za-z0-9_-]{22}$`));
  const token = await parent.actionToken(yubikey, asked.body);
  // The install's site values come from the settings, which change between the tap and the retry.
  store.setHomeBaseConfig({ hostname: 'otherhost', domain: 'example-tailnet.ts.net', gitTransport: 'https', gitSshKeyPath: '', healthAlertsEnabled: false, healthAlertsWebhookUrl: '', tailscaleManagedServiceId: 'svc:home', updatedAt: new Date().toISOString() });
  const retried = await parent.post(url, REAL, { 'x-sovereign-action-token': token.body.token });
  assert.equal(retried.status, 401, 'the confirmed install is not the one that would run now');
  assert.notEqual(retried.body.target, asked.body.target);

  const run = await parent.confirmed(yubikey, url, REAL);
  assert.equal(run.retry.status, 202, JSON.stringify(run.retry.body));
  const [install] = await ran(household, run.retry.body.jobId, 'install');
  assert.equal(install.site.hostname, 'otherhost', 'the install that was confirmed');
  assert.equal(received.filter((spec) => spec.action === 'install').length, 1);
});

test('a plan whose Home Base leaves active while it resolves is refused, not run unconfirmed', async (t) => {
  const { parent, received, hold } = await executorHousehold(t);
  const release = hold();
  const pending = parent.post(`/api/apps/${APP}/execute`, REAL);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  release();
  const answer = await pending;
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.equal(answer.body.code, 'BOOTSTRAP_INCOMPLETE');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(received.filter((spec) => spec.action === 'install').length, 0, 'nothing ran');
});

test('a legacy plan built from an installation record is confirmed with it: a changed install root refuses the retry', async (t) => {
  const { parent, yubikey, root } = await activeHousehold(t, { config: { homeBaseExecutionMode: 'legacy-sudo', homeBaseEnablePrivilegedJobs: true } });
  const store = new SqliteStateStore(path.join(root, 'state.sqlite3'));
  const record = (installRoot) => store.upsertInstallation({ appId: 'family-help', name: 'Family Help', purpose: 'x', port: 3010, mountPath: '/help/', externalUrl: 'https://homebase.tailnet/help/', installRoot, serviceName: 'family-help', ref: 'main', status: 'planned', plannedAt: '2026-04-03T00:00:00.000Z', updatedAt: '2026-04-03T00:00:00.000Z' });
  record('/opt/confirmed/familyHelp');
  const url = '/api/apps/family-help/uninstall/execute';
  const asked = await parent.post(url, REAL);
  assert.equal(asked.status, 401, JSON.stringify(asked.body));
  const token = await parent.actionToken(yubikey, asked.body);
  // What the open install route can do with only the session: point the record somewhere else.
  record('/opt/unconfirmed/familyHelp');
  const retried = await parent.post(url, REAL, { 'x-sovereign-action-token': token.body.token });
  assert.equal(retried.status, 401, JSON.stringify(retried.body));
  assert.notEqual(retried.body.target, asked.body.target);
});

test('a legacy plan built from the settings is confirmed with them: a change before the retry refuses it', async (t) => {
  const { parent, yubikey, root } = await activeHousehold(t, { config: { homeBaseExecutionMode: 'legacy-sudo', homeBaseEnablePrivilegedJobs: true } });
  const store = new SqliteStateStore(path.join(root, 'state.sqlite3'));
  const url = '/api/apps/family-help/execute';
  const asked = await parent.post(url, REAL);
  assert.equal(asked.status, 401, JSON.stringify(asked.body));
  const token = await parent.actionToken(yubikey, asked.body);
  store.setHomeBaseConfig({ hostname: 'homebase', domain: 'example-tailnet.ts.net', gitTransport: 'ssh', gitSshKeyPath: '/etc/sovereign-home/other-key', healthAlertsEnabled: false, healthAlertsWebhookUrl: '', tailscaleManagedServiceId: 'svc:home', updatedAt: new Date().toISOString() });
  // Refused before anything could run (on a host where it could, the preflight would come next).
  const retried = await parent.post(url, REAL, { 'x-sovereign-action-token': token.body.token });
  assert.equal(retried.status, 401, JSON.stringify(retried.body));
  assert.notEqual(retried.body.target, asked.body.target);
});

test('a passphrase rotated while another rotation waits on its confirmation is not overwritten by that stale check', async (t) => {
  // Holds the armed lookup until released: a rotate's retry makes three, the last its confirmation's.
  const gate = { armed: false, skip: 0 };
  const whois = async (addr) => {
    if (gate.armed && gate.skip-- === 0) {
      gate.armed = false;
      gate.reached();
      await gate.released;
    }
    return PEER_WHOIS(addr);
  };
  const { parent, yubikey, root } = await activeHousehold(t, { whois });
  const rotate = (newPassphrase) => ({ currentPassphrase: PASSPHRASE, newPassphrase });
  const askA = await parent.post('/api/admin/rotate', rotate('passphrase from rotation A'));
  const tokenA = await parent.actionToken(yubikey, askA.body);
  let release;
  const reached = new Promise((resolve) => { gate.reached = resolve; });
  gate.released = new Promise((resolve) => { release = resolve; });
  Object.assign(gate, { armed: true, skip: 2 });
  const pendingA = parent.post('/api/admin/rotate', rotate('passphrase from rotation A'), { 'x-sovereign-action-token': tokenA.body.token });
  await reached;
  const b = await parent.confirmed(yubikey, '/api/admin/rotate', rotate('passphrase from rotation B'));
  assert.equal(b.retry.status, 200, JSON.stringify(b.retry.body));
  release();
  const a = await pendingA;
  assert.equal(a.status, 409, JSON.stringify(a.body));
  assert.equal(a.body.code, 'PASSPHRASE_CHANGED');
  const stored = new SqliteStateStore(path.join(root, 'state.sqlite3')).getAdminCredential();
  assert.ok(verifyPassphrase('passphrase from rotation B', stored.passphraseHash), 'rotation B stands');
});
