// Feature-10 SID-005: the passkey service on Home Base's own hostname. Ceremonies run against a software
// authenticator (test/support/authenticator.js); hardware keys attest to a root pinned only here. Who is
// asking comes from tailscaled (stubbed) by X-Forwarded-For; the hostname from Serve's X-Forwarded-Host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parseSnapshot, verifyToken } = require('sovereign-auth');
const { createApp } = require('../src/app');
const { createPasskeys } = require('../src/identity/passkeys');
const { loadSigningKey } = require('../src/identity/signing-key');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { attestationFixture, createAuthenticator } = require('./support/authenticator');

const DOMAIN = 'example-tailnet.ts.net';
const HOMEBASE = `smith-homebase.${DOMAIN}`;
const ORIGIN = `https://${HOMEBASE}`;
const PEERS = {
  '100.64.0.1': { Node: { Tags: [] }, UserProfile: { ID: 1001, LoginName: 'parent@example.com', DisplayName: 'Parent' } },
  '100.64.0.2': { Node: { Tags: [] }, UserProfile: { ID: 1002, LoginName: 'kid@example.com', DisplayName: 'Kid' } },
};
const PARENT = '100.64.0.1';
const KID = '100.64.0.2';
const PASSPHRASE = 'correct horse battery';

async function startServer(t, { cutOver = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-passkeys-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identityDir = path.join(root, 'identity');
  fs.mkdirSync(identityDir, { mode: 0o755 });
  fs.chmodSync(identityDir, 0o755);
  const stateDbPath = path.join(root, 'state.sqlite3');
  if (cutOver) {
    const store = new SqliteStateStore(stateDbPath);
    store.init();
    const { id } = store.createJob({ kind: 'ingress-cutover', target: 'smith', status: 'queued', dryRun: false, createdAt: new Date().toISOString(), currentStep: null, planJson: '{}' });
    store.updateJob(id, { status: 'completed', finishedAt: new Date().toISOString() });
  }
  const app = createApp({
    appName: 'Home Base',
    stateDbPath,
    port: 0,
    bindHost: '127.0.0.1',
    serviceUser: 'sovereign',
    identitySocket: '',
    identitySnapshotFile: path.join(identityDir, 'snapshot.json'),
    ingressCheckDelayMs: 3_600_000,
    healthAlertCheckDelayMs: 3_600_000,
    instance: 'smith',
    defaultDomain: DOMAIN,
    directory: true,
    passkeyRoots: attestationFixture().roots,
    identityWhois: async (addr) => { if (!PEERS[addr]) throw new Error('no such peer'); return PEERS[addr]; },
    identityStatus: async () => ({ Self: { TailscaleIPs: ['100.64.0.100'] } }),
  });
  await new Promise((resolve) => app.listen(resolve));
  t.after(() => new Promise((resolve) => { app.stop(); app.server.close(resolve); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, root, snapshot: () => JSON.parse(fs.readFileSync(path.join(identityDir, 'snapshot.json'), 'utf8')) };
}

// A browser on one tailnet device: its cookies by name, and the hostname it asked for.
function browser(base, addr, { host = HOMEBASE } = {}) {
  const cookies = new Map();
  const request = async (method, url, body) => {
    const headers = { 'x-forwarded-for': addr, 'x-forwarded-host': host };
    if (cookies.size) headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      if (attributes.some((attribute) => attribute.trim() === 'Max-Age=0')) cookies.delete(name);
      else cookies.set(name, pair.slice(at + 1));
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.getSetCookie() };
  };
  const get = (url) => request('GET', url);
  const post = (url, body = {}) => request('POST', url, body);
  return {
    get,
    post,
    cookies,
    async enroll(authenticator, { label = 'key', hardware = false, grant, origin = ORIGIN } = {}) {
      const started = await post('/_sovereign/auth/enroll/options', { label, hardware, grant });
      if (started.status !== 200) return started;
      return post('/_sovereign/auth/enroll/finish', { label, hardware, grant, response: authenticator.register(started.body.options, { origin }) });
    },
    async check(authenticator, { purpose = 'step-up', kind, origin = ORIGIN } = {}) {
      const started = await post('/_sovereign/auth/check/options', { purpose, kind });
      if (started.status !== 200) return started;
      return post('/_sovereign/auth/check/finish', { purpose, kind, response: authenticator.authenticate(started.body.options, { origin }) });
    },
  };
}

// Setup through activation: the founder, a synced passkey and an attested hardware key.
async function activeHousehold(t) {
  const server = await startServer(t);
  const parent = browser(server.base, PARENT);
  assert.equal((await parent.post('/api/admin/setup', { passphrase: PASSPHRASE })).status, 200);
  const phone = createAuthenticator({ kind: 'synced' });
  const yubikey = createAuthenticator({ kind: 'hardware' });
  assert.equal((await parent.enroll(phone, { label: 'Phone' })).status, 201);
  assert.equal((await parent.enroll(yubikey, { label: 'YubiKey', hardware: true })).status, 201);
  const activated = await parent.check(yubikey, { purpose: 'activate' });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return { ...server, parent, phone, yubikey };
}

test('the passkey routes exist only on Home Base\'s own hostname, once the host is cut over', async (t) => {
  const { base } = await startServer(t);
  const shared = browser(base, PARENT, { host: `smith-home.${DOMAIN}` });
  assert.equal((await shared.get('/_sovereign/auth/status')).status, 404);
  assert.equal((await shared.post('/_sovereign/auth/enroll/options', { label: 'x' })).status, 404, 'refused before a ceremony starts');
  assert.equal((await browser(base, PARENT, { host: `smith-helm.${DOMAIN}` }).get('/_sovereign/auth/status')).status, 404);
  assert.equal((await browser(base, PARENT).get('/_sovereign/auth/status')).status, 403, 'on Home Base\'s hostname: there, but only for members');

  const { base: tcpBase } = await startServer(t, { cutOver: false });
  assert.equal((await browser(tcpBase, PARENT).get('/_sovereign/auth/status')).status, 404, 'no per-service hostname, no passkeys');
});

test('setup: the founder enrolls with their passphrase session; kinds come from what the authenticator proves', async (t) => {
  const { base, snapshot } = await startServer(t);
  const parent = browser(base, PARENT);
  const phone = createAuthenticator({ kind: 'synced' });
  assert.equal((await parent.enroll(phone)).body.code, 'NOT_A_MEMBER', 'nobody is a member before the founder unlocks');
  assert.equal((await parent.post('/api/admin/setup', { passphrase: PASSPHRASE })).status, 200);

  const synced = await parent.enroll(phone, { label: 'Phone' });
  assert.equal(synced.status, 201, JSON.stringify(synced.body));
  assert.equal(synced.body.kind, 'synced');
  const claimed = await parent.enroll(createAuthenticator({ kind: 'synced' }), { label: 'Says hardware', hardware: true });
  assert.equal(claimed.body.kind, 'synced', 'asking for hardware proves nothing');
  const yubikey = await parent.enroll(createAuthenticator({ kind: 'hardware' }), { label: 'YubiKey', hardware: true });
  assert.equal(yubikey.body.kind, 'hardware');
  const unattested = await parent.enroll(createAuthenticator({ kind: 'hardware' }), { label: 'No attestation asked' });
  assert.equal(unattested.body.kind, 'device-bound', 'without direct attestation a security key is only device-bound');

  const status = (await parent.get('/_sovereign/auth/status')).body;
  assert.deepEqual(status.credentials.map((credential) => [credential.label, credential.kind]), [['Phone', 'synced'], ['Says hardware', 'synced'], ['YubiKey', 'hardware'], ['No attestation asked', 'device-bound']]);
  assert.equal(status.administratorRuleMet, true);
  assert.equal(status.canActivate, true);

  // Locked again, the founder's identity alone enrolls nothing.
  await parent.post('/api/admin/lock');
  assert.equal((await parent.enroll(createAuthenticator())).body.code, 'ADMIN_UNLOCK_REQUIRED');
  // The signing key is in the snapshot, and the snapshot still parses the way apps read it.
  assert.equal(parseSnapshot(snapshot()).keys.size, 1);
});

test('a ceremony runs only where it started, for the member it started for', async (t) => {
  const { base } = await startServer(t);
  const parent = browser(base, PARENT);
  await parent.post('/api/admin/setup', { passphrase: PASSPHRASE });
  const phone = createAuthenticator();
  const elsewhere = await parent.enroll(phone, { origin: `https://smith-home.${DOMAIN}` });
  assert.equal(elsewhere.status, 400);
  assert.match(elsewhere.body.error, /not_verified/);
  const framed = await parent.post('/_sovereign/auth/enroll/options', { label: 'x' });
  const crossOrigin = await parent.post('/_sovereign/auth/enroll/finish', { label: 'x', response: phone.register(framed.body.options, { origin: ORIGIN, extra: { crossOrigin: true } }) });
  assert.match(crossOrigin.body.error, /cross_origin/);
  const relabelled = await parent.post('/_sovereign/auth/enroll/options', { label: 'first' });
  const swapped = await parent.post('/_sovereign/auth/enroll/finish', { label: 'second', response: phone.register(relabelled.body.options, { origin: ORIGIN }) });
  assert.match(swapped.body.error, /wrong_action/);
  const once = await parent.post('/_sovereign/auth/enroll/options', { label: 'once' });
  const response = phone.register(once.body.options, { origin: ORIGIN });
  assert.equal((await parent.post('/_sovereign/auth/enroll/finish', { label: 'once', response })).status, 201);
  assert.match((await parent.post('/_sovereign/auth/enroll/finish', { label: 'once', response })).body.error, /unknown_challenge/, 'a challenge is used once');
});

test('activation needs the rule met and a fresh ceremony with a hardware key; it is also the first check', async (t) => {
  const { base } = await startServer(t);
  const parent = browser(base, PARENT);
  await parent.post('/api/admin/setup', { passphrase: PASSPHRASE });
  const phone = createAuthenticator();
  const yubikey = createAuthenticator({ kind: 'hardware' });
  await parent.enroll(phone, { label: 'Phone' });
  assert.equal((await parent.check(phone, { purpose: 'activate' })).body.code, 'CANNOT_ACTIVATE', 'one passkey is not enough');
  await parent.enroll(yubikey, { label: 'YubiKey', hardware: true });
  assert.match((await parent.check(phone, { purpose: 'activate' })).body.error, /insufficient_kind/, 'a synced passkey does not activate');
  assert.equal((await parent.get('/api/directory')).body.state, 'setup');

  const activated = await parent.check(yubikey, { purpose: 'activate' });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.state, 'active');
  assert.equal(parent.cookies.has('hb_admin_session'), true, 'the passphrase cookie is still in the browser...');
  const status = (await parent.get('/api/admin/status')).body;
  assert.equal(status.unlocked, true, '...but admin is open by the passkey check');
  assert.equal(status.via, 'passkey');
  assert.equal(status.directoryState, 'active');
});

test('active: the administrator\'s check opens admin from their own identity, on this hostname, until something moves an epoch', async (t) => {
  const { base, parent, phone, snapshot } = await activeHousehold(t);
  const cookie = parent.cookies.get('__Host-sv_assurance');
  const claims = verifyToken(cookie, { keys: parseSnapshot(snapshot()).keys }).payload;
  assert.equal(claims.aud, HOMEBASE);
  assert.equal(claims.sub, '1001');
  assert.equal(claims.kind, 'hardware');
  assert.equal(claims.exp - claims.iat, 8 * 3600);
  const attributes = (await parent.check(phone)).setCookie[0];
  assert.match(attributes, /^__Host-sv_assurance=[^;]+; Secure; HttpOnly; Path=\/; SameSite=Strict; Max-Age=28800$/);
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, true);
  assert.equal((await parent.post('/api/admin/unlock', { passphrase: PASSPHRASE })).body.code, 'RECOVERY_ONLY');

  // The same cookie from another identity, or on another hostname, opens nothing.
  const kid = browser(base, KID);
  kid.cookies.set('__Host-sv_assurance', parent.cookies.get('__Host-sv_assurance'));
  assert.equal((await kid.get('/api/admin/status')).body.unlocked, false);
  const sibling = browser(base, PARENT, { host: `smith-home.${DOMAIN}` });
  sibling.cookies.set('__Host-sv_assurance', parent.cookies.get('__Host-sv_assurance'));
  assert.equal((await sibling.get('/api/admin/status')).body.unlocked, false);
  const local = browser(base, PARENT, { host: undefined });
  assert.equal((await local.get('/api/admin/status')).body.unlocked, false);

  // Lock ends it in this browser.
  await parent.post('/api/admin/lock');
  assert.equal(parent.cookies.has('__Host-sv_assurance'), false);
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, false);

  // Recovery bumps the global epoch: every cookie from before stops working.
  await parent.check(phone);
  const before = parent.cookies.get('__Host-sv_assurance');
  assert.equal((await parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  const stale = browser(base, PARENT);
  stale.cookies.set('__Host-sv_assurance', before);
  assert.equal((await stale.get('/_sovereign/auth/status')).body.check, null);
});

test('active: a member enrolls with the administrator\'s grant, adds and removes passkeys after a recent check', async (t) => {
  const { app, base, parent } = await activeHousehold(t);
  const kid = browser(base, KID);
  // nginx's identity lookup on any Home Base page is what makes the kid a candidate.
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  const candidate = (await parent.get('/api/directory')).body.candidates.find((entry) => entry.login === 'kid@example.com');
  const added = await parent.post('/api/directory/members', { userId: candidate.userId, role: 'kid' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const tablet = createAuthenticator();

  assert.equal((await kid.enroll(tablet)).body.code, 'GRANT_REQUIRED');
  const { code } = (await parent.post(`/api/directory/members/${added.body.memberId}/grant`)).body;
  assert.equal((await kid.enroll(tablet, { grant: 'not-the-code' })).body.code, 'INVALID_GRANT');
  const { code: fresh } = (await parent.post(`/api/directory/members/${added.body.memberId}/grant`)).body;
  assert.notEqual(fresh, code);
  const enrolled = await kid.enroll(tablet, { label: 'Tablet', grant: fresh });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  assert.equal((await kid.enroll(createAuthenticator(), { grant: fresh })).body.code, 'RECENT_CHECK_REQUIRED', 'the grant is spent; now a check is what counts');

  assert.equal((await kid.check(tablet)).status, 200);
  const status = (await kid.get('/_sovereign/auth/status')).body;
  assert.equal(status.check.label, 'Tablet');
  assert.equal(status.member.administrator, false);
  assert.equal((await kid.get('/api/admin/status')).body.unlocked, false, 'a member\'s check is not admin');
  const laptop = createAuthenticator();
  assert.equal((await kid.enroll(laptop, { label: 'Laptop' })).status, 201);

  const tabletId = status.credentials[0].credentialId;
  const removed = await kid.post('/_sovereign/auth/credentials/revoke', { credentialId: tabletId });
  assert.equal(removed.status, 200);
  assert.equal(kid.cookies.has('__Host-sv_assurance'), false, 'the epoch moved, so the cookie is spent');
  assert.equal((await kid.post('/_sovereign/auth/credentials/revoke', { credentialId: tabletId })).body.code, 'RECENT_CHECK_REQUIRED');
  await kid.check(laptop);
  const last = (await kid.get('/_sovereign/auth/status')).body.credentials[0].credentialId;
  assert.equal((await kid.post('/_sovereign/auth/credentials/revoke', { credentialId: last })).body.code, 'LAST_CREDENTIAL');
  assert.match((await kid.check(tablet)).body.error, /unknown_credential/, 'a revoked passkey checks nothing');

  // The administrator's own passkeys don't change here while active.
  assert.equal((await parent.enroll(createAuthenticator())).body.code, 'ADMINISTRATOR_CREDENTIAL');
});

// A POST whose headers go now and whose body goes when the test says: what a client holding its body back
// looks like to Home Base.
function heldPost(base, { addr, cookies, url }) {
  const target = new URL(url, base);
  const req = http.request({ host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: {
    'x-forwarded-for': addr, 'x-forwarded-host': HOMEBASE, 'content-type': 'application/json', cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
  } });
  const answered = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
  });
  req.flushHeaders();
  return { release: (body) => { req.end(JSON.stringify(body)); return answered; } };
}

test('authority is decided after the body arrives: a request held back across activation finds Home Base active', async (t) => {
  const { base } = await startServer(t);
  const parent = browser(base, PARENT);
  await parent.post('/api/admin/setup', { passphrase: PASSPHRASE });
  const phone = createAuthenticator();
  const yubikey = createAuthenticator({ kind: 'hardware' });
  await parent.enroll(phone, { label: 'Phone' });
  await parent.enroll(yubikey, { label: 'YubiKey', hardware: true });
  assert.equal((await parent.check(phone)).status, 200, 'a setup check: the cookie a later passkey session would accept');
  const held = heldPost(base, { addr: PARENT, cookies: parent.cookies, url: '/_sovereign/auth/enroll/options' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await parent.check(yubikey, { purpose: 'activate' })).body.state, 'active');
  const late = await held.release({ label: 'Late key' });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'ADMINISTRATOR_CREDENTIAL', 'judged as active, where administrator passkeys don\'t change');
});

