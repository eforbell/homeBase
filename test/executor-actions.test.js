const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAction, compileAction, generateSecretBindings, INSTALLABLE_APPS } = require('../executor/actions');
const { digestOperationPlan } = require('../src/operations/digest');

const SITE = { hostname: 'homebase', domain: 'tailnet', householdTimezone: 'America/New_York' };

test('actions normalize to a closed shape with no room for extra fields', () => {
  assert.deepEqual(normalizeAction({ action: 'bootstrap' }), { action: 'bootstrap' });
  assert.deepEqual(normalizeAction({ action: 'install', appId: 'family-dinner', ref: 'main', transport: 'ssh', site: SITE }), { action: 'install', appId: 'family-dinner', ref: 'main', transport: 'ssh', site: SITE });
  assert.throws(() => normalizeAction({ action: 'install', appId: 'family-dinner', ref: 'main', transport: 'ssh', site: { ...SITE, domain: '../x' } }), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(() => normalizeAction({ action: 'bootstrap', ref: 'main' }), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(() => normalizeAction({ action: 'install', appId: 'nope', ref: 'main', transport: 'https', site: SITE }), (error) => error.code === 'INVALID_REQUEST');
});

test('the executor compiles and policy-checks its own plans', () => {
  const { plan, planDigest } = compileAction({ action: 'install', appId: 'family-dinner', ref: 'main', transport: 'https', site: SITE }, { generatedAt: '2026-09-24T00:00:00.000Z' });
  assert.equal(plan.policyProfile, 'app-install-v1');
  assert.equal(planDigest, digestOperationPlan(plan));
  assert.equal(compileAction({ action: 'bootstrap' }).plan.kind, 'host-bootstrap');
  // Every catalog app is managed now; the gate still refuses anything outside INSTALLABLE_APPS.
  assert.deepEqual([...INSTALLABLE_APPS].sort(), require('../src/catalog').catalog.map((app) => app.id).sort());
  assert.throws(() => compileAction({ action: 'install', appId: 'not-in-catalog', ref: 'main', transport: 'https', site: SITE }), (error) => error.code === 'POLICY_DENIED');
});

test('secrets are generated inside the executor, fresh per run, and only for known refs', () => {
  const { plan } = compileAction({ action: 'install', appId: 'family-dinner', ref: 'main', transport: 'https', site: SITE });
  const first = generateSecretBindings(plan);
  const second = generateSecretBindings(plan);
  assert.deepEqual(Object.keys(first), ['databasePassword']);
  assert.match(first.databasePassword, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first.databasePassword, second.databasePassword);
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(first.databasePassword));
  assert.deepEqual(generateSecretBindings(compileAction({ action: 'bootstrap' }).plan), {});
  assert.throws(() => generateSecretBindings({ operations: [{ secretRefs: ['somethingElse'] }] }), (error) => error.code === 'POLICY_DENIED');
});

test('reinstalls reuse the existing database password instead of rotating it', () => {
  const { plan } = compileAction({ action: 'install', appId: 'family-dinner', ref: 'main', transport: 'https', site: SITE });
  const kept = generateSecretBindings(plan, { existing: { databasePassword: 'Existing-pass_123' } });
  assert.equal(kept.databasePassword, 'Existing-pass_123');
  const fresh = generateSecretBindings(plan, { existing: { databasePassword: null } });
  assert.match(fresh.databasePassword, /^[A-Za-z0-9_-]{32}$/);
});

test('inherited object keys are not actions', () => {
  for (const action of ['constructor', '__proto__', 'toString']) {
    assert.throws(() => normalizeAction({ action }), (error) => error.code === 'INVALID_REQUEST' && error.message === 'Unsupported action.');
  }
});
