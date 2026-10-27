const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateServiceHosts, evaluateConfirmation, policyWarnings, serviceGate, CONFIRMATION_MAX_AGE_MS } = require('../src/services/service-host-verification');

const SERVICE = 'svc:smith-pulse';
const SELF = 'nSelf1CNTRL';
const OTHER = 'nOther2CNTRL';
// Shaped like the live listServiceHosts answer (GET /tailnet/{tailnet}/services/{service}/devices), checked
// against the API on 2026-10-27 with a read-only credential: hosts carry nodeId, approvalLevel, configured.
const ok = (hosts) => ({ ok: true, status: 200, body: { hosts } });
const host = (nodeId, approvalLevel, configured = 'ready') => ({ nodeId, approvalLevel, configured });
const evaluate = (apiResult, selfNodeId = SELF) => evaluateServiceHosts({ service: SERVICE, selfNodeId, apiResult });

test('verified only when this device is the one approved host', () => {
  for (const level of ['approved:auto', 'approved:manual']) {
    const result = evaluate(ok([host(SELF, level)]));
    assert.equal(result.state, 'verified', level);
    assert.deepEqual(result.approvedHosts, [{ nodeId: SELF, approvalLevel: level }]);
  }
});

test('the documented stableNodeID name is read too; two names that disagree are unreadable', () => {
  assert.equal(evaluate(ok([{ stableNodeID: SELF, approvalLevel: 'approved:auto' }])).state, 'verified');
  assert.equal(evaluate(ok([{ nodeId: SELF, stableNodeID: SELF, approvalLevel: 'approved:auto' }])).state, 'verified');
  assert.equal(evaluate(ok([{ nodeId: SELF, stableNodeID: OTHER, approvalLevel: 'approved:auto' }])).reason, 'inventory-unparseable');
});

test('a not-approved second host passes (spike 3b: a fresh advertisement got no traffic)', () => {
  assert.equal(evaluate(ok([host(SELF, 'approved:auto'), host(OTHER, 'not-approved')])).state, 'verified');
});

test('any other approved host fails, auto or manual (spike 3b: an approved standby takes over)', () => {
  for (const level of ['approved:auto', 'approved:manual']) {
    const result = evaluate(ok([host(SELF, 'approved:auto'), host(OTHER, level)]));
    assert.equal(result.state, 'unverified');
    assert.equal(result.reason, 'other-host-approved');
    assert.match(result.detail, new RegExp(`${OTHER} \\(${level}\\) is also approved`));
  }
  assert.equal(evaluate(ok([host(OTHER, 'approved:manual')])).reason, 'other-host-approved', 'another host alone is worse than self missing');
});

test('this device missing or not approved fails', () => {
  assert.equal(evaluate(ok([])).reason, 'self-missing');
  assert.equal(evaluate(ok([host(OTHER, 'not-approved')])).reason, 'self-missing');
  assert.equal(evaluate(ok([host(SELF, 'not-approved')])).reason, 'self-not-approved');
  assert.equal(evaluate(ok([host(SELF, 'approved:auto')]), '').reason, 'self-unknown');
});

test('a partial or unparseable inventory fails closed', () => {
  // A service without hosts answers {} on the live API; that alone means "no hosts".
  assert.equal(evaluate({ ok: true, status: 200, body: {} }).reason, 'self-missing');
  for (const body of [null, [], { hosts: 'x' }, { hosts: null }, { devices: [host(SELF, 'approved:auto')] }]) {
    assert.equal(evaluate({ ok: true, status: 200, body }).reason, 'inventory-unparseable', JSON.stringify(body));
  }
  // An approval level this version does not know could mean approved.
  assert.equal(evaluate(ok([host(SELF, 'approved:auto'), host(OTHER, 'approved:policy')])).reason, 'inventory-unparseable');
  assert.equal(evaluate(ok([host(SELF, 'approved:auto'), { approvalLevel: 'approved:auto' }])).reason, 'inventory-unparseable');
  assert.equal(evaluate(ok([host(SELF, 'approved:auto'), null])).reason, 'inventory-unparseable');
  assert.equal(evaluate(ok([host(SELF, 'approved:auto'), host(SELF, 'not-approved')])).reason, 'inventory-unparseable');
});

