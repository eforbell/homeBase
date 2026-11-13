const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWebAuthn } = require('sovereign-auth');
const { DOMAIN, PARENT, KID, PASSPHRASE, activeHousehold, browser, startServer } = require('./support/household');
const { attestationFixture, createAuthenticator } = require('./support/authenticator');
const { createResidentAuthenticator } = require('./support/resident-authenticator');

function sql(db, statement, values = []) {
  return JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row; r=c.execute(sys.argv[2],json.loads(sys.argv[3])); print(json.dumps([dict(x) for x in r.fetchall()])); c.commit()', db, statement, JSON.stringify(values)], { encoding: 'utf8', stdio: 'pipe' }));
}
async function site(t, instance) {
  const server = await startServer(t, { config: { instance } });
  const host = instance + '-homebase.' + DOMAIN;
  const parent = browser(server.base, PARENT, { host });
  assert.equal((await parent.post('/api/admin/setup', { passphrase: PASSPHRASE })).status, 200);
  return { ...server, instance, host, origin: 'https://' + host, parent, db: path.join(server.root, 'state.sqlite3') };
}

// Restore a cryptographically verified legacy record, using old-writer columns/defaults. This is not
// running an old executable: it models the on-disk account that the new server must keep usable.
async function legacyCredential(server, key, hardware) {
  const service = createWebAuthn({ rpID: DOMAIN, roots: attestationFixture().roots });
  const request = { hostname: server.host, member: { userId: '1001', login: 'parent@example.com' }, purpose: 'enroll' };
  const options = await service.registrationOptions({ ...request, attestation: hardware ? 'direct' : 'none' });
  const result = await service.verifyRegistration({ ...request, response: key.register(options, { origin: server.origin }) });
  assert.equal(result.ok, true, JSON.stringify(result));
  const c = result.credential;
  const owner = sql(server.db, "SELECT member_id FROM identity_members WHERE user_id='1001'")[0].member_id;
  sql(server.db, 'INSERT INTO identity_credentials (credential_id,member_id,kind,label,orphaned,created_at,public_key,counter,transports,aaguid,device_type,backed_up,root) VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?)', [c.id, owner, c.kind, hardware ? 'Legacy key' : 'Legacy phone', new Date().toISOString(), c.publicKey, c.counter, JSON.stringify(c.transports), c.aaguid, c.deviceType, c.backedUp ? 1 : 0, c.root]);
  sql(server.db, 'UPDATE identity_household SET generation=generation+1');
  return c.id;
}
function tamperCredential(server, id) {
  for (const { name } of sql(server.db, "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='identity_credentials'")) sql(server.db, 'DROP TRIGGER "' + name.replaceAll('"', '""') + '"');
  sql(server.db, "UPDATE identity_credentials SET webauthn_user_handle='corrupt!' WHERE credential_id=?", [id]);
  server.app.directory.init(); // Restore the real guards before testing recovery.
}

test('public enrollment ignores browser-selected handles and stores only the trusted isolated handle', async (t) => {
  const server = await site(t, 'prod');
  const key = createResidentAuthenticator({ kind: 'hardware' });
  const body = { label: 'Isolated', hardware: true, userHandle: Buffer.from('1001').toString('base64url'), handle_format: 'legacy-v1' };
  const started = await server.parent.post('/_sovereign/auth/enroll/options', body);
  assert.equal(started.status, 200);
  const expected = server.app.directory.enrollmentHandleFor('1001');
  assert.equal(started.body.options.user.id, expected);
  const response = key.register(started.body.options, { origin: server.origin });
  response.userHandle = body.userHandle;
  const finished = await server.parent.post('/_sovereign/auth/enroll/finish', { ...body, response });
  assert.equal(finished.status, 201, JSON.stringify(finished.body));
  const stored = sql(server.db, 'SELECT handle_format,webauthn_user_handle FROM identity_credentials WHERE credential_id=?', [finished.body.credentialId])[0];
  assert.deepEqual(stored, { handle_format: 'isolated-v2', webauthn_user_handle: expected });
  assert.throws(() => server.app.directory.addCredential({ userId: '1001', credentialId: 'missing', kind: 'hardware', publicKey: 'verified-key-without-handle' }), { code: 'INVALID_ENROLLMENT_HANDLE' });
  const view = await server.parent.get('/api/directory');
  assert.equal(JSON.stringify(view.body).includes(expected), false);
  assert.equal(JSON.stringify(server.snapshot()).includes(expected), false);
});

