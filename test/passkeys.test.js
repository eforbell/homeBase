// Feature-10 SID-005: the passkey service on Home Base's own hostname. Ceremonies run against a software
// authenticator (test/support/authenticator.js); hardware keys attest to a root pinned only here. Who is
// asking comes from tailscaled (stubbed) by X-Forwarded-For; the hostname from Serve's X-Forwarded-Host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ATTESTATION_ROOTS, createAssurance, createIdentity, parseSnapshot, requestDigest, verifyToken } = require('sovereign-auth');
const { createApp } = require('../src/app');
const { createPasskeys } = require('../src/identity/passkeys');
const { RETIRED_KEEP_SECONDS, createKeyring, loadSigningKey, publishedKeys } = require('../src/identity/signing-key');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { attestationFixture, createAuthenticator } = require('./support/authenticator');

const DOMAIN = 'example-tailnet.ts.net';
const HOMEBASE = `smith-homebase.${DOMAIN}`;
const ORIGIN = `https://${HOMEBASE}`;
// A sensitive app's own hostname (family-pulse, catalog network.dedicatedHostname).
const PULSE = `smith-pulse.${DOMAIN}`;
const PEERS = {
  '100.64.0.1': { Node: { Tags: [] }, UserProfile: { ID: 1001, LoginName: 'parent@example.com', DisplayName: 'Parent' } },
  '100.64.0.2': { Node: { Tags: [] }, UserProfile: { ID: 1002, LoginName: 'kid@example.com', DisplayName: 'Kid' } },
};
const PARENT = '100.64.0.1';
const KID = '100.64.0.2';
const PASSPHRASE = 'correct horse battery';

// whois: the stub's answer for an address, or a test's own in its place (one that pauses, say).
const PEER_WHOIS = async (addr) => { if (!PEERS[addr]) throw new Error('no such peer'); return PEERS[addr]; };

// again: the root of a server this test already ran, to start Home Base again on its files. roots: the
// attestation roots it pins (the test root unless given). alerts: an array that collects health alerts.
async function startServer(t, { cutOver = true, whois = PEER_WHOIS, again = null, roots = attestationFixture().roots, alerts = null } = {}) {
  const root = again || fs.mkdtempSync(path.join(os.tmpdir(), 'hb-passkeys-'));
  const identityDir = path.join(root, 'identity');
  const stateDbPath = path.join(root, 'state.sqlite3');
  if (!again) {
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(identityDir, { mode: 0o755 });
    fs.chmodSync(identityDir, 0o755);
  }
  if (cutOver && !again) {
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
    passkeyRoots: roots,
    ...(alerts ? { healthAlertsEnabled: true, healthAlertsWebhookUrl: 'https://alerts.example/hook', notificationsPostJson: async (url, body) => { alerts.push(body); } } : {}),
    identityWhois: whois,
    identityStatus: async () => ({ Self: { TailscaleIPs: ['100.64.0.100'] } }),
  });
  await new Promise((resolve) => app.listen(resolve));
  let stopped = false;
  const stop = () => new Promise((resolve) => { if (stopped) return resolve(); stopped = true; app.stop(); app.server.close(resolve); });
  t.after(stop);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, root, stop, snapshot: () => JSON.parse(fs.readFileSync(path.join(identityDir, 'snapshot.json'), 'utf8')) };
}