test('API errors fail closed, and a refused read-only credential points to confirmation', () => {
  const forbidden = evaluate({ ok: false, status: 403, body: { message: 'insufficient scope' } });
  assert.equal(forbidden.reason, 'credential-refused');
  assert.match(forbidden.detail, /administrator confirmation instead of a broader credential/);
  assert.equal(evaluate({ ok: false, status: 401 }).reason, 'credential-refused');
  assert.equal(evaluate({ ok: false, status: 404 }).reason, 'service-unknown');
  assert.equal(evaluate({ ok: false, status: 500 }).reason, 'api-error');
  assert.equal(evaluate({ ok: false, error: 'ETIMEDOUT' }).reason, 'api-error');
  assert.equal(evaluate(null).reason, 'api-error');
});

test('confirmation is per service and host, and lasts 30 days', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const confirmation = { service: SERVICE, hostNodeId: SELF, confirmedAt: '2026-10-20T12:00:00Z', confirmedBy: 'admin@example.com' };
  const check = (value, at = now) => evaluateConfirmation({ service: SERVICE, selfNodeId: SELF, confirmation: value, now: at });
  assert.equal(check(confirmation).state, 'confirmed');
  assert.match(check(confirmation).detail, /^confirmed by administrator admin@example\.com/);
  assert.equal(check(null).reason, 'not-confirmed');
  assert.equal(check({ ...confirmation, hostNodeId: OTHER }).reason, 'confirmation-mismatch');
  assert.equal(check({ ...confirmation, service: 'svc:smith-helm' }).reason, 'confirmation-mismatch');
  assert.equal(check(confirmation, Date.parse(confirmation.confirmedAt) + CONFIRMATION_MAX_AGE_MS + 1).reason, 'confirmation-expired');
  assert.equal(check({ ...confirmation, confirmedAt: 'yesterday' }).reason, 'confirmation-invalid');
  assert.equal(check({ ...confirmation, confirmedAt: '2027-01-01T00:00:00Z' }).reason, 'confirmation-invalid');
});

test('policy warnings: shared approver, second tag holder, foreign tag owner, extra rule', () => {
  const policy = {
    tagOwners: { 'tag:smith-host': ['admin@example.com'] },
    autoApprovers: { services: { [SERVICE]: ['tag:smith-host'] } },
  };
  const devices = [{ nodeId: SELF, name: 'host-a', tags: ['tag:smith-host'] }];
  const warn = (overrides = {}) => policyWarnings({ service: SERVICE, hostTag: 'tag:smith-host', selfNodeId: SELF, policy, devices, administratorLogin: 'admin@example.com', ...overrides }).map((warning) => warning.id);
  assert.deepEqual(warn(), []);
  assert.deepEqual(warn({ policy: { ...policy, autoApprovers: { services: { [SERVICE]: ['tag:smith-host', 'tag:servers'] } } } }), ['shared-approver']);
  assert.deepEqual(warn({ devices: [...devices, { nodeId: OTHER, name: 'host-b', tags: ['tag:smith-host'] }] }), ['host-tag-shared']);
  assert.deepEqual(warn({ policy: { ...policy, tagOwners: { 'tag:smith-host': ['admin@example.com', 'kid@example.com'] } } }), ['host-tag-owners']);
  assert.deepEqual(warn({ policy: { ...policy, tagOwners: { 'tag:smith-host': ['autogroup:admin'] } } }), ['host-tag-owners']);
  assert.deepEqual(warn({ policy: { ...policy, tagOwners: {} } }), ['host-tag-undefined']);
  // A rule keyed on a service tag the service carries also matches it.
  const twoRules = { ...policy, autoApprovers: { services: { [SERVICE]: ['tag:smith-host'], 'tag:sensitive': ['tag:smith-host'] } } };
  assert.deepEqual(warn({ policy: twoRules, serviceTags: ['tag:sensitive'] }), ['extra-approver-rule']);
  assert.deepEqual(warn({ policy: twoRules }), [], 'a service-tag rule matches only services carrying that tag');
  assert.deepEqual(warn({ devices: [{ nodeId: SELF, tags: [] }] }), ['host-tag-missing']);
  assert.deepEqual(warn({ policy: null, devices: null }), ['policy-unreadable', 'devices-unreadable']);
  assert.deepEqual(warn({ hostTag: '' }), ['host-tag-unknown']);
});

