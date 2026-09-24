const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAction, compileAction, generateSecretBindings } = require('../executor/actions');
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
  assert.equal(plan.policyProfile, 'family-dinner-v1');
  assert.equal(planDigest, digestOperationPlan(plan));
  assert.equal(compileAction({ action: 'bootstrap' }).plan.kind, 'host-bootstrap');
  assert.throws(() => compileAction({ action: 'install', appId: 'helm', ref: 'main', transport: 'https', site: SITE }), (error) => error.code === 'POLICY_DENIED');
});

test('secrets are generated inside the executor, fresh per run, and only for known refs', () => {
  const { plan } = compileAction({ action: 'install', appId: 'family-dinner', ref: 'main', transport: 'https', site: SITE });
  const first = generateSecretBindings(plan);
  const second = generateSecretBindings(plan);
  assert.deepEqual(Object.keys(first), ['familyDinnerDatabasePassword']);
  assert.match(first.familyDinnerDatabasePassword, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first.familyDinnerDatabasePassword, second.familyDinnerDatabasePassword);
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(first.familyDinnerDatabasePassword));
  assert.deepEqual(generateSecretBindings(compileAction({ action: 'bootstrap' }).plan), {});
  assert.throws(() => generateSecretBindings({ operations: [{ secretRefs: ['somethingElse'] }] }), (error) => error.code === 'POLICY_DENIED');
});

test('reinstalls reuse the existing database password instead of rotating it', () => {
  const { plan } = compileAction({ action: 'install', appId: 'family-dinner', ref: 'main', transport: 'https', site: SITE });
  const kept = generateSecretBindings(plan, { existing: { familyDinnerDatabasePassword: 'Existing-pass_123' } });
  assert.equal(kept.familyDinnerDatabasePassword, 'Existing-pass_123');
  const fresh = generateSecretBindings(plan, { existing: { familyDinnerDatabasePassword: null } });
  assert.match(fresh.familyDinnerDatabasePassword, /^[A-Za-z0-9_-]{32}$/);
});

test('inherited object keys are not actions', () => {
  for (const action of ['constructor', '__proto__', 'toString']) {
    assert.throws(() => normalizeAction({ action }), (error) => error.code === 'INVALID_REQUEST' && error.message === 'Unsupported action.');
  }
});