// A browser on one tailnet device: its cookies by name, and the hostname it asked for.
function browser(base, addr, { host = HOMEBASE } = {}) {
  const cookies = new Map();
  const request = async (method, url, body, extra = {}) => {
    const headers = { 'x-forwarded-for': addr, 'x-forwarded-host': host, ...extra };
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
  const post = (url, body = {}, headers = {}) => request('POST', url, body, headers);
  // What stepup.js does with an every-time 401: an action ceremony, then the token.
  async function actionToken(authenticator, stepUp, { origin = ORIGIN } = {}) {
    const action = { policy: stepUp.policy, target: stepUp.target, digest: stepUp.digest };
    const started = await post('/_sovereign/auth/check/options', { purpose: 'action', action });
    if (started.status !== 200) return started;
    return post('/_sovereign/auth/check/finish', { purpose: 'action', action, response: authenticator.authenticate(started.body.options, { origin }) });
  }
  return {
    get,
    post,
    cookies,
    actionToken,
    // A POST, and on an every-time 401 the ceremony with authenticator and one identical retry.
    async confirmed(authenticator, url, body = {}) {
      const first = await post(url, body);
      if (first.status !== 401 || first.body.level !== 'every-time') return { first, retry: null, token: null };
      const issued = await actionToken(authenticator, first.body);
      if (issued.status !== 200) return { first, retry: null, token: null, issued };
      return { first, token: issued.body.token, retry: await post(url, body, { 'x-sovereign-action-token': issued.body.token }) };
    },
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
async function activeHousehold(t, options = {}) {
  const server = await startServer(t, options);
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

test('the passkey routes exist only on per-service hostnames, once the host is cut over', async (t) => {
  const { base } = await startServer(t);
  const shared = browser(base, PARENT, { host: `smith-home.${DOMAIN}` });
  assert.equal((await shared.get('/_sovereign/auth/status')).status, 404);
  assert.equal((await shared.post('/_sovereign/auth/enroll/options', { label: 'x' })).status, 404, 'refused before a ceremony starts');
  assert.equal((await shared.post('/_sovereign/auth/check/options', {})).status, 404, 'no checks on the shared hostname either');
  assert.equal((await browser(base, PARENT, { host: `smith-helm.${DOMAIN}` }).get('/_sovereign/auth/status')).status, 404, 'a sensitive app\'s hostname has checks only');
  assert.equal((await browser(base, PARENT, { host: `smith-nosuchapp.${DOMAIN}` }).post('/_sovereign/auth/check/options', {})).status, 404, 'only hostnames this host serves');
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

  // The administrator's own passkeys change here while active only with a hardware key every time.
  assert.equal((await parent.enroll(createAuthenticator())).body.code, 'HARDWARE_CHECK_REQUIRED');
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
  assert.equal(late.status, 401);
  assert.equal(late.body.code, 'HARDWARE_CHECK_REQUIRED', 'judged as active, where administrator passkeys need a hardware key every time');
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

test('a passphrase rotated while a setup enrollment waits on the identity lookup refuses that enrollment', async (t) => {
  // Lets `skip` lookups through, then holds the next one until released.
  const gate = { armed: false, skip: 0 };
  const whois = async (addr) => {
    if (gate.armed && gate.skip-- === 0) {
      gate.armed = false;
      gate.reached();
      await gate.released;
    }
    return PEER_WHOIS(addr);
  };
  const { base } = await startServer(t, { whois });
  const parent = browser(base, PARENT);
  await parent.post('/api/admin/setup', { passphrase: PASSPHRASE });
  const phone = createAuthenticator();
  const started = await parent.post('/_sovereign/auth/enroll/options', { label: 'Phone' });
  const response = phone.register(started.body.options, { origin: ORIGIN });

  let release;
  const reached = new Promise((resolve) => { gate.reached = resolve; });
  gate.released = new Promise((resolve) => { release = resolve; });
  Object.assign(gate, { armed: true, skip: 1 });
  // The finish's first lookup names the caller; its second checks the passphrase session, and waits.
  const finishing = parent.post('/_sovereign/auth/enroll/finish', { label: 'Phone', response });
  await reached;
  const other = browser(base, PARENT);
  for (const [name, value] of parent.cookies) other.cookies.set(name, value);
  assert.equal((await other.post('/api/admin/rotate', { currentPassphrase: PASSPHRASE, newPassphrase: 'a brand new passphrase' })).status, 200);
  release();
  const finished = await finishing;
  assert.equal(finished.status, 409);
  assert.equal(finished.body.code, 'PASSPHRASE_CHANGED');
  assert.deepEqual((await other.get('/_sovereign/auth/status')).body.credentials, []);
});

const payloadOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

test('active: the administrator adds and removes their passkeys with a hardware key every time, one confirmation per request', async (t) => {
  const { app, parent, phone, yubikey } = await activeHousehold(t);
  const memberId = app.directory.describe().members[0].memberId;
  const body = { label: 'Backup key', hardware: true };
  const first = await parent.post('/_sovereign/auth/enroll/options', body);
  assert.equal(first.status, 401);
  const { error, policy, level, kind, target, code } = first.body;
  assert.deepEqual({ error, policy, level, kind, target, code }, { error: 'step_up_required', policy: 'manage-admin-credential', level: 'every-time', kind: 'hardware', target: `enroll:${memberId}`, code: 'HARDWARE_CHECK_REQUIRED' });
  assert.equal(first.body.digest, requestDigest({ method: 'POST', url: '/_sovereign/auth/enroll/options', body: JSON.stringify(body), target }), 'the wire contract\'s digest of this exact request');

  assert.match((await parent.actionToken(phone, first.body)).body.error, /insufficient_kind/, 'only a hardware key confirms it');
  const issued = await parent.actionToken(yubikey, first.body);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const claims = payloadOf(issued.body.token);
  assert.deepEqual({ typ: claims.typ, aud: claims.aud, app: claims.app, act: claims.act, tgt: claims.tgt, dig: claims.dig, kind: claims.kind, life: claims.exp - claims.iat },
    { typ: 'action', aud: HOMEBASE, app: 'homebase', act: 'manage-admin-credential', tgt: target, dig: first.body.digest, kind: 'hardware', life: 60 });
  const token = { 'x-sovereign-action-token': issued.body.token };

  const changed = await parent.post('/_sovereign/auth/enroll/options', { label: 'Another', hardware: true }, token);
  assert.equal(changed.status, 401, 'a token for one request is no use for a changed one');

  const both = await Promise.all([parent.post('/_sovereign/auth/enroll/options', body, token), parent.post('/_sovereign/auth/enroll/options', body, token)]);
  assert.deepEqual(both.map((answer) => answer.status).sort(), [200, 409], 'the identical request, once');
  assert.equal(both.find((answer) => answer.status === 409).body.code, 'REPLAYED');
  const backup = createAuthenticator({ kind: 'hardware' });
  const options = both.find((answer) => answer.status === 200).body.options;
  const added = await parent.post('/_sovereign/auth/enroll/finish', { ...body, response: backup.register(options, { origin: ORIGIN }) });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.kind, 'hardware');

  const keys = Object.fromEntries((await parent.get('/_sovereign/auth/status')).body.credentials.map((credential) => [credential.label, credential.credentialId]));
  const removal = await parent.confirmed(backup, '/_sovereign/auth/credentials/revoke', { credentialId: keys.Phone });
  assert.equal(removal.first.body.target, `revoke:${keys.Phone}`);
  assert.equal(removal.retry.status, 200, JSON.stringify(removal.retry.body));
  assert.equal(parent.cookies.has('__Host-sv_assurance'), false, 'the epoch moved, so the admin session is spent');
  const replayed = await parent.post('/_sovereign/auth/credentials/revoke', { credentialId: keys.Phone }, { 'x-sovereign-action-token': removal.token });
  assert.equal(replayed.status, 404, 'replayed, it finds nothing left to remove');
  assert.equal(payloadOf(removal.token).epoch + 1, app.directory.describe().members[0].epoch, 'and its epoch is spent besides');

  // D11 still holds, and a refused change leaves its token unspent.
  const last = await parent.confirmed(backup, '/_sovereign/auth/credentials/revoke', { credentialId: keys.YubiKey });
  assert.equal(last.retry.body.code, 'LAST_ADMINISTRATOR_CREDENTIAL');
  assert.equal((await parent.post('/_sovereign/auth/credentials/revoke', { credentialId: keys.YubiKey }, { 'x-sovereign-action-token': last.token })).body.code, 'LAST_ADMINISTRATOR_CREDENTIAL');
  assert.equal((await parent.post('/_sovereign/auth/credentials/revoke', { credentialId: 'someone-elses' })).status, 404, 'only their own passkeys here');
});

test('a confirmation is the administrator\'s, for an every-time action, in active Home Base, and binds the target it names', async (t) => {
  const { app, base, parent, yubikey } = await activeHousehold(t);
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  const memberId = (await parent.post('/api/directory/members', { userId: '1002', role: 'kid' })).body.memberId;
  const { code } = (await parent.post(`/api/directory/members/${memberId}/grant`)).body;
  const kid = browser(base, KID);
  const tablet = createAuthenticator();
  await kid.enroll(tablet, { label: 'Tablet', grant: code });
  const digest = 'A'.repeat(43);
  const ask = (who, action) => who.post('/_sovereign/auth/check/options', { purpose: 'action', action });
  assert.equal((await ask(kid, { policy: 'manage-admin-credential', target: 'enroll:x', digest })).body.code, 'NOT_AUTHORIZED');
  assert.equal((await ask(parent, { policy: 'open-admin', target: '', digest })).status, 400, 'a session policy takes a check, not a token');
  assert.equal((await ask(parent, { policy: 'no-such-policy', target: '', digest })).status, 400);
  assert.equal((await ask(parent, { policy: 'manage-admin-credential', target: 'a\nb', digest })).status, 400);
  assert.equal((await ask(parent, { policy: 'manage-admin-credential', target: '', digest: 'short' })).status, 400);

  const enroll = await parent.post('/_sovereign/auth/enroll/options', { label: 'x' });
  const issued = await parent.actionToken(yubikey, enroll.body);
  const keys = (await parent.get('/_sovereign/auth/status')).body.credentials;
  const elsewhere = await parent.post('/_sovereign/auth/credentials/revoke', { credentialId: keys[0].credentialId }, { 'x-sovereign-action-token': issued.body.token });
  assert.equal(elsewhere.status, 401, 'an enrollment\'s token removes nothing');

  assert.equal((await parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  assert.equal((await ask(parent, { policy: 'manage-admin-credential', target: 'enroll:x', digest })).body.code, 'BOOTSTRAP_STATE');
});

test('an administrator\'s enrollment finishes only with a challenge a confirmation bought, at the epochs it saw', async (t) => {
  const { app, parent, yubikey } = await activeHousehold(t);
  const body = { label: 'Spare' };
  const { retry } = await parent.confirmed(yubikey, '/_sovereign/auth/enroll/options', body);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  // Between the start and the finish, a removal moves the administrator's epoch.
  const admin = app.directory.describe().members[0];
  app.directory.addCredential({ userId: admin.userId, credentialId: 'extra-key', kind: 'hardware' });
  const phone = admin.credentials.find((credential) => credential.label === 'Phone').credentialId;
  app.directory.revokeCredential({ userId: admin.userId }, phone, { hardwareEveryTime: true });
  const finished = await parent.post('/_sovereign/auth/enroll/finish', { ...body, response: createAuthenticator().register(retry.body.options, { origin: ORIGIN }) });
  assert.equal(finished.status, 400, JSON.stringify(finished.body));
  assert.equal(finished.body.code, 'CEREMONY_REFUSED');

  // And the same start, finished at once, enrolls.
  const again = await parent.confirmed(yubikey, '/_sovereign/auth/enroll/options', body);
  const spare = await parent.post('/_sovereign/auth/enroll/finish', { ...body, response: createAuthenticator().register(again.retry.body.options, { origin: ORIGIN }) });
  assert.equal(spare.status, 201, JSON.stringify(spare.body));
});

test('an action token\'s jti is used once across processes and restarts, and only while the member still stands', async (t) => {
  const { app, root } = await activeHousehold(t);
  const member = app.directory.describe().members[0];
  const standing = app.directory.standing(member.userId);
  const expect = { userId: member.userId, state: standing.state, globalEpoch: standing.globalEpoch, epoch: standing.member.epoch };
  const action = (jti) => ({ jti, app: 'helm', expiresAt: Math.floor(Date.now() / 1000) + 60 });
  // Two processes at once, each its own connection: exactly one takes it.
  const script = `const { createDirectoryStore } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'identity', 'directory-store'))});
    const store = createDirectoryStore(process.argv[1]);
    process.stdout.write(JSON.stringify(store.consume(JSON.parse(process.argv[2]))));`;
  const request = JSON.stringify({ action: action('shared'), expect, now: new Date().toISOString(), nowSeconds: Math.floor(Date.now() / 1000) });
  const { spawn } = require('child_process');
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script, path.join(root, 'state.sqlite3'), request]);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => resolve(JSON.parse(out)));
  });
  const results = await Promise.all([run(), run(), run()]);
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  assert.ok(results.filter((result) => !result.ok).every((result) => result.replayed));
  assert.equal(app.directory.consumeAction(action('shared'), expect), 'replayed', 'and stays used for the directory in this process');
  assert.equal(app.directory.consumeAction(action('fresh'), { ...expect, epoch: expect.epoch + 1 }), 'stale', 'a member who moved redeems nothing');
  assert.equal(app.directory.consumeAction(action('fresh'), expect), 'redeemed', 'and the stale attempt did not use it up');
});

test('stepup.js is served on Home Base\'s hostname and each sensitive app\'s, as a script', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/_sovereign/auth/stepup.js`, { headers: { 'x-forwarded-host': HOMEBASE } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await res.text(), /window\.SovereignStepUp/);
  assert.equal((await fetch(`${base}/_sovereign/auth/stepup.js`, { headers: { 'x-forwarded-host': PULSE } })).status, 200, 'and on a sensitive app\'s, for its pages');
  assert.equal((await fetch(`${base}/_sovereign/auth/stepup.js`, { headers: { 'x-forwarded-host': `smith-home.${DOMAIN}` } })).status, 404);
});

// What a sensitive app does with the cookie (sovereignAuth's createAssurance), reading Home Base's snapshot.
function appAssurance(snapshot, { appId = 'family-pulse', hostname = PULSE } = {}) {
  const reader = { current: () => ({ ok: true, snapshot: parseSnapshot(snapshot()) }) };
  const identity = createIdentity({ appId, mode: 'tailnet', listen: 'unix:/run/test.sock', reader });
  const assurance = createAssurance({ appId, hostname, identity, redeem: async () => ({ redeemed: false, reason: 'unused' }) });
  return (key, member, cookies) => assurance.check(key, {
    method: 'GET',
    url: '/pulse/',
    headers: { 'x-sovereign-user-id': member.user_id, 'x-sovereign-login': member.login, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') },
  });
}

test('a sensitive app\'s hostname runs checks only: its own cookie, which that app accepts and no other hostname does', async (t) => {
  const { base, parent, phone, yubikey, snapshot } = await activeHousehold(t);
  const pulse = browser(base, PARENT, { host: PULSE });
  const origin = `https://${PULSE}`;
  for (const [method, url] of [['GET', 'status'], ['POST', 'enroll/options'], ['POST', 'enroll/finish'], ['POST', 'credentials/revoke']]) {
    assert.equal((method === 'GET' ? await pulse.get(`/_sovereign/auth/${url}`) : await pulse.post(`/_sovereign/auth/${url}`, { label: 'x' })).status, 404, `${method} ${url} is Home Base's hostname's alone (D21)`);
  }
  assert.equal((await pulse.post('/_sovereign/auth/check/options', { purpose: 'activate' })).body.code, 'INVALID');
  const digest = requestDigest({ method: 'POST', url: '/x', body: '{}', target: 'enroll:m' });
  assert.equal((await pulse.post('/_sovereign/auth/check/options', { purpose: 'action', action: { policy: 'manage-admin-credential', target: 'enroll:m', digest } })).body.code, 'INVALID', 'no action tokens here');

  const member = snapshot().members.find((entry) => entry.login === 'parent@example.com');
  const check = appAssurance(snapshot);
  assert.equal((await check('open-documents', member, pulse.cookies)).body.error, 'step_up_required', 'no check yet');
  assert.equal((await pulse.check(yubikey, { origin: `https://${HOMEBASE}` })).status, 400, 'a ceremony answered for another hostname is refused');
  const checked = await pulse.check(phone, { origin });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.kind, 'synced');
  const cookie = checked.setCookie.find((line) => line.startsWith('__Host-sv_assurance='));
  assert.match(cookie, /Max-Age=2592000/, 'as long as the longest app session (open-documents, 30 days)');
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Domain=/i, 'host-only');
  const opened = await check('open-documents', member, pulse.cookies);
  assert.equal(opened.allowed, true, JSON.stringify(opened.body));
  assert.equal(opened.member.userId, member.user_id);
  assert.equal((await check('export-data', member, pulse.cookies)).allowed, true, 'and it is a recent check, for 5 minutes');
  assert.equal((await appAssurance(snapshot, { appId: 'helm', hostname: `smith-helm.${DOMAIN}` })('open-operator', member, pulse.cookies)).body.error, 'step_up_required', 'another app\'s hostname refuses it (aud)');

  // It opens nothing on Home Base: the admin session is Home Base's hostname's own.
  const atHomeBase = browser(base, PARENT);
  for (const [name, value] of pulse.cookies) atHomeBase.cookies.set(name, value);
  assert.equal((await atHomeBase.get('/api/admin/status')).body.unlocked, false);
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, true, 'the administrator\'s own Home Base check still stands');

  // Signing out on the app's hostname ends that cookie only.
  const out = await pulse.post('/_sovereign/auth/sign-out');
  assert.equal(out.status, 200);
  assert.equal((await check('open-documents', member, pulse.cookies)).body.error, 'step_up_required');
});

