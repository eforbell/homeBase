const test = require('node:test');
const assert = require('node:assert/strict');
const { createBaseHandlers, renderManagedFile, renderAppEnvFile } = require('../executor/handlers');
const { isApprovedBinary } = require('../executor/spawn');
const { createFakeFs } = require('./fixtures/fake-fs');
const { appLayout } = require('../src/operations/app-layout');
const { getAppById } = require('../src/catalog');
const { buildAppInstallPlan } = require('../src/operations/compilers/install');
const { validateOperationPolicy } = require('../src/operations/policy');
const env = require('../src/operations/env');
const { compileAction, generateSecretBindings } = require('../executor/actions');

// Catalog shapes beyond the first two apps: Python runtimes, in-checkout storage, reserved sidecar
// ports, sidecars published through nginx, mount-path-preserving proxying, schema-file bootstrap,
// and the household timezone on every process unit.

const getLayout = (id) => appLayout(getAppById(id));
const HELM = getLayout('helm');
const BITCOIN = appLayout(getAppById('bitcoin-accounting'));
const BUGS = appLayout(getAppById('bug-base'));
const PULSE = appLayout(getAppById('family-pulse'));
const HELP = appLayout(getAppById('family-help'));
const SOVEREIGN = { uid: 1001, gid: 1002 };
const HELM_ROOT = '/opt/sovereign-home/apps/helm';
const SITE = { hostname: 'homebase', domain: 'tailnet', householdTimezone: 'America/New_York' };

function base(type, fields = {}) {
  return { id: 'test-op', type, title: 'test', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields };
}
function unit(layout, template, name, timezone = 'America/New_York') {
  return renderManagedFile(base('filesystem.write-managed-file', { purpose: 'systemd-unit', template, unit: name, ...(timezone ? { timezone } : {}) }), { layout }).content;
}
const snippet = (layout) => renderManagedFile(base('filesystem.write-managed-file', { purpose: 'nginx-snippet', template: 'app-nginx-v1' }), { layout }).content;

test('process units run in the household timezone; timer units carry no environment', () => {
  const service = unit(getLayout('family-dinner'), 'app-service-v1', 'family-dinner.service', 'America/Chicago');
  assert.match(service, /^Environment=TZ=America\/Chicago$/m);
  assert.throws(() => unit(getLayout('family-dinner'), 'app-service-v1', 'family-dinner.service', null), /timezone/);
  assert.throws(() => unit(getLayout('family-dinner'), 'app-service-v1', 'family-dinner.service', 'UTC\nExecStartPre=/bin/sh'), /timezone/);
  assert.doesNotMatch(unit(HELM, 'app-timer-v1', 'helm-sync.timer', null), /Environment=/);
});


test('helm: venv argv under the checkout, PYTHONUNBUFFERED from the unit, schedules carried over exactly', () => {
  const service = unit(HELM, 'app-service-v1', 'helm-web.service');
  assert.match(service, /^ExecStart=\/opt\/sovereign-home\/apps\/helm\/\.venv\/bin\/uvicorn schwab_helm\.web\.app:create_app --factory --host 127\.0\.0\.1 --port 3011$/m);
  assert.match(service, /^Environment=PYTHONUNBUFFERED=1$/m);
  assert.match(service, /^UMask=0077$/m);
  assert.doesNotMatch(service, /EnvironmentFile=/);
  assert.match(unit(HELM, 'app-timer-service-v1', 'helm-token-refresh.service'), /^ExecStart=\/opt\/sovereign-home\/apps\/helm\/\.venv\/bin\/helm refresh-token$/m);
  assert.match(unit(HELM, 'app-timer-v1', 'helm-sync.timer', null), /^OnCalendar=Mon\.\.Fri 08:00 America\/New_York$/m);
  assert.match(unit(HELM, 'app-timer-v1', 'helm-monitor.timer', null), /^Persistent=false$/m);
  assert.deepEqual(HELM.migrationArgv, [`${HELM_ROOT}/.venv/bin/python`, 'migrations/run_migration.py']);
  assert.deepEqual(HELM.packages, ['python3', 'python3-venv']);
  // Node units never get the Python setting.
  assert.doesNotMatch(unit(getLayout('family-dinner'), 'app-service-v1', 'family-dinner.service'), /PYTHONUNBUFFERED/);
});

