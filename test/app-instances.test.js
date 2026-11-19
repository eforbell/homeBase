// The household's native app registering an app instance (sovereignAuth docs/native-handoff.md, part 1):
// app/challenge on Home Base's hostname, then app/register with an App Attest attestation over it. Apple is a
// fake (test/support/app-attest.js) whose roots only these tests pin.
const test = require('node:test');
const assert = require('node:assert/strict');
const { appInstanceClientData } = require('sovereign-auth');
const { createFakeApple } = require('./support/app-attest');
const path = require('path');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { KID, PARENT, PULSE, activeHousehold, browser, startServer } = require('./support/household');

const APP_ID = 'ABCDE12345.org.example.homebase';
const NATIVE_APP = { appId: APP_ID, scheme: 'homebase', development: false };

let apple;
test.before(async () => { apple = await createFakeApple({ appId: APP_ID }); });

const nativeConfig = (extra = {}) => ({ config: { nativeApp: NATIVE_APP, appAttestRoots: apple.roots, ...extra } });

// What the app does: a challenge, a new key attested over the client data it names, then register.
async function register(client, { environment = 'production', label = 'Phone', tamper = (body) => body, clientData } = {}) {
  const issued = await client.post('/_sovereign/auth/app/challenge');
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const { challenge, household, userId } = issued.body;
  const attested = await apple.attest({ clientData: clientData || appInstanceClientData({ household, userId, challenge }), environment });
  const body = tamper({ challenge, keyId: attested.keyId, attestation: attested.attestation, label });
  return { issued: issued.body, attested, body, answer: await client.post('/_sovereign/auth/app/register', body) };
}

const instancesOf = async (parent, login) => (await parent.get('/api/directory')).body.members.find((member) => member.login === login).appInstances;

test('without the native app setting there are no app routes', async (t) => {
  const { parent } = await activeHousehold(t);
  assert.equal((await parent.post('/_sovereign/auth/app/challenge')).status, 404);
  assert.equal((await parent.post('/_sovereign/auth/app/register', {})).status, 404);
});

test('only on Home Base\'s own hostname, and only for members', async (t) => {
  const { base } = await activeHousehold(t, nativeConfig());
  assert.equal((await browser(base, PARENT, { host: PULSE }).post('/_sovereign/auth/app/challenge')).status, 404, 'a sensitive app\'s hostname has checks only');
  const stranger = await browser(base, KID).post('/_sovereign/auth/app/challenge');
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.code, 'NOT_A_MEMBER');
});

test('setup: no app instances until Home Base is active', async (t) => {
  const { base } = await startServer(t, nativeConfig());
  const parent = browser(base, PARENT);
  assert.equal((await parent.post('/api/admin/setup', { passphrase: 'correct horse battery' })).status, 200);
  const refused = await parent.post('/_sovereign/auth/app/challenge');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'BOOTSTRAP_STATE');
});

test('a member registers this installation; the challenge is used once', async (t) => {
  const { parent, app } = await activeHousehold(t, nativeConfig());
  const { issued, attested, body, answer } = await register(parent, { label: 'Eric\u0007s iPhone' });
  assert.equal(issued.household, 'smith');
  assert.equal(issued.userId, '1001');
  assert.equal(issued.expiresInSeconds, 300);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { ok: true, keyId: attested.keyId, environment: 'production', label: 'Erics iPhone' });

  const listed = await instancesOf(parent, 'parent@example.com');
  assert.deepEqual(listed.map(({ keyId, label, environment }) => ({ keyId, label, environment })), [{ keyId: attested.keyId, label: 'Erics iPhone', environment: 'production' }]);
  const stored = app.directory.appInstance(attested.keyId);
  assert.equal(stored.userId, '1001');
  assert.equal(stored.counter, 0);

  const again = await parent.post('/_sovereign/auth/app/register', body);
  assert.equal(again.status, 403);
  assert.deepEqual(again.body, { error: 'app_instance_refused', reason: 'unknown_challenge' });
});