test('a check answered before a recovery is refused after it, even once Home Base is active again', async (t) => {
  const { base, parent, phone, yubikey } = await activeHousehold(t);
  const pulse = browser(base, PARENT, { host: PULSE });
  // Both answered, neither finished: on the app's hostname and on Home Base's (the admin session).
  const appStarted = await pulse.post('/_sovereign/auth/check/options', {});
  const appAnswer = phone.authenticate(appStarted.body.options, { origin: `https://${PULSE}` });
  const adminStarted = await parent.post('/_sovereign/auth/check/options', {});
  const adminAnswer = phone.authenticate(adminStarted.body.options, { origin: ORIGIN });

  assert.equal((await parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  assert.equal((await parent.check(yubikey, { purpose: 'activate' })).status, 200, 'active again');
  parent.cookies.delete('__Host-sv_assurance');

  const late = await pulse.post('/_sovereign/auth/check/finish', { response: appAnswer });
  assert.equal(late.status, 400);
  assert.match(late.body.error, /wrong_action/);
  assert.equal(late.setCookie.length, 0, 'no cookie');
  const lateAdmin = await parent.post('/_sovereign/auth/check/finish', { response: adminAnswer });
  assert.match(lateAdmin.body.error, /wrong_action/);
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, false, 'no admin session from it');
});

test('a check runs only on the hostname it started on: no swaps between an app\'s and Home Base\'s', async (t) => {
  const { base, parent, phone } = await activeHousehold(t);
  const pulse = browser(base, PARENT, { host: PULSE });
  parent.cookies.delete('__Host-sv_assurance');
  const swaps = [
    [pulse, parent, `https://${PULSE}`],
    [pulse, parent, ORIGIN],
    [parent, pulse, ORIGIN],
    [parent, pulse, `https://${PULSE}`],
  ];
  for (const [from, to, origin] of swaps) {
    const started = await from.post('/_sovereign/auth/check/options', {});
    const finished = await to.post('/_sovereign/auth/check/finish', { response: phone.authenticate(started.body.options, { origin }) });
    assert.equal(finished.status, 400, `${origin}: ${JSON.stringify(finished.body)}`);
    assert.equal(finished.setCookie.length, 0);
  }
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, false);
});

