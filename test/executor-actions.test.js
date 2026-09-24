const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAction, compileAction, generateSecretBindings } = require('../executor/actions');
const { digestOperationPlan } = require('../src/operations/digest');

test('actions normalize to a closed shape with no room for extra fields', () => {
  assert.deepEqual(normalizeAction({ action: 'bootstrap' }), { action: 'bootstrap' });
  assert.deepEqual(normalizeAction({ action: 'install', appId: 'family-dinner', ref: 'main', transport: 'ssh' }), { action: 'install', appId: 'family-dinner', ref: 'main', transport: 'ssh' });
  assert.throws(() => normalizeAction({ action: 'bootstrap', ref: 'main' }), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(() => normalizeAction({ action: 'install', appId: 'nope', ref: 'main', transport: 'https' }), (error) => error.code === 'INVALID_REQUEST');
});

test('the executor compiles and policy-checks its own plans', () => {
  const { plan, planDigest } = compileAction({ action: 'install', appId: 'family-dinner', ref: 'main', transport: 'https' }, { generatedAt: '2026-09-24T00:00:00.000Z' });
  assert.equal(plan.policyProfile, 'family-dinner-v1');
  assert.equal(planDigest, digestOperationPlan(plan));
  assert.equal(compileAction({ action: 'bootstrap' }).plan.kind, 'host-bootstrap');
  assert.throws(() => compileAction({ action: 'install', appId: 'helm', ref: 'main', transport: 'https' }), (error) => error.code === 'POLICY_DENIED');
});

test('secrets are generated inside the executor, fresh per run, and only for known refs', () => {
  const { plan } = compileAction({ action: 'install', appId: 'family-dinner', ref: 'main', transport: 'https' });
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
  const { plan } = compileAction({ action: 'install', appId: 'family-dinner', ref: 'main', transport: 'https' });
  const kept = generateSecretBindings(plan, { existing: { familyDinnerDatabasePassword: 'Existing-pass_123' } });
  assert.equal(kept.familyDinnerDatabasePassword, 'Existing-pass_123');
  const fresh = generateSecretBindings(plan, { existing: { familyDinnerDatabasePassword: null } });
  assert.match(fresh.familyDinnerDatabasePassword, /^[A-Za-z0-9_-]{32}$/);
});

test('the existing password is read as sovereign and only from a well-formed managed DATABASE_URL', () => {
  const { readExistingDinnerPassword } = require('../executor/handlers');
  const { createFakeFs } = require('./fixtures/fake-fs');
  const envPath = '/opt/sovereign-home/apps/familyDinner/.env';
  const identities = [];
  const read = (content) => readExistingDinnerPassword({
    fsImpl: createFakeFs(content == null ? {} : { [envPath]: content }),
    lookupUser: () => ({ uid: 1001, gid: 1002 }),
    asUser: (user, fn) => { identities.push(user.uid); return fn(); },
  });
  assert.equal(read('PORT=3000\nDATABASE_URL=postgresql://family_dinner:p%40ss%2Fword1@127.0.0.1:5432/family_dinner\n'), 'p@ss/word1');
  assert.deepEqual(identities, [1001]);
  assert.equal(read(null), null);
  assert.equal(read('DATABASE_URL=postgresql://family_dinner:short@127.0.0.1:5432/family_dinner\n'), null);
  assert.equal(read('DATABASE_URL=postgresql://other:Long-enough-pass@evil.example:5432/family_dinner\n'), null);
  assert.equal(read('DATABASE_URL=postgresql://family_dinner:has%20space-pass@127.0.0.1:5432/family_dinner\n'), null);
});

test('inherited object keys are not actions', () => {
  for (const action of ['constructor', '__proto__', 'toString']) {
    assert.throws(() => normalizeAction({ action }), (error) => error.code === 'INVALID_REQUEST' && error.message === 'Unsupported action.');
  }
});