test('recovery is the administrator\'s alone: members neither check in nor change passkeys, and admin credentials change only there', async (t) => {
  const { app, base, parent } = await activeHousehold(t);
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  const memberId = (await parent.post('/api/directory/members', { userId: '1002', role: 'kid' })).body.memberId;
  const { code } = (await parent.post(`/api/directory/members/${memberId}/grant`)).body;
  const kid = browser(base, KID);
  const tablet = createAuthenticator();
  const laptop = createAuthenticator();
  await kid.enroll(tablet, { label: 'Tablet', grant: code });
  await kid.check(tablet);
  await kid.enroll(laptop, { label: 'Laptop' });

  // Active: the admin session doesn't change administrator credentials, from the directory either.
  const adminKeys = (await parent.get('/_sovereign/auth/status')).body.credentials;
  const refused = await parent.post(`/api/directory/credentials/${adminKeys[0].credentialId}/revoke`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'ADMINISTRATOR_CREDENTIAL');

  assert.equal((await parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  const checked = await kid.check(tablet);
  assert.equal(checked.status, 409);
  assert.equal(checked.body.code, 'BOOTSTRAP_STATE');
  assert.equal((await kid.post('/_sovereign/auth/credentials/revoke', { credentialId: (await kid.get('/_sovereign/auth/status')).body.credentials[0].credentialId })).status, 401, 'the old check ended with the global epoch');
  assert.equal((await parent.post(`/api/directory/credentials/${adminKeys[0].credentialId}/revoke`)).status, 200, 'recovery is where they change');
});

test('a check gets the kind the credential has after its update is stored, not the one its assertion verified with', async (t) => {
  const { app, root } = await activeHousehold(t);
  const yubikey = createAuthenticator({ kind: 'hardware' });
  const site = { hostname: HOMEBASE, rpID: DOMAIN };
  // A directory where another finish demotes the credential between this finish's read and its write.
  const demoting = { ...app.directory, recordAssertion: (userId, credentialId, update) => app.directory.recordAssertion(userId, credentialId, { ...update, kind: 'synced', backedUp: true, deviceType: 'multiDevice' }) };
  const passkeys = createPasskeys({ directory: demoting, signingKey: loadSigningKey(path.join(root, 'test-key.pem'), { create: true }), household: 'smith', roots: attestationFixture().roots });
  // Enroll this hardware key straight into the directory, then check with it through the demoting store.
  const enrollPasskeys = createPasskeys({ directory: app.directory, signingKey: loadSigningKey(path.join(root, 'test-key.pem')), household: 'smith', roots: attestationFixture().roots });
  const standing = app.directory.standing('1001');
  const options = await enrollPasskeys.enrollOptions({ site, standing, label: 'Second YubiKey', hardware: true });
  const enrolled = await enrollPasskeys.enrollFinish({ site, standing, label: 'Second YubiKey', hardware: true, response: yubikey.register(options, { origin: ORIGIN }) });
  // Enrolling in active is the routes' to refuse; the directory takes it with the every-time check the next slice adds.
  app.directory.addCredential(enrolled.credential);
  const hardwareOptions = await passkeys.checkOptions({ site, standing, purpose: 'step-up', kind: 'hardware' });
  const refused = await passkeys.checkFinish({ site, standing, purpose: 'step-up', kind: 'hardware', response: yubikey.authenticate(hardwareOptions, { origin: ORIGIN }) });
  assert.deepEqual([refused.ok, refused.reason], [false, 'insufficient_kind']);
  assert.equal(app.directory.credentialsFor('1001').find((credential) => credential.id === yubikey.id).kind, 'synced');
});