test('the hostname may carry the default port, as nginx admits it, and no other', async (t) => {
  const { base, phone, snapshot } = await activeHousehold(t);
  const script = (host) => fetch(`${base}/_sovereign/auth/stepup.js`, { headers: { 'x-forwarded-host': host } }).then((res) => res.status);
  assert.equal(await script(`${PULSE}:443`), 200);
  assert.equal(await script(`${PULSE}:8443`), 404);
  const withPort = browser(base, PARENT, { host: `${PULSE}:443` });
  const started = await withPort.post('/_sovereign/auth/check/options', {});
  const checked = await withPort.post('/_sovereign/auth/check/finish', { response: phone.authenticate(started.body.options, { origin: `https://${PULSE}` }) });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  const cookie = verifyToken(withPort.cookies.get('__Host-sv_assurance'), { keys: parseSnapshot(snapshot()).keys });
  assert.equal(cookie.payload.aud, PULSE, 'the cookie names the hostname, not the port');
});

test('on a sensitive app\'s hostname a check needs active Home Base, and a member with no passkey is sent to Home Base', async (t) => {
  const { app, base, parent } = await activeHousehold(t);
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  assert.equal((await parent.post('/api/directory/members', { userId: '1002', role: 'kid' })).status, 201);
  const none = await browser(base, KID, { host: PULSE }).post('/_sovereign/auth/check/options', {});
  assert.equal(none.body.code, 'NO_CREDENTIAL');
  assert.match(none.body.error, /Home Base/);
  assert.equal((await browser(base, '100.64.0.9', { host: PULSE }).post('/_sovereign/auth/check/options', {})).body.code, 'NOT_A_MEMBER');

  assert.equal((await parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  const pulse = browser(base, PARENT, { host: PULSE });
  const started = await pulse.post('/_sovereign/auth/check/options', {});
  assert.equal(started.status, 409);
  assert.equal(started.body.code, 'BOOTSTRAP_STATE', 'apps stay closed in recovery, even to the administrator');
});

test('an action token lives 60 seconds and binds every claim it names', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-action-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-04T12:00:00Z');
  const passkeys = createPasskeys({ directory: {}, signingKey: loadSigningKey(path.join(root, 'key.pem'), { create: true }), household: 'smith', roots: attestationFixture().roots, now: () => clock });
  const site = { hostname: HOMEBASE, rpID: DOMAIN };
  const standing = { member: { userId: '1001', status: 'active', epoch: 3, administrator: true }, globalEpoch: 2, state: 'active' };
  const want = { site, standing, app: 'homebase', policyKey: 'manage-admin-credential', target: 'enroll:m_1', digest: 'D'.repeat(43) };
  const token = passkeys.issueActionToken({ site, standing, app: 'homebase', act: 'manage-admin-credential', tgt: 'enroll:m_1', dig: 'D'.repeat(43), credentialId: 'c', kind: 'hardware' });
  const headers = { 'x-sovereign-action-token': token };
  assert.ok(passkeys.actionToken(headers, want).claims);
  assert.equal(passkeys.actionToken({}, want).reason, 'no_token');
  assert.equal(passkeys.actionToken(headers, { ...want, app: 'helm' }).reason, 'wrong_app');
  assert.equal(passkeys.actionToken(headers, { ...want, policyKey: 'grant-administrator' }).reason, 'wrong_action');
  assert.equal(passkeys.actionToken(headers, { ...want, target: 'enroll:m_2' }).reason, 'wrong_target');
  assert.equal(passkeys.actionToken(headers, { ...want, digest: 'E'.repeat(43) }).reason, 'wrong_digest');
  assert.equal(passkeys.actionToken(headers, { ...want, site: { ...site, hostname: `smith-helm.${DOMAIN}` } }).reason, 'wrong_audience');
  assert.equal(passkeys.actionToken(headers, { ...want, standing: { ...standing, member: { ...standing.member, epoch: 4 } } }).reason, 'stale_epoch');
  assert.equal(passkeys.actionToken(headers, { ...want, standing: { ...standing, globalEpoch: 3 } }).reason, 'stale_global_epoch');
  const synced = passkeys.issueActionToken({ site, standing, app: 'homebase', act: 'manage-admin-credential', tgt: 'enroll:m_1', dig: 'D'.repeat(43), credentialId: 'c', kind: 'synced' });
  assert.equal(passkeys.actionToken({ 'x-sovereign-action-token': synced }, want).reason, 'wrong_kind');
  const cookieLike = passkeys.issueCookie({ site, standing, credentialId: 'c', kind: 'hardware', windowSeconds: 60 }).split(';')[0].split('=').slice(1).join('=');
  assert.equal(passkeys.actionToken({ 'x-sovereign-action-token': cookieLike }, want).reason, 'wrong_type', 'an assurance cookie is not an action token');
  clock += 59_000;
  assert.ok(passkeys.actionToken(headers, want).claims);
  clock += 1_000;
  assert.equal(passkeys.actionToken(headers, want).reason, 'expired');
});

test('a spent action token is refused at its expiry, not taken again once its record could be dropped', async (t) => {
  const { app, root } = await activeHousehold(t);
  const { createDirectoryStore } = require('../src/identity/directory-store');
  const store = createDirectoryStore(path.join(root, 'state.sqlite3'));
  const member = app.directory.describe().members[0];
  const standing = app.directory.standing(member.userId);
  const expect = { userId: member.userId, state: standing.state, globalEpoch: standing.globalEpoch, epoch: standing.member.epoch };
  const exp = Math.floor(Date.now() / 1000) + 60;
  const at = (nowSeconds, jti = 'spent') => store.consume({ action: { jti, app: 'homebase', expiresAt: exp }, expect, now: new Date().toISOString(), nowSeconds });
  assert.deepEqual(at(exp - 10), { ok: true });
  assert.deepEqual(at(exp - 1), { ok: false, replayed: true });
  assert.deepEqual(at(exp), { ok: false, expired: true }, 'at its expiry second it is refused, not re-taken');
  assert.deepEqual(at(exp + 5, 'never-used'), { ok: false, expired: true }, 'nor is any token past its expiry');
  assert.deepEqual(at(exp - 1), { ok: false, replayed: true }, 'and the spent record is still there');
});

// The cookie a member's browser holds on PULSE after a check there.
async function pulseCheck(base, authenticator) {
  const pulse = browser(base, PARENT, { host: PULSE });
  assert.equal((await pulse.check(authenticator, { origin: `https://${PULSE}` })).status, 200);
  return pulse;
}
const ROTATE = '/_sovereign/auth/signing-key/rotate';

test('rotating the signing key takes a hardware key every time and ends nobody\'s session', async (t) => {
  const { base, parent, phone, yubikey, snapshot } = await activeHousehold(t);
  const member = snapshot().members.find((entry) => entry.login === 'parent@example.com');
  const pulse = await pulseCheck(base, phone);
  const before = snapshot().keys.map((key) => key.kid);
  assert.equal(before.length, 1);

  const withPhone = await parent.confirmed(phone, ROTATE, {});
  assert.equal(withPhone.first.status, 401);
  assert.equal(withPhone.first.body.policy, 'privileged-plan');
  assert.equal(withPhone.first.body.target, 'signing-key:rotate');
  assert.equal(withPhone.token, null, 'a synced passkey does not confirm it');
  const rotated = await parent.confirmed(yubikey, ROTATE, {});
  assert.equal(rotated.retry.status, 200, JSON.stringify(rotated.retry.body));
  assert.equal(rotated.retry.body.dropped, false);
  const after = snapshot().keys.map((key) => key.kid);
  assert.deepEqual(after, [rotated.retry.body.kid, before[0]], 'the new key first, the old one kept');
  assert.equal(parseSnapshot(snapshot()).keys.size, 2, 'and apps read both');

  assert.equal((await appAssurance(snapshot)('open-documents', member, pulse.cookies)).allowed, true, 'the app session from before stands');
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, true, 'so does the admin session');
  const again = await pulseCheck(base, phone);
  assert.equal(verifyToken(again.cookies.get('__Host-sv_assurance'), { keys: parseSnapshot(snapshot()).keys }).payload.kid, rotated.retry.body.kid, 'new checks are signed with the new key');
  const status = (await parent.get('/_sovereign/auth/status')).body;
  assert.equal(status.signingKey.kid, rotated.retry.body.kid);
  assert.deepEqual(status.signingKey.previous.map((key) => key.kid), [before[0]]);

  assert.equal((await parent.post(ROTATE, {}, { 'x-sovereign-action-token': rotated.token })).body.code, 'REPLAYED', 'one confirmation, one rotation');
});