test('mount-path-preserving apps proxy without a URI; others strip the mount path', () => {
  assert.match(snippet(HELM), /^ {4}proxy_pass http:\/\/127\.0\.0\.1:3011;$/m);
  assert.match(snippet(BITCOIN), /^ {4}proxy_pass http:\/\/127\.0\.0\.1:3010;$/m);
  assert.match(snippet(PULSE), /^ {4}proxy_pass http:\/\/127\.0\.0\.1:3003\/;$/m);
});

test('bug-base publishes its MCP sidecar at its reserved port under the app mount path, like legacy', () => {
  const content = snippet(BUGS);
  assert.match(content, /location \/bugs\/ \{\n {4}client_max_body_size 12M;\n {4}proxy_pass http:\/\/127\.0\.0\.1:3005\/;/);
  assert.match(content, /location = \/bugs\/mcp \{\n {4}return 301 \/bugs\/mcp\/;/);
  assert.match(content, /location \/bugs\/mcp\/ \{\n {4}proxy_pass http:\/\/127\.0\.0\.1:3006\/mcp\/;/);
  assert.match(content, /X-Forwarded-Prefix \/bugs\/mcp;/);
  // Same upstreams erebor's legacy snippets serve today.
  const { buildInstallPlan } = require('../src/services/install-planner');
  const legacy = buildInstallPlan({ appId: 'bug-base', state: { installations: {} }, options: {}, config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/tmp/none', defaultHostname: 'homebase', defaultDomain: 'tailnet' } });
  assert.match(legacy.files['bug-base-mcp.nginx.conf'], /proxy_pass http:\/\/127\.0\.0\.1:3006\/mcp\/;/);
});

test('reserved sidecar ports reach the env; bitcoin-accounting gets its PG* wiring from the password', () => {
  const pulse = env.parseDotEnv(renderAppEnvFile({ layout: PULSE, password: 'pulse-password', site: SITE, fsImpl: createFakeFs() }));
  assert.equal(pulse.MCP_PORT, '3004');
  const bitcoin = env.parseDotEnv(renderAppEnvFile({ layout: BITCOIN, password: 'btc-password', site: SITE, fsImpl: createFakeFs() }));
  assert.deepEqual([bitcoin.PGUSER, bitcoin.PGPASSWORD, bitcoin.PGDATABASE, bitcoin.DB_BACKEND], ['bitcoin_accountant', 'btc-password', 'bitcoin_accounting', 'postgres']);
  assert.equal(bitcoin.BITCOIN_ACCOUNTING_WEB_BASE_PATH, '/bitcoin-accounting');
  assert.equal('NODE_ENV' in bitcoin, false);
  const helm = env.parseDotEnv(renderAppEnvFile({ layout: HELM, password: 'helm-password', site: SITE, fsImpl: createFakeFs() }));
  assert.equal(helm.HELM_DATABASE_URL, 'postgresql://helm:helm-password@127.0.0.1:5432/helm');
  assert.equal(helm.HELM_WEB_BASE_PATH, '/helm');
});

test('in-checkout storage is created after the clone, as sovereign, 0700, and never through a symlink', async () => {
  const plan = buildAppInstallPlan({ appId: 'helm' });
  const ids = plan.operations.map((operation) => operation.id);
  assert.ok(ids.indexOf('sync-repository') < ids.indexOf('ensure-storage-1'), 'git clones only into an empty directory');
  assert.equal(ids.includes('ensure-storage-root'), false);
  assert.equal(plan.operations.find((operation) => operation.id === 'ensure-storage-1').purpose, 'app-checkout-storage');

  const fsImpl = createFakeFs({ [HELM_ROOT]: { kind: 'dir', uid: 1001 } });
  const identities = [];
  const asUser = (user, fn) => { identities.push(user); return fn(); };
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN, asUser });
  await handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-checkout-storage', subpath: '.secrets' }), { layout: HELM });
  assert.equal(fsImpl.entries.get(`${HELM_ROOT}/.secrets`).mode, 0o700);
  assert.deepEqual(identities, [SOVEREIGN]);
  // Re-running is a no-op that re-asserts the mode.
  await handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-checkout-storage', subpath: '.secrets' }), { layout: HELM });

  const planted = createFakeFs({ [`${HELM_ROOT}/.secrets`]: { kind: 'link', target: '/etc' } });
  const plantedHandlers = createBaseHandlers({ fsImpl: planted, lookupUser: () => SOVEREIGN, asUser });
  await assert.rejects(() => plantedHandlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-checkout-storage', subpath: '.secrets' }), { layout: HELM }), /not a real directory/);
  await assert.rejects(() => handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-checkout-storage', subpath: 'uploads' }), { layout: HELM }), (error) => error.code === 'POLICY_DENIED');
  await assert.rejects(() => handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-checkout-storage', subpath: 'uploads' }), { layout: getLayout('home-source') }), (error) => error.code === 'POLICY_DENIED');
});

test('backups archive in-checkout storage under the legacy archive names', async () => {
  const { createLifecycleHandlers } = require('../executor/lifecycle-handlers');
  const calls = [];
  const fsImpl = createFakeFs({ '/var/lib/sovereign-home/backups': { kind: 'dir' }, [`${HELP.checkout}/uploads`]: { kind: 'dir', uid: 1001 }, [`${HELP.checkout}/.env`]: 'DATABASE_URL=postgresql://familyhelp:pw-12345678@127.0.0.1:5432/familyhelp\n' });
  const handlers = createLifecycleHandlers({ fsImpl, lookupUser: () => SOVEREIGN, asUser: (user, fn) => fn(), run: async (input) => { calls.push(input); return { stdout: '' }; }, now: () => new Date('2026-09-25T00:00:00Z') });
  const result = await handlers['backup.create'](base('backup.create', { archiveName: '20260925T000000Z' }), { layout: HELP });
  assert.match(result, /uploads\.tgz/);
  const tar = calls.find((call) => call.binary === '/usr/bin/tar');
  assert.deepEqual(tar.args, ['-C', HELP.checkout, '-czf', '/var/lib/sovereign-home/backups/family-help/20260925T000000Z/uploads.tgz', 'uploads']);
  assert.equal(tar.uid, 1001);
});

test('ensure-venv builds a venv once per interpreter and rebuilds it after a Python upgrade', async () => {
  const run = (version) => {
    const calls = [];
    return { calls, fn: async (input) => { calls.push(input); return { stdout: input.args[0] === '-c' ? `${version}\n` : '' }; } };
  };
  const task = base('runtime.run-app-task', { task: 'ensure-venv' });
  const fresh = createFakeFs({ [HELM_ROOT]: { kind: 'dir', uid: 1001 } });
  const first = run('3.12.3');
  await createBaseHandlers({ fsImpl: fresh, lookupUser: () => SOVEREIGN, asUser: (user, fn) => fn(), run: first.fn })['runtime.run-app-task'](task, { layout: HELM });
  assert.deepEqual(first.calls.map((call) => [call.binary, call.args, call.uid, call.cwd]), [
    ['/usr/bin/python3', ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], 1001, HELM_ROOT],
    ['/usr/bin/python3', ['-m', 'venv', '.venv'], 1001, HELM_ROOT],
  ]);

  const built = { [HELM_ROOT]: { kind: 'dir', uid: 1001 }, [`${HELM_ROOT}/.venv/pyvenv.cfg`]: 'home = /usr/bin\nversion = 3.12.3\n', [`${HELM_ROOT}/.venv/bin/python`]: { kind: 'link', target: '/usr/bin/python3' } };
  const same = run('3.12.3');
  const kept = await createBaseHandlers({ fsImpl: createFakeFs(built), lookupUser: () => SOVEREIGN, asUser: (user, fn) => fn(), run: same.fn })['runtime.run-app-task'](task, { layout: HELM });
  assert.match(kept, /ready/);
  assert.equal(same.calls.length, 1);

  // A patch upgrade keeps the venv: its bin/python links to /usr/bin/python3.
  const patched = run('3.12.9');
  assert.match(await createBaseHandlers({ fsImpl: createFakeFs(built), lookupUser: () => SOVEREIGN, asUser: (user, fn) => fn(), run: patched.fn })['runtime.run-app-task'](task, { layout: HELM }), /ready/);
  assert.equal(patched.calls.length, 1);

  // A minor upgrade rebuilds beside the old venv and swaps; the old one is removed only on success.
  const upgradedFs = createFakeFs(built);
  const upgraded = run('3.13.1');
  const rebuilt = await createBaseHandlers({ fsImpl: upgradedFs, lookupUser: () => SOVEREIGN, asUser: (user, fn) => fn(), run: upgraded.fn })['runtime.run-app-task'](task, { layout: HELM });
  assert.deepEqual(upgraded.calls.map((call) => [call.binary.split('/').pop(), ...call.args.slice(0, 3)]), [['python3', '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], ['python3', '-m', 'venv', '.venv'], ['python', '-m', 'pip', 'install'], ['python', '-m', 'pip', 'install']]);
  assert.match(rebuilt, /rebuilt virtualenv for Python 3\.13\.1 \(was 3\.12\.3\)/);
  assert.equal(upgradedFs.existsSync(`${HELM_ROOT}/.venv.previous`), false);

  // If pip fails (PyPI down), the previous venv comes back and the task fails.
  const rollbackFs = createFakeFs(built);
  const failingPip = async (input) => {
    if (input.args[0] === '-c') return { stdout: '3.13.1\n' };
    if (input.args.includes('pip')) throw Object.assign(new Error('pip: connection timed out'), { code: 'OPERATION_FAILED' });
    return { stdout: '' };
  };
  await assert.rejects(() => createBaseHandlers({ fsImpl: rollbackFs, lookupUser: () => SOVEREIGN, asUser: (user, fn) => fn(), run: failingPip })['runtime.run-app-task'](task, { layout: HELM }), /connection timed out/);
  assert.equal(rollbackFs.readFileSync(`${HELM_ROOT}/.venv/pyvenv.cfg`), 'home = /usr/bin\nversion = 3.12.3\n', 'the running app keeps its packages');
  assert.equal(rollbackFs.existsSync(`${HELM_ROOT}/.venv.previous`), false);
  await assert.rejects(() => createBaseHandlers({ fsImpl: fresh, lookupUser: () => SOVEREIGN, run: first.fn })['runtime.run-app-task'](task, { layout: getLayout('family-dinner') }), (error) => error.code === 'POLICY_DENIED');
});

test('Python dependencies install from the lockfile, then the checkout, as sovereign with fixed argv', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ fsImpl: createFakeFs({ [HELM_ROOT]: { kind: 'dir', uid: 1001 } }), lookupUser: () => SOVEREIGN, run: async (input) => { calls.push(input); return { stdout: '' }; } });
  await handlers['runtime.run-app-task'](base('runtime.run-app-task', { task: 'install-dependencies' }), { layout: HELM });
  const pip = [`${HELM_ROOT}/.venv/bin/python`, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--progress-bar', 'off', '--timeout', '30', '--retries', '2'];
  assert.deepEqual(calls.map((call) => [call.binary, ...call.args]), [[...pip, '-r', 'requirements.lock'], [...pip, '--no-deps', '-e', '.']]);
  assert.ok(calls.every((call) => call.uid === 1001 && call.cwd === HELM_ROOT && !('NODE_ENV' in call.env)));
  await handlers['runtime.run-app-task'](base('runtime.run-app-task', { task: 'migrate' }), { layout: HELM });
  assert.deepEqual([calls.at(-1).binary, calls.at(-1).args], [`${HELM_ROOT}/.venv/bin/python`, ['migrations/run_migration.py']]);
});

test('schema-file bootstrap runs once, as the app role, only on an empty database', async () => {
  const root = BITCOIN.checkout;
  const fsImpl = () => createFakeFs({ [root]: { kind: 'dir', uid: 1001 }, [`${root}/.env`]: 'DB_BACKEND=postgres\nPGUSER=bitcoin_accountant\nPGPASSWORD=btc-pass-1234\nPGDATABASE=bitcoin_accounting\n' });
  const task = base('runtime.run-app-task', { task: 'bootstrap-schema' });
  const attempt = async (objects) => {
    const calls = [];
    const result = await createBaseHandlers({ fsImpl: fsImpl(), lookupUser: () => SOVEREIGN, asUser: (user, fn) => fn(), run: async (input) => { calls.push(input); return { stdout: input.args.includes('-tA') ? `${objects}\n` : '' }; } })['runtime.run-app-task'](task, { layout: BITCOIN });
    return { calls, result };
  };
  const empty = await attempt(0);
  assert.deepEqual(empty.calls[0].args.slice(0, 6), ['-X', '--no-password', '-v', 'ON_ERROR_STOP=1', '-tA', '-c']);
  assert.deepEqual(empty.calls[1].args, ['-X', '--no-password', '-v', 'ON_ERROR_STOP=1', '-1', '-q', '-f', 'src/sql/tables.sql']);
  for (const call of empty.calls) {
    assert.equal(call.binary, '/usr/bin/psql');
    assert.equal(call.uid, 1001);
    assert.deepEqual([call.env.PGUSER, call.env.PGDATABASE, call.env.PGPASSWORD], ['bitcoin_accountant', 'bitcoin_accounting', 'btc-pass-1234']);
    assert.deepEqual(call.secrets, ['btc-pass-1234']);
  }
  const populated = await attempt(7);
  assert.equal(populated.calls.length, 1);
  assert.match(populated.result, /already has 7 objects/);
});

test('app interpreters and venv tools may run only as a non-root identity', () => {
  assert.equal(isApprovedBinary('/usr/bin/python3', 1001, 1002), true);
  assert.equal(isApprovedBinary('/usr/bin/python3', 0, 0), false);
  assert.equal(isApprovedBinary('/usr/bin/python3', 1001, 0), false);
  assert.equal(isApprovedBinary(`${HELM_ROOT}/.venv/bin/python`, 1001, 1002), true);
  assert.equal(isApprovedBinary(`${HELM_ROOT}/.venv/bin/python`, 0, 0), false);
  assert.equal(isApprovedBinary(`${HELM_ROOT}/.venv/bin/../../../../bin/sh`, 1001, 1002), false);
  assert.equal(isApprovedBinary('/opt/sovereign-home/apps/helm/node_modules/.bin/x', 1001, 1002), false);
  assert.equal(isApprovedBinary('/usr/bin/git', 0, 0), true);
});

test('policy binds unit timezones to the site, storage purposes to the layout, and Python-only tasks', () => {
  const plan = () => JSON.parse(JSON.stringify(buildAppInstallPlan({ appId: 'helm' })));
  const denied = (mutate) => { const next = plan(); mutate(next); assert.throws(() => validateOperationPolicy(next), (error) => error.code === 'POLICY_DENIED' || error.code === 'INVALID_REQUEST' || /schema/i.test(error.message)); };
  validateOperationPolicy(plan());
  denied((next) => { next.operations.find((op) => op.template === 'app-service-v1').timezone = 'Europe/Paris'; });
  denied((next) => { delete next.operations.find((op) => op.template === 'app-service-v1').timezone; });
  denied((next) => { next.operations.find((op) => op.template === 'app-timer-v1').timezone = 'America/New_York'; });
  denied((next) => { next.operations.find((op) => op.purpose === 'app-checkout-storage').purpose = 'app-storage'; });
  denied((next) => { next.operations.find((op) => op.purpose === 'app-checkout-storage').subpath = 'uploads'; });
  const dinner = JSON.parse(JSON.stringify(buildAppInstallPlan({ appId: 'family-dinner' })));
  dinner.operations.find((op) => op.id === 'install-runtime').task = 'ensure-venv';
  assert.throws(() => validateOperationPolicy(dinner), (error) => error.code === 'POLICY_DENIED');
  const noSchema = JSON.parse(JSON.stringify(buildAppInstallPlan({ appId: 'helm' })));
  noSchema.operations.find((op) => op.id === 'install-runtime').task = 'bootstrap-schema';
  assert.throws(() => validateOperationPolicy(noSchema), (error) => error.code === 'POLICY_DENIED');
});

test('files read inside sovereign directories refuse symlinks, non-files, and oversized content', () => {
  const { readSmallFileNoFollow } = require('../executor/handlers');
  const fsImpl = createFakeFs({ '/app/.env': 'A=1\n', '/app/link': { kind: 'link', target: '/etc/shadow' }, '/app/dir': { kind: 'dir' }, '/app/big': 'x'.repeat(5000) });
  assert.equal(readSmallFileNoFollow(fsImpl, '/app/.env'), 'A=1\n');
  assert.equal(readSmallFileNoFollow(fsImpl, '/app/link'), null);
  assert.equal(readSmallFileNoFollow(fsImpl, '/app/dir'), null);
  assert.equal(readSmallFileNoFollow(fsImpl, '/app/missing'), null);
  assert.throws(() => readSmallFileNoFollow(fsImpl, '/app/big', 4096), (error) => error.code === 'POLICY_DENIED');
});

test('root-managed storage purposes are refused for apps whose storage lives in the checkout', async () => {
  const handlers = createBaseHandlers({ fsImpl: createFakeFs({ [HELM_ROOT]: { kind: 'dir', uid: 1001 } }), lookupUser: () => SOVEREIGN });
  for (const fields of [{ purpose: 'app-storage-root' }, { purpose: 'app-storage', subpath: '.secrets' }]) {
    await assert.rejects(() => handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', fields), { layout: HELM }), /keeps its storage in the checkout/);
  }
});

test('app tasks re-check the checkout before every spawn, and refuse unexpected probe output', async () => {
  const fsImpl = createFakeFs({ [HELM_ROOT]: { kind: 'dir', uid: 1001 } });
  let spawns = 0;
  const run = async () => {
    spawns += 1;
    // After the first pip call, sovereign swaps the checkout for a symlink.
    fsImpl.entries.set(HELM_ROOT, { kind: 'link', target: '/root', uid: 1001, gid: 1002, mode: 0o777 });
    return { stdout: '' };
  };
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN, run });
  await assert.rejects(() => handlers['runtime.run-app-task'](base('runtime.run-app-task', { task: 'install-dependencies' }), { layout: HELM }), /not a sovereign-owned directory/);
  assert.equal(spawns, 1);
  const noisy = createBaseHandlers({ fsImpl: createFakeFs({ [HELM_ROOT]: { kind: 'dir', uid: 1001 } }), lookupUser: () => SOVEREIGN, asUser: (user, fn) => fn(), run: async () => ({ stdout: 'x'.repeat(70000) }) });
  await assert.rejects(() => noisy['runtime.run-app-task'](base('runtime.run-app-task', { task: 'ensure-venv' }), { layout: HELM }), /system Python version/);
});

test('supported hosts: Ubuntu 22.04+, Debian 12+, and derivatives by their base codename', () => {
  const { hostSupport } = require('../src/operations/host-support');
  const os = (fields) => Object.entries(fields).map(([key, value]) => `${key}="${value}"`).join('\n');
  // numenor: Linux Mint 21.3 on Ubuntu 22.04 (jammy).
  assert.deepEqual(hostSupport(os({ ID: 'linuxmint', ID_LIKE: 'ubuntu debian', VERSION_ID: '21.3', UBUNTU_CODENAME: 'jammy', PRETTY_NAME: 'Linux Mint 21.3' })), { supported: true, base: 'ubuntu 22.04', name: 'Linux Mint 21.3' });
  assert.equal(hostSupport(os({ ID: 'ubuntu', VERSION_ID: '24.04' })).supported, true);
  assert.equal(hostSupport(os({ ID: 'ubuntu', VERSION_ID: '22.04' })).supported, true);
  assert.equal(hostSupport(os({ ID: 'ubuntu', VERSION_ID: '20.04' })).supported, false);
  assert.equal(hostSupport(os({ ID: 'debian', VERSION_ID: '12' })).supported, true);
  assert.equal(hostSupport(os({ ID: 'debian', VERSION_ID: '11' })).supported, false);
  assert.equal(hostSupport(os({ ID: 'linuxmint', ID_LIKE: 'ubuntu debian', UBUNTU_CODENAME: 'focal' })).supported, false);
  assert.equal(hostSupport(os({ ID: 'fedora', VERSION_ID: '40' })).supported, false);
});

test('git sync ignores untracked files when deciding whether a checkout is dirty', async () => {
  const calls = [];
  const fsImpl = createFakeFs({ [`${HELM_ROOT}/.git`]: { kind: 'dir', uid: 1001 }, '/etc/sovereign-home': { kind: 'dir' }, [HELM.mirror]: { kind: 'dir' } });
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN, run: async (input) => { calls.push(input); return { stdout: '' }; } });
  await handlers['git.sync'](base('git.sync', { repository: HELM.repositories.https, ref: 'main' }), { layout: HELM });
  assert.ok(calls.some((call) => call.args.join(' ') === `-C ${HELM_ROOT} status --porcelain --untracked-files=no`));
});

test('ensure-venv refuses a host Python older than the app requires, before building anything', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ fsImpl: createFakeFs({ [HELM_ROOT]: { kind: 'dir', uid: 1001 } }), lookupUser: () => SOVEREIGN, asUser: (user, fn) => fn(), run: async (input) => { calls.push(input); return { stdout: '3.10.12\n' }; } });
  await assert.rejects(() => handlers['runtime.run-app-task'](base('runtime.run-app-task', { task: 'ensure-venv' }), { layout: HELM }), /Helm needs Python 3\.11 or newer; this host has 3\.10\.12/);
  assert.equal(calls.length, 1, 'only the version probe ran');
  assert.equal(BITCOIN.runtime.python.minVersion, '3.10');
});

