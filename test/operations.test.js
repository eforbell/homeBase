const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDinnerBootstrapPlan } = require('../src/operations/compilers/bootstrap');
const { buildDinnerInstallPlan } = require('../src/operations/compilers/install');
const { canonicalize, digestOperationPlan } = require('../src/operations/digest');
const { validateOperationSchema } = require('../src/operations/validate');
const { validateOperationPolicy } = require('../src/operations/policy');
const { redactPlan, redactText } = require('../src/operations/redact');
const { buildInstallPlan } = require('../src/services/install-planner');

function dinnerPlan() {
  return buildDinnerInstallPlan({ generatedAt: '2026-09-20T14:00:00.000Z', catalogRevision: 'a'.repeat(40) });
}

function assertDenied(mutator, code = 'INVALID_PLAN') {
  const plan = dinnerPlan();
  mutator(plan);
  assert.throws(() => validateOperationPolicy(plan), (error) => error.code === code);
}

test('Dinner bootstrap and install plans validate against the checked-in schema and policy', () => {
  const bootstrap = buildDinnerBootstrapPlan({ generatedAt: '2026-09-20T14:00:00.000Z' });
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

test('Dinner git transport follows configuration and SSH uses the catalog repository in URI form', () => {
  const { getAppById } = require('../src/catalog');
  const { DINNER_SSH_REPOSITORY } = require('../src/operations/policy');
  const sshUrl = getAppById('family-dinner').repository.sshUrl;
  assert.equal(DINNER_SSH_REPOSITORY, `ssh://${sshUrl.replace(':', '/')}`);
  const repositoryFor = (gitTransport) => buildDinnerInstallPlan({ gitTransport, generatedAt: '2026-09-20T14:00:00.000Z' })
    .operations.find((operation) => operation.type === 'git.sync').repository;
  assert.equal(repositoryFor('https'), 'https://github.com/eforbell/familyDinner.git');
  assert.equal(repositoryFor('ssh-key'), DINNER_SSH_REPOSITORY);
  assert.equal(repositoryFor('ssh'), DINNER_SSH_REPOSITORY);
  const sshPlan = buildDinnerInstallPlan({ gitTransport: 'ssh-key', generatedAt: '2026-09-20T14:00:00.000Z' });
  assert.equal(validateOperationPolicy(sshPlan), sshPlan);
  const forged = buildDinnerInstallPlan({ gitTransport: 'ssh-key', generatedAt: '2026-09-20T14:00:00.000Z' });
  forged.operations.find((operation) => operation.type === 'git.sync').repository = 'ssh://git@github.com/attacker/familyDinner.git';
  assert.throws(() => validateOperationPolicy(forged), (error) => error.code === 'INVALID_PLAN');
});

test('operation schema fails closed for unknown fields, raw shell primitives, and invalid dependency order', () => {
  assertDenied((plan) => { plan.operations[0].command = 'id'; });
  assertDenied((plan) => { plan.operations[0].shell = true; });
  assertDenied((plan) => { plan.operations[1].dependsOn = ['wait-ready']; });
  assertDenied((plan) => { plan.operations[1].id = plan.operations[0].id; });
});

test('operation policy rejects hostile typed values before execution exists', () => {
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'git.sync').ref = 'main && id'; }, 'POLICY_DENIED');
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'git.sync').repository = 'https://github.com/eforbell/familyDinner.git --upload-pack=/bin/sh'; });
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'systemd.ensure-service').unit = 'family-dinner.service;reboot'; }, 'POLICY_DENIED');
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'runtime.run-npm').task = 'install-production;curl'; });
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'filesystem.ensure-directory').purpose = '../../etc/shadow'; });
  assertDenied((plan) => { plan.operations.find((op) => op.type === 'postgres.ensure-role').passwordSecretRef = 'otherSecret'; }, 'POLICY_DENIED');
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