test('a rotation for an exposed key drops every earlier key, and every session it signed ends', async (t) => {
  const { base, parent, phone, yubikey, snapshot } = await activeHousehold(t);
  const member = snapshot().members.find((entry) => entry.login === 'parent@example.com');
  const pulse = await pulseCheck(base, phone);
  assert.equal((await parent.confirmed(yubikey, ROTATE, {})).retry.status, 200);
  const exposed = await parent.confirmed(yubikey, ROTATE, { exposed: true });
  assert.equal(exposed.retry.status, 200, JSON.stringify(exposed.retry.body));
  assert.equal(exposed.retry.body.dropped, true);
  assert.deepEqual(snapshot().keys.map((key) => key.kid), [exposed.retry.body.kid]);
  const refused = await appAssurance(snapshot)('open-documents', member, pulse.cookies);
  assert.equal(refused.body.error, 'step_up_required', 'the app session ended');
  assert.equal(refused.reason, 'unknown_kid');
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, false, 'and the admin session, this one included');
  assert.equal((await parent.check(yubikey)).status, 200);
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, true, 'a new check opens it again');
});

test('only the administrator rotates the signing key, on Home Base\'s hostname, in active Home Base', async (t) => {
  const { app, base, parent, yubikey } = await activeHousehold(t);
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  const memberId = (await parent.post('/api/directory/members', { userId: '1002', role: 'kid' })).body.memberId;
  const { code } = (await parent.post(`/api/directory/members/${memberId}/grant`)).body;
  const kid = browser(base, KID);
  await kid.enroll(createAuthenticator(), { label: 'Tablet', grant: code });
  assert.equal((await kid.post(ROTATE, {})).body.code, 'NOT_AUTHORIZED');
  assert.equal((await kid.get('/_sovereign/auth/status')).body.signingKey, undefined, 'a member is not shown the key');
  assert.equal((await browser(base, PARENT, { host: PULSE }).post(ROTATE, {})).status, 404);
  const enrollToken = await parent.actionToken(yubikey, (await parent.post('/_sovereign/auth/enroll/options', { label: 'k' })).body);
  assert.equal((await parent.post(ROTATE, {}, { 'x-sovereign-action-token': enrollToken.body.token })).status, 401, 'another action\'s confirmation does not rotate');
  assert.equal((await parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  assert.equal((await parent.post(ROTATE, {})).body.code, 'BOOTSTRAP_STATE');
});

test('a retired key is published for one session window, and an interrupted rotation lists no key twice', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-keyring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'identity-signing-key.pem');
  let clock = Date.parse('2026-11-04T12:00:00Z');
  const keyring = createKeyring(file, { now: () => clock });
  const first = keyring.current().kid;
  const { kid: second } = keyring.rotate();
  assert.deepEqual(keyring.published().map((key) => key.kid), [second, first]);
  assert.equal(keyring.verifying().size, 2);
  assert.equal((fs.statSync(path.join(root, 'identity-signing-key-retired.json')).mode & 0o777), 0o600);
  clock += RETIRED_KEEP_SECONDS * 1000 - 1000;
  assert.equal(keyring.published().length, 2, 'still within the longest session');
  clock += 2000;
  assert.deepEqual(keyring.published().map((key) => key.kid), [second], 'gone once no cookie it signed can be alive');
  assert.equal(keyring.verifying().size, 1);

  // A rotation stopped after its list was written: the key that stayed current is listed as retired too.
  const list = path.join(root, 'identity-signing-key-retired.json');
  fs.writeFileSync(list, JSON.stringify({ format: 1, keys: [{ ...keyring.current().published, retired_at: new Date(clock).toISOString() }] }), { mode: 0o600 });
  assert.deepEqual(publishedKeys(file, { now: () => clock }).map((key) => key.kid), [second]);
  assert.doesNotThrow(() => parseSnapshot({ format: 1, household: 'h', generation: 1, written_at: new Date(clock).toISOString(), global_epoch: 0, keys: publishedKeys(file, { now: () => clock }), members: [] }));

  // Losing the key makes a new one; nothing else is lost.
  fs.rmSync(file);
  const fresh = createKeyring(file, { now: () => clock });
  assert.notEqual(fresh.current().kid, second);
});