test('registration refusals', async (t) => {
  const { app, base, parent } = await activeHousehold(t, nativeConfig());
  const refused = (answer, status, reason) => {
    assert.equal(answer.status, status, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, { error: 'app_instance_refused', reason });
  };

  refused(await parent.post('/_sovereign/auth/app/register', { challenge: 'short' }), 400, 'malformed');
  refused(await parent.post('/_sovereign/auth/app/register', { challenge: 'A'.repeat(43), keyId: 'x', attestation: 'x' }), 403, 'unknown_challenge');
  refused((await register(parent, { tamper: (body) => ({ ...body, attestation: 42 }) })).answer, 400, 'malformed');
  refused((await register(parent, { tamper: (body) => ({ ...body, attestation: 'A'.repeat(40_000) }) })).answer, 400, 'malformed');
  refused((await register(parent, { tamper: (body) => ({ ...body, label: ['x'] }) })).answer, 400, 'malformed');
  refused((await register(parent, { tamper: (body) => ({ ...body, attestation: Buffer.from('not cbor').toString('base64') }) })).answer, 400, 'malformed');
  // Attested over someone else's client data: another household, member or challenge.
  refused((await register(parent, { clientData: appInstanceClientData({ household: 'jones', userId: '1001', challenge: 'A'.repeat(43) }) })).answer, 403, 'untrusted_attestation');
  // Another key's ID with this attestation.
  const other = await apple.attest({ clientData: 'other' });
  refused((await register(parent, { tamper: (body) => ({ ...body, keyId: other.keyId }) })).answer, 403, 'untrusted_attestation');
  // A development build, which this household doesn't allow.
  refused((await register(parent, { environment: 'development' })).answer, 403, 'wrong_environment');

  // Another member can't use this member's challenge.
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  const candidate = (await parent.get('/api/directory')).body.candidates.find((entry) => entry.login === 'kid@example.com');
  assert.equal((await parent.post('/api/directory/members', { userId: candidate.userId, role: 'kid' })).status, 201);
  const kid = browser(base, KID);
  const issued = (await parent.post('/_sovereign/auth/app/challenge')).body;
  const attested = await apple.attest({ clientData: appInstanceClientData({ household: issued.household, userId: '1002', challenge: issued.challenge }) });
  refused(await kid.post('/_sovereign/auth/app/register', { challenge: issued.challenge, keyId: attested.keyId, attestation: attested.attestation }), 403, 'wrong_member');
  // The kid registers their own.
  assert.equal((await register(kid)).answer.status, 201);

  assert.deepEqual(await instancesOf(parent, 'parent@example.com'), [], 'nothing refused was stored');
});

test('a development build registers when the household allows it', async (t) => {
  const { parent } = await activeHousehold(t, nativeConfig({ nativeApp: { ...NATIVE_APP, development: true } }));
  const { answer } = await register(parent, { environment: 'development' });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.environment, 'development');
});

test('a challenge lasts five minutes', async (t) => {
  const { parent } = await activeHousehold(t, nativeConfig());
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const issued = (await parent.post('/_sovereign/auth/app/challenge')).body;
  const attested = await apple.attest({ clientData: appInstanceClientData({ household: issued.household, userId: issued.userId, challenge: issued.challenge }) });
  t.mock.timers.tick(5 * 60_000 + 1);
  const late = await parent.post('/_sovereign/auth/app/register', { challenge: issued.challenge, keyId: attested.keyId, attestation: attested.attestation });
  assert.equal(late.status, 403);
  assert.deepEqual(late.body, { error: 'app_instance_refused', reason: 'expired' });
});

test('every registration and refusal is audited', async (t) => {
  const { parent, root } = await activeHousehold(t, nativeConfig());
  await register(parent);
  await register(parent, { environment: 'development' });
  const audit = new SqliteStateStore(path.join(root, 'state.sqlite3')).listAdminAudit(50);
  assert.ok(audit.some((entry) => entry.action === 'app-instance-register' && /production$/.test(entry.outcome)));
  assert.ok(audit.some((entry) => entry.action === 'app-instance-register' && entry.outcome === 'refused' && entry.reason === 'wrong_environment'));
});