test("home-drop: engine 'none' compiles to an install with no PostgreSQL steps, no database secret, and backed-up storage", () => {
  const DROP = getLayout('home-drop');
  assert.equal(DROP.database, null);
  assert.equal(DROP.migrationArgv, null);
  assert.deepEqual(DROP.storage, { root: '/opt/sovereign-home/apps/homeDrop', subpaths: ['shares'], inCheckout: true });
  const { plan } = compileAction({ action: 'install', appId: 'home-drop', ref: 'main', transport: 'https', site: SITE });
  const types = plan.operations.map((operation) => operation.type);
  assert.equal(types.some((type) => type.startsWith('postgres.')), false, types.join(', '));
  assert.deepEqual(generateSecretBindings(plan), {});
  assert.doesNotMatch(unit(DROP, 'app-service-v1', 'home-drop.service'), /postgresql\.service/);
  assert.match(snippet(DROP), /client_max_body_size 100M;/);

  const rendered = env.parseDotEnv(renderAppEnvFile({ layout: DROP, password: null, site: SITE, fsImpl: createFakeFs() }));
  assert.equal(rendered.SHARE_BASE_URL, 'https://homebase.tailnet/drop/');
  assert.match(rendered.PUBLISH_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(rendered.DATABASE_URL, undefined);
});

test("engine 'none' refuses database names, migrations, or another bootstrap", () => {
  const app = getAppById('home-drop');
  for (const database of [
    { engine: 'none', bootstrap: 'migrations' },
    { engine: 'none', bootstrap: 'none', databaseName: 'drop' },
    { engine: 'none', bootstrap: 'none', migrationCommand: 'node db/migrate.js' },
  ]) {
    assert.throws(() => appLayout({ ...app, database }), /engine 'none'/);
  }
});