test('losing the signing key ends sessions and nothing else', async (t) => {
  const { root, stop, parent, yubikey, snapshot } = await activeHousehold(t);
  await stop();
  fs.rmSync(path.join(root, 'identity-signing-key.pem'));
  const { base: restarted } = await startServer(t, { again: root });
  const same = browser(restarted, PARENT);
  for (const [name, value] of parent.cookies) same.cookies.set(name, value);
  assert.equal((await same.get('/api/admin/status')).body.unlocked, false, 'the old cookie no longer verifies');
  const status = (await same.get('/_sovereign/auth/status')).body;
  assert.equal(status.state, 'active');
  assert.equal(status.credentials.length, 2, 'passkeys are kept');
  assert.equal((await same.check(yubikey)).status, 200);
  assert.equal((await same.get('/api/admin/status')).body.unlocked, true);
  assert.equal(snapshot().keys.length, 1);
});

test('a removed attestation root demotes its keys at the next start, and a stranded administrator is told', async (t) => {
  const alerts = [];
  const { root, stop, parent, snapshot } = await activeHousehold(t, { alerts });
  const epochBefore = snapshot().members[0].epoch;
  await stop();
  // The next release no longer pins the root the YubiKey verified against.
  const { base } = await startServer(t, { again: root, roots: ATTESTATION_ROOTS, alerts });
  const same = browser(base, PARENT);
  for (const [name, value] of parent.cookies) same.cookies.set(name, value);
  assert.equal((await same.get('/api/admin/status')).body.unlocked, false, 'the epoch moved: no cookie still says hardware');
  assert.equal(snapshot().members[0].epoch, epochBefore + 1);
  const status = (await same.get('/_sovereign/auth/status')).body;
  assert.deepEqual(status.credentials.map((credential) => [credential.label, credential.kind]), [['Phone', 'synced'], ['YubiKey', 'device-bound']]);
  assert.equal(status.administratorRuleMet, false);
  const notice = alerts.find((alert) => alert.event === 'administrator-hardware-key-lost');
  assert.ok(notice, JSON.stringify(alerts));
  assert.deepEqual(notice.administrators, ['parent@example.com']);
  assert.match(notice.adminUrl, /^https:\/\/smith-homebase\.example-tailnet\.ts\.net\/admin$/);
});

