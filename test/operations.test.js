const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHostBootstrapPlan } = require('../src/operations/compilers/bootstrap');
const { buildAppInstallPlan } = require('../src/operations/compilers/install');
const { canonicalize, digestOperationPlan } = require('../src/operations/digest');
const { validateOperationSchema } = require('../src/operations/validate');
const { validateOperationPolicy } = require('../src/operations/policy');
const { redactPlan, redactText } = require('../src/operations/redact');
const { buildInstallPlan } = require('../src/services/install-planner');

function dinnerPlan() {
  return buildAppInstallPlan({ appId: 'family-dinner', generatedAt: '2026-09-20T14:00:00.000Z', catalogRevision: 'a'.repeat(40) });
}

function assertDenied(mutator, code = 'INVALID_PLAN') {
  const plan = dinnerPlan();
  mutator(plan);
  assert.throws(() => validateOperationPolicy(plan), (error) => error.code === code);
}

test('bootstrap and Dinner install plans validate against the checked-in schema and policy', () => {
  const bootstrap = buildHostBootstrapPlan({ generatedAt: '2026-09-20T14:00:00.000Z' });
  const dinner = dinnerPlan();
  assert.equal(validateOperationPolicy(bootstrap), bootstrap);
  assert.equal(validateOperationPolicy(dinner), dinner);
  assert.deepEqual(dinner.operations.map((operation) => operation.id), [
    'ensure-sovereign-root', 'ensure-app-root', 'ensure-sovereign-home', 'ensure-install-root', 'sync-repository', 'ensure-db-role', 'ensure-database', 'write-environment',
    'write-service', 'ensure-nginx-apps', 'write-nginx', 'install-runtime', 'run-migrations', 'reload-systemd',
    'start-service', 'ensure-gateway', 'reload-nginx', 'wait-ready',
  ]);
  const bootstrapIds = bootstrap.operations.map((operation) => operation.id);
  assert.ok(bootstrapIds.indexOf('ensure-nginx-apps') < bootstrapIds.indexOf('install-gateway'));
  assert.ok(bootstrapIds.indexOf('install-gateway') < bootstrapIds.indexOf('validate-nginx'));
});

test('git transport follows configuration and SSH uses the catalog repository in URI form', () => {
  const { getAppById } = require('../src/catalog');
  const sshUri = `ssh://${getAppById('family-dinner').repository.sshUrl.replace(':', '/')}`;
  const repositoryFor = (gitTransport) => buildAppInstallPlan({ appId: 'family-dinner', gitTransport, generatedAt: '2026-09-20T14:00:00.000Z' })
    .operations.find((operation) => operation.type === 'git.sync').repository;
  assert.equal(repositoryFor('https'), 'https://github.com/eforbell/familyDinner.git');
  assert.equal(repositoryFor('ssh-key'), sshUri);
  assert.equal(repositoryFor('ssh'), sshUri);
  const sshPlan = buildAppInstallPlan({ appId: 'family-dinner', gitTransport: 'ssh-key', generatedAt: '2026-09-20T14:00:00.000Z' });
  assert.equal(validateOperationPolicy(sshPlan), sshPlan);
  const forged = buildAppInstallPlan({ appId: 'family-dinner', gitTransport: 'ssh-key', generatedAt: '2026-09-20T14:00:00.000Z' });
  forged.operations.find((operation) => operation.type === 'git.sync').repository = 'ssh://git@github.com/attacker/familyDinner.git';
  assert.throws(() => validateOperationPolicy(forged), (error) => error.code === 'POLICY_DENIED');
});

test('homeSource compiles to a plan covering packages, storage, sidecar, timers, and migrations', () => {
  const plan = buildAppInstallPlan({ appId: 'home-source', generatedAt: '2026-09-20T14:00:00.000Z' });
  assert.equal(validateOperationPolicy(plan), plan);
  const ids = plan.operations.map((operation) => operation.id);
  for (const id of ['install-app-packages', 'ensure-storage-root', 'ensure-storage-1', 'ensure-storage-3', 'write-sidecar-1', 'write-timer-service-2', 'write-timer-2', 'run-migrations', 'start-sidecar-1', 'start-timer-2']) assert.ok(ids.includes(id), id);
  assert.deepEqual(plan.operations.find((operation) => operation.id === 'install-app-packages').packages, ['poppler-utils', 'tesseract-ocr']);
  assert.ok(ids.indexOf('ensure-storage-3') < ids.indexOf('start-service'), 'storage exists before first start');
  assert.deepEqual(plan.operations.at(-1), { ...plan.operations.at(-1), type: 'http.wait-ready', port: 3008, path: '/api/ready' });
  // A plan compiled for one app cannot be relabelled to act on another.
  const relabelled = { ...plan, target: 'family-dinner' };
  assert.throws(() => validateOperationPolicy(relabelled), (error) => error.code === 'POLICY_DENIED');
});

test('apps with unsupported shapes are refused with the reason, never half-compiled', () => {
  assert.throws(() => buildAppInstallPlan({ appId: 'helm' }), /runtime python/);
  assert.throws(() => buildAppInstallPlan({ appId: 'bug-base' }), /sidecar ports/);
  assert.throws(() => buildAppInstallPlan({ appId: 'family-pulse' }), /sidecar ports/);
  assert.throws(() => buildAppInstallPlan({ appId: 'family-help' }), /storage paths inside the install root/);
});