test('repairing an overwritten suite keeps the live suite legacy credentials usable on the same devices', async (t) => {
  const a = await site(t, 'rehearsal');
  const b = await site(t, 'prod');
  const key = createResidentAuthenticator({ kind: 'hardware' });
  const phone = createResidentAuthenticator({ kind: 'synced' });
  const oldA = [await legacyCredential(a, key, true), await legacyCredential(a, phone, false)];
  assert.equal((await a.parent.check(key, { purpose: 'activate', origin: a.origin })).status, 200);
  const oldB = [await legacyCredential(b, key, true), await legacyCredential(b, phone, false)];
  assert.equal((await b.parent.check(key, { purpose: 'activate', origin: b.origin })).status, 200);
  const duplicateBody = { label: 'Do not replace the working legacy key', hardware: true };
  const authority = await b.parent.post('/_sovereign/auth/enroll/options', duplicateBody);
  assert.equal(authority.status, 401);
  const token = await b.parent.actionToken(key, authority.body, { origin: b.origin });
  assert.equal(token.status, 200);
  const duplicate = await b.parent.post('/_sovereign/auth/enroll/options', duplicateBody, { 'X-Sovereign-Action-Token': token.body.token });
  assert.equal(duplicate.status, 200);
  assert.throws(() => key.register(duplicate.body.options, { origin: b.origin }), { name: 'InvalidStateError' });
  assert.equal((await b.parent.check(key, { origin: b.origin })).status, 200);
  await assert.rejects(a.parent.check(key, { origin: a.origin }), { name: 'NotAllowedError' });
  assert.equal((await b.parent.check(phone, { origin: b.origin })).status, 200);
  assert.equal((await a.parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  const newIds = [];
  for (const [device, hardware] of [[key, true], [phone, false]]) {
    const enrolled = await a.parent.enroll(device, { label: hardware ? 'New key' : 'New phone', hardware, origin: a.origin });
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
    newIds.push(enrolled.body.credentialId);
    assert.equal((await a.parent.check(device, { origin: a.origin })).status, 200);
    assert.equal((await b.parent.check(device, { origin: b.origin })).status, 200);
  }
  const rows = sql(a.db, "SELECT credential_id,handle_format,last_used_at FROM identity_credentials WHERE handle_format='isolated-v2'");
  assert.deepEqual(new Set(rows.map((row) => row.credential_id)), new Set(newIds));
  assert.ok(rows.every((row) => row.last_used_at));
  for (const id of oldA) assert.equal((await a.parent.post('/api/directory/credentials/' + id + '/revoke')).status, 200);
  assert.equal((await a.parent.check(key, { purpose: 'activate', origin: a.origin })).status, 200);
  for (const id of oldB) assert.equal(key.hasCredential(id) || phone.hasCredential(id), true);
  assert.equal((await b.parent.check(key, { origin: b.origin })).status, 200);
  assert.equal(sql(b.db, 'SELECT webauthn_v2_issued_at FROM identity_household')[0].webauthn_v2_issued_at, null);
  const originalHandle = a.app.directory.enrollmentHandleFor('1001');
  await a.stop();
  const restarted = await startServer(t, { again: a.root, config: { instance: a.instance } });
  const again = browser(restarted.base, PARENT, { host: a.host });
  assert.equal(restarted.app.directory.enrollmentHandleFor('1001'), originalHandle);
  assert.equal((await again.check(key, { origin: a.origin })).status, 200);
  assert.equal((await b.parent.check(phone, { origin: b.origin })).status, 200);
  await restarted.stop();
});

test('corrupt administrator metadata leaves status and passphrase recovery/revoke available', async (t) => {
  const server = await activeHousehold(t);
  server.db = path.join(server.root, 'state.sqlite3');
  const status = (await server.parent.get('/_sovereign/auth/status')).body;
  const hardware = status.credentials.find((c) => c.kind === 'hardware');
  tamperCredential(server, hardware.credentialId);
  assert.equal((await server.parent.get('/_sovereign/auth/status')).status, 200);
  assert.equal((await server.parent.post('/_sovereign/auth/check/options')).body.code, 'INVALID_CREDENTIAL_HANDLE');
  assert.equal((await server.parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  assert.equal((await server.parent.post('/_sovereign/auth/enroll/options', { label: 'blocked' })).body.code, 'INVALID_CREDENTIAL_HANDLE');
  assert.equal((await server.parent.post('/api/directory/credentials/' + hardware.credentialId + '/revoke')).status, 200);
  assert.equal((await server.parent.check(server.phone)).status, 200);
  assert.equal(server.app.directory.state(), 'recovery');
});

test('an active administrator can revoke a member corrupt credential without prompting through that member', async (t) => {
  const server = await activeHousehold(t);
  server.db = path.join(server.root, 'state.sqlite3');
  server.app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  const actor = { userId: '1001' };
  const member = server.app.directory.addMember(actor, { userId: '1002', role: 'kid' });
  const grant = server.app.directory.issueGrant(actor, member.member_id);
  const kid = browser(server.base, KID);
  const enrolled = await kid.enroll(createAuthenticator(), { label: 'Kid phone', grant: grant.code });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  tamperCredential(server, enrolled.body.credentialId);
  assert.equal((await kid.get('/_sovereign/auth/status')).status, 200);
  assert.equal((await kid.post('/_sovereign/auth/check/options')).body.code, 'INVALID_CREDENTIAL_HANDLE');
  assert.equal((await server.parent.post('/api/directory/credentials/' + enrolled.body.credentialId + '/revoke')).status, 200);
  assert.equal(server.app.directory.state(), 'active');
  assert.equal((await kid.post('/_sovereign/auth/check/options')).body.code, 'NO_CREDENTIAL');
});

test('a damaged member enrollment handle blocks enrollment but not valid existing checks or recovery', async (t) => {
  const server = await activeHousehold(t);
  const db = path.join(server.root, 'state.sqlite3');
  sql(db, 'DROP TRIGGER identity_member_handle_immutable');
  sql(db, "UPDATE identity_members SET webauthn_user_handle=NULL WHERE user_id='1001'");
  server.app.directory.init();
  assert.equal(sql(db, "SELECT webauthn_user_handle FROM identity_members WHERE user_id='1001'")[0].webauthn_user_handle, null);
  assert.equal((await server.parent.check(server.yubikey)).status, 200);
  assert.equal((await server.parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  const refused = await server.parent.post('/_sovereign/auth/enroll/options', { label: 'must-not-fallback' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'INVALID_ENROLLMENT_HANDLE');
  assert.match(refused.body.error, /known-good identity metadata/i);
  assert.equal((await server.parent.check(server.phone)).status, 200);
});

test('known metadata refusal does not spend a valid hardware enrollment token', async (t) => {
  const server = await activeHousehold(t);
  const db = path.join(server.root, 'state.sqlite3');
  const body = { label: 'Backup key', hardware: true };
  const challenge = await server.parent.post('/_sovereign/auth/enroll/options', body);
  const authorized = await server.parent.actionToken(server.yubikey, challenge.body);
  assert.equal(authorized.status, 200);
  const jti = JSON.parse(Buffer.from(authorized.body.token.split('.')[1], 'base64url').toString('utf8')).jti;
  const expected = server.app.directory.enrollmentHandleFor('1001');
  sql(db, 'DROP TRIGGER identity_member_handle_immutable');
  sql(db, 'UPDATE identity_members SET webauthn_user_handle=?', [Buffer.alloc(32, 15).toString('base64url')]);
  server.app.directory.init();
  const headers = { 'X-Sovereign-Action-Token': authorized.body.token };
  const refused = await server.parent.post('/_sovereign/auth/enroll/options', body, headers);
  assert.equal(refused.body.code, 'INVALID_ENROLLMENT_HANDLE');
  assert.equal(sql(db, 'SELECT COUNT(*) AS n FROM identity_action_tokens WHERE jti=?', [jti])[0].n, 0);
  sql(db, 'DROP TRIGGER identity_member_handle_immutable');
  sql(db, 'UPDATE identity_members SET webauthn_user_handle=?', [expected]);
  server.app.directory.init();
  assert.equal((await server.parent.post('/_sovereign/auth/enroll/options', body, headers)).status, 200);
  assert.equal(sql(db, 'SELECT COUNT(*) AS n FROM identity_action_tokens WHERE jti=?', [jti])[0].n, 1);
  assert.equal((await server.parent.post('/_sovereign/auth/enroll/options', body, headers)).body.code, 'REPLAYED');
});