test('entering recovery sends a notice every time, and a failing webhook does not stop it', async (t) => {
  const alerts = [];
  const { parent } = await activeHousehold(t, { alerts });
  assert.equal((await parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  const notice = alerts.find((alert) => alert.event === 'identity-recovery-entered');
  assert.ok(notice, JSON.stringify(alerts));
  assert.equal(notice.login, 'parent@example.com');
  assert.match(notice.message, /If this wasn't you/);
  assert.equal(alerts.filter((alert) => alert.event === 'administrator-hardware-key-lost').length, 0, 'nothing stranded');

  const { parent: other } = await activeHousehold(t, { alerts: { push() { throw new Error('webhook down'); } } });
  assert.equal((await other.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200, 'recovery does not wait on the notice');
});

test('a rotation is flushed to disk before it is reported, and a snapshot that can\'t be written is reported', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-keyring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyring = createKeyring(path.join(root, 'identity-signing-key.pem'));
  const synced = [];
  const real = fs.fsyncSync;
  fs.fsyncSync = (fd) => { synced.push(fd); return real(fd); };
  try {
    keyring.rotate({ exposed: true });
  } finally {
    fs.fsyncSync = real;
  }
  assert.equal(synced.length, 4, 'both files and, after each rename, their directory');

  const { root: home, parent, yubikey, snapshot } = await activeHousehold(t);
  const before = snapshot().keys.map((key) => key.kid);
  const identityDir = path.join(home, 'identity');
  fs.chmodSync(identityDir, 0o555);
  let rotated;
  try {
    rotated = await parent.confirmed(yubikey, ROTATE, {});
  } finally {
    fs.chmodSync(identityDir, 0o755);
  }
  assert.equal(rotated.retry.status, 503, JSON.stringify(rotated.retry.body));
  assert.equal(rotated.retry.body.code, 'SNAPSHOT_NOT_PUBLISHED');
  assert.notEqual(rotated.retry.body.kid, before[0], 'the key did change');
  assert.deepEqual(snapshot().keys.map((key) => key.kid), before, 'apps have not been told');
});