test('publish gate: allowed while no other host is approved; refused on another approved host or an unreadable inventory', () => {
  const gate = (evaluation, lifecycleState = 'none', serviceKey = 'pulse') => serviceGate({ lifecycleState, serviceKey, action: 'publish', evaluation });
  assert.equal(gate(evaluate(ok([]))).allowed, true, 'not advertising yet');
  assert.equal(gate(evaluate(ok([host(SELF, 'not-approved')]))).allowed, true, 'advertised, awaiting approval');
  assert.equal(gate(evaluate(ok([host(SELF, 'approved:auto')]))).allowed, true);
  assert.equal(gate(evaluate(ok([host(OTHER, 'approved:manual')]))).allowed, false, 'another host already serves it');
  assert.equal(gate(evaluate(ok([host(SELF, 'not-approved'), host(OTHER, 'approved:auto')]))).allowed, false);
  assert.equal(gate(evaluate({ ok: false, status: 500 })).allowed, false);
  assert.equal(gate(evaluate({ ok: false, status: 404 })).allowed, false, 'define the service in the console first');
  assert.equal(gate({ state: 'unconfirmed', reason: 'not-confirmed' }).allowed, false);
  assert.equal(gate({ state: 'confirmed', detail: 'c' }).allowed, true);
});

test('bootstrap gate (D16/D23): in setup only the Home Base service may be published; tailnet mode waits for active', () => {
  const verified = { state: 'verified', detail: 'ok' };
  assert.equal(serviceGate({ lifecycleState: 'setup', serviceKey: 'homebase', action: 'publish', evaluation: verified }).allowed, true);
  assert.equal(serviceGate({ lifecycleState: 'setup', serviceKey: 'homebase', action: 'publish', evaluation: { state: 'unverified', reason: 'other-host-approved' } }).allowed, false, 'even Home Base needs the host check');
  assert.equal(serviceGate({ lifecycleState: 'setup', serviceKey: 'home', action: 'publish', evaluation: verified }).allowed, false);
  assert.equal(serviceGate({ lifecycleState: 'recovery', serviceKey: 'home', action: 'publish', evaluation: verified }).allowed, false);
  assert.equal(serviceGate({ lifecycleState: 'setup', serviceKey: 'homebase', action: 'tailnet-mode', evaluation: verified }).allowed, false);
});

test('tailnet-mode gate: no directory, not active, unverified, or a passphrase-only confirmation are refused', () => {
  const tailnet = (evaluation, lifecycleState = 'active') => serviceGate({ lifecycleState, serviceKey: 'pulse', action: 'tailnet-mode', evaluation });
  assert.equal(tailnet({ state: 'verified', detail: 'ok' }).allowed, true);
  assert.match(tailnet({ state: 'verified', detail: 'ok' }, 'none').reason, /no household directory yet/);
  assert.equal(tailnet({ state: 'confirmed', assurance: 'hardware-key', detail: 'c' }).allowed, true);
  assert.match(tailnet({ state: 'confirmed', assurance: 'passphrase-session', detail: 'c' }).reason, /hardware key/);
  assert.equal(tailnet(evaluate(ok([host(SELF, 'not-approved')]))).allowed, false, 'publishable is not verified');
  assert.equal(tailnet(undefined).allowed, false);
  assert.equal(serviceGate({ lifecycleState: undefined, serviceKey: 'homebase', action: 'publish', evaluation: { state: 'verified' } }).allowed, false);
  assert.equal(serviceGate({ lifecycleState: 'active', serviceKey: 'home', action: 'delete', evaluation: { state: 'verified' } }).allowed, false);
  const now = Date.parse('2026-10-27T12:00:00Z');
  assert.equal(evaluateConfirmation({ service: SERVICE, selfNodeId: SELF, now, confirmation: { service: SERVICE, hostNodeId: SELF, confirmedAt: '2026-10-27T11:00:00Z' } }).assurance, 'passphrase-session');
});