test('operation schema fails closed for unknown fields, raw shell primitives, and invalid dependency order', () => {
  assertDenied((plan) => { plan.operations[0].command = 'id'; });
  assertDenied((plan) => { plan.operations[0].shell = true; });
  assertDenied((plan) => { plan.operations[1].dependsOn = ['wait-ready']; });
  assertDenied((plan) => { plan.operations[1].id = plan.operations[0].id; });
});

test('operation policy rejects hostile typed values before execution exists', () => {
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'git.sync').ref = 'main && id'; });
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'git.sync').repository = 'https://github.com/eforbell/familyDinner.git --upload-pack=/bin/sh'; });
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'systemd.ensure-service').unit = 'family-dinner.service;reboot'; });
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'systemd.ensure-service').unit = 'ssh.service'; }, 'POLICY_DENIED');
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'runtime.run-app-task').task = 'install-dependencies;curl'; });
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'filesystem.write-managed-file' && op.template === 'app-service-v1').unit = 'ssh.service'; }, 'POLICY_DENIED');
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'filesystem.ensure-directory').purpose = '../../etc/shadow'; });
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'postgres.ensure-role').passwordSecretRef = 'otherSecret'; });
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'postgres.ensure-role').role = 'postgres'; }, 'POLICY_DENIED');
});

test('canonical operation digest is key-order stable, semantic changes are detected, and secret bindings are excluded', () => {
  const first = { b: 2, a: { z: true, y: ['x'] }, secretBindings: { password: 'one' } };
  const reordered = { secretBindings: { password: 'one' }, a: { y: ['x'], z: true }, b: 2 };
  const changedSecret = { secretBindings: { password: 'two' }, a: { y: ['x'], z: true }, b: 2 };
  assert.equal(canonicalize(first), canonicalize(reordered));
  assert.equal(digestOperationPlan(first), digestOperationPlan(reordered));
  assert.equal(digestOperationPlan(first), digestOperationPlan(changedSecret));
  assert.notEqual(digestOperationPlan(first), digestOperationPlan({ ...first, b: 3 }));
});

test('redaction removes exact and URL-encoded secrets without masking harmless fields', () => {
  const secret = 'p@ss word&more';
  const redacted = redactPlan({ operationId: 'write-environment', error: `DATABASE_URL=postgres://${encodeURIComponent(secret)}@host/db`, password: secret }, { databasePassword: secret });
  assert.equal(redacted.operationId, 'write-environment');
  assert.match(redacted.error, /\[REDACTED\]/);
  assert.doesNotMatch(redacted.error, /p%40ss/);
  assert.equal(redacted.password, '[REDACTED]');
  assert.equal(redactText('exit code 1', [secret]), 'exit code 1');
});

test('the web-side install planner no longer produces typed plans; only the executor compiles them', () => {
  const config = { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', defaultHostname: 'homebase', defaultDomain: 'tailnet' };
  const dinner = buildInstallPlan({ appId: 'family-dinner', state: { installations: {} }, options: {}, config });
  assert.equal('operationPlan' in dinner, false);
  assert.equal(dinner.stateRecord.appId, 'family-dinner');
});

test('site values appear only on app env files and must be single-line tokens', () => {
  const envOp = (plan) => plan.operations.find((operation) => operation.purpose === 'app-env');
  assert.deepEqual(envOp(dinnerPlan()).site, { hostname: 'homebase', domain: 'tailnet', householdTimezone: 'America/New_York' });
  assertDenied((plan) => { envOp(plan).site.hostname = 'evil\nINJECTED=1'; });
  assertDenied((plan) => { envOp(plan).site.domain = '..'; }, 'POLICY_DENIED');
  assertDenied((plan) => { delete envOp(plan).site; }, 'POLICY_DENIED');
  assertDenied((plan) => { plan.operations.find((operation) => operation.purpose === 'systemd-unit').site = envOp(plan).site; }, 'POLICY_DENIED');
});

test('catalog layouts fail closed on reserved, colliding, or escaping names', () => {
  const { appLayout } = require('../src/operations/app-layout');
  const { getAppById } = require('../src/catalog');
  const variant = (mutate) => { const app = JSON.parse(JSON.stringify(getAppById('home-source'))); mutate(app); return () => appLayout(app); };
  const refused = (mutate, pattern) => assert.throws(variant(mutate), (error) => error.code === 'POLICY_DENIED' && pattern.test(error.message));
  refused((app) => { app.database.databaseUser = 'postgres'; }, /reserved/);
  refused((app) => { app.database.databaseName = 'template1'; }, /reserved/);
  refused((app) => { app.database.databaseUser = 'family_dinner'; }, /shared with another catalog app/);
  refused((app) => { app.sidecars[0].name = 'ssh'; }, /start with the app id/);
  refused((app) => { app.sidecars[0].name = 'home-source'; }, /must be unique/);
  refused((app) => { app.service.name = 'nginx'; }, /service name/);
  refused((app) => { app.timers[0].serviceName = 'cron'; app.timers[0].timerName = 'cron.timer'; }, /timer names/);
  refused((app) => { app.storage.absoluteRoot = '/var/lib/sovereign-home/home-source/data/x/y'; }, /must be \/var\/lib\/sovereign-home\/home-source\/<name>/);
  refused((app) => { app.storage.absoluteRoot = '/var/lib/sovereign-home/family-dinner/data'; }, /home-source\/<name>/);
  refused((app) => { app.storage.absoluteRoot = '/var/lib/sovereign-home/homebase'; }, /home-source\/<name>/);
});
