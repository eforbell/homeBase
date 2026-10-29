// Feature-10 SID-004: the directory API and the admin sessions it binds to tailnet identities. Who is asking
// comes from tailscaled (stubbed here) by the address in X-Forwarded-For, never from X-Sovereign-* headers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { SqliteStateStore } = require('../src/state/sqlite-store');

const PEERS = {
  '100.64.0.1': { Node: { Tags: [] }, UserProfile: { ID: 1001, LoginName: 'parent@example.com', DisplayName: 'Parent' } },
  '100.64.0.2': { Node: { Tags: [] }, UserProfile: { ID: 1002, LoginName: 'kid@example.com', DisplayName: 'Kid' } },
  '100.64.0.4': { Node: { Tags: [] }, UserProfile: { ID: 2001, LoginName: 'parent@example.com', DisplayName: 'Parent' } },
};
const PARENT = '100.64.0.1';
const KID = '100.64.0.2';
const IMPOSTOR = '100.64.0.4';
const PASSPHRASE = 'correct horse battery';

async function startServer(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-dir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identityDir = path.join(root, 'identity');
  fs.mkdirSync(identityDir);
  fs.chmodSync(identityDir, 0o755);
  const socketDir = path.join(root, 'sock');
  fs.mkdirSync(socketDir);
  const app = createApp({
    appName: 'Home Base',
    stateDbPath: path.join(root, 'state.sqlite3'),
    port: 0,
    bindHost: '127.0.0.1',
    serviceUser: 'sovereign',
    identitySocket: path.join(socketDir, 'id.sock'),
    identitySnapshotFile: path.join(identityDir, 'snapshot.json'),
    identitySnapshotTrustedRoot: root,
    ingressCheckDelayMs: 3_600_000,
    healthAlertCheckDelayMs: 3_600_000,
    instance: 'smith',
    directory: true,
    identityWhois: async (addr) => { if (!PEERS[addr]) throw new Error('no such peer'); return PEERS[addr]; },
    identityStatus: async () => ({ Self: { TailscaleIPs: ['100.64.0.100'] } }),
    ...extra,
  });
  await new Promise((resolve) => app.listen(resolve));
  t.after(() => new Promise((resolve) => { app.stop(); app.server.close(resolve); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // nginx's identity lookup for a request from addr (what records candidates and admits members).
  const lookup = (addr) => new Promise((resolve, reject) => {
    const login = PEERS[addr].UserProfile.LoginName;
    http.get({ socketPath: path.join(socketDir, 'id.sock'), path: '/_sovereign/identity', headers: { 'x-sovereign-client-addr': addr, 'x-sovereign-serve-login': login } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers['x-sovereign-user-id'] || null));
    }).on('error', reject);
  });
  for (let i = 0; i < 50 && !fs.existsSync(path.join(socketDir, 'id.sock')); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  return { app, base, lookup, dbPath: path.join(root, 'state.sqlite3'), snapshot: () => JSON.parse(fs.readFileSync(path.join(identityDir, 'snapshot.json'), 'utf8')) };
}

function client(base, addr) {
  let cookie = '';
  const request = async (method, url, body) => {
    const headers = { 'x-forwarded-for': addr, ...(cookie ? { cookie } : {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    get: (url) => request('GET', url),
    post: (url, body = {}) => request('POST', url, body),
    useCookieOf: (other) => { cookie = other.cookie(); },
    cookie: () => cookie,
  };
}

test('setup: the founder unlocks with the passphrase and their tailnet identity; the session is theirs alone', async (t) => {
  const { base, snapshot } = await startServer(t);
  const parent = client(base, PARENT);
  const kid = client(base, KID);
  const nobody = client(base, '100.64.0.9');

  assert.equal((await nobody.post('/api/admin/setup', { passphrase: PASSPHRASE })).body.code, 'NO_IDENTITY');
  assert.equal((await parent.post('/api/admin/setup', { passphrase: PASSPHRASE })).status, 200);
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, true);
  assert.equal((await parent.get('/api/directory')).body.members[0].administrator, true);
  assert.equal(snapshot().members[0].user_id, '1001');

  const wrongPerson = await kid.post('/api/admin/unlock', { passphrase: PASSPHRASE });
  assert.equal(wrongPerson.status, 403);
  assert.equal(wrongPerson.body.code, 'NOT_ADMINISTRATOR');
  assert.equal((await client(base, IMPOSTOR).post('/api/admin/unlock', { passphrase: PASSPHRASE })).status, 403, 'same login, different account');

  // The founder's session cookie, carried by another tailnet identity, opens nothing.
  kid.useCookieOf(parent);
  assert.equal((await kid.get('/api/admin/status')).body.unlocked, false);
  assert.equal((await kid.post('/api/directory/credentials/x/revoke')).status, 401);
  const kidView = (await kid.get('/api/directory')).body;
  assert.deepEqual(Object.keys(kidView).sort(), ['caller', 'state']);
  assert.doesNotMatch(JSON.stringify(kidView), /1001|parent@example\.com/);
});

test('setup allows editing the directory but no privileged plan, setting change, or other service', async (t) => {
  const { app, base, lookup, snapshot } = await startServer(t);
  const parent = client(base, PARENT);
  await parent.post('/api/admin/setup', { passphrase: PASSPHRASE });

  const config = await parent.post('/api/homebase/config', { hostname: 'elsewhere' });
  assert.equal(config.status, 409);
  assert.equal(config.body.code, 'BOOTSTRAP_INCOMPLETE');
  assert.match(config.body.error, /in setup/);
  const publish = await parent.post('/api/ingress/services/home/publish', { confirm: 'PUBLISH' });
  assert.equal(publish.body.code, 'BOOTSTRAP_INCOMPLETE');
  const homebase = await parent.post('/api/ingress/services/homebase/publish', { confirm: 'PUBLISH' });
  assert.notEqual(homebase.body.code, 'BOOTSTRAP_INCOMPLETE', 'Home Base\'s own service may be published in setup');

  assert.equal((await parent.post('/api/directory/members', { userId: '1002', role: 'kid' })).body.code, 'NOT_SEEN');
  assert.equal(await lookup(KID), null, 'not a member yet: no identity');
  const candidates = (await parent.get('/api/directory')).body.candidates;
  assert.deepEqual(candidates.map((entry) => [entry.userId, entry.login]), [['1002', 'kid@example.com']]);
  const added = await parent.post('/api/directory/members', { userId: '1002', role: 'kid' });
  assert.equal(added.status, 201);
  // The identity endpoint caches each answer for 5 s; the directory behind it admits the kid at once.
  assert.deepEqual(app.directory.lookup('1002', { login: 'kid@example.com' }), { admitted: true });
  const { memberId } = added.body;
  assert.equal((await parent.post(`/api/directory/members/${memberId}`, { apps: ['family-dinner'] })).status, 200);
  assert.deepEqual(snapshot().members.find((member) => member.user_id === '1002').apps, ['family-dinner']);
  assert.equal((await parent.post(`/api/directory/members/${memberId}`, { administrator: true })).body.code, 'NOT_AVAILABLE');
  assert.equal((await parent.post(`/api/directory/members/${memberId}/grant`)).body.code, 'BOOTSTRAP_STATE', 'grants wait for active');
  assert.equal((await parent.post(`/api/directory/members/${memberId}`, { status: 'disabled' })).status, 200);
  assert.deepEqual(app.directory.lookup('1002', { login: 'kid@example.com' }), { admitted: false }, 'disabled: no identity');

  await lookup(IMPOSTOR);
  assert.equal((await parent.post('/api/directory/members', { userId: '2001', role: 'parent' })).body.code, 'LOGIN_HELD');
});

test('active: unlock refuses, the administrator\'s passphrase opens recovery, and recovery ends every session', async (t) => {
  const { app, base, dbPath, snapshot } = await startServer(t);
  const parent = client(base, PARENT);
  await parent.post('/api/admin/setup', { passphrase: PASSPHRASE });
  app.directory.addCredential({ userId: '1001', credentialId: 'synced-1', kind: 'synced' });
  app.directory.addCredential({ userId: '1001', credentialId: 'yubi-1', kind: 'hardware' });
  app.directory.activate({ userId: '1001', credentialId: 'yubi-1' });
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, false, 'setup\'s session ended at activation');
  // A passphrase session that outlived activation anyway (a restored database) still opens nothing.
  const token = 'leftover-session-token';
  new SqliteStateStore(dbPath).createAdminSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), userId: '1001' });
  const leftover = await fetch(`${base}/api/admin/status`, { headers: { 'x-forwarded-for': PARENT, cookie: `hb_admin_session=${token}` } });
  assert.equal((await leftover.json()).unlocked, false);

  const unlock = await parent.post('/api/admin/unlock', { passphrase: PASSPHRASE });
  assert.equal(unlock.status, 409);
  assert.equal(unlock.body.code, 'RECOVERY_ONLY');
  assert.equal((await client(base, KID).post('/api/directory/recovery', { passphrase: PASSPHRASE })).body.code, 'NOT_ADMINISTRATOR');
  assert.equal((await client(base, IMPOSTOR).post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 403);
  assert.equal((await parent.post('/api/directory/recovery', { passphrase: 'wrong passphrase' })).status, 403);
  assert.equal(app.directory.state(), 'active');

  const epoch = snapshot().global_epoch;
  const recovery = await parent.post('/api/directory/recovery', { passphrase: PASSPHRASE });
  assert.equal(recovery.status, 200);
  assert.equal(snapshot().global_epoch, epoch + 1);
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, true);
  assert.equal((await parent.post('/api/homebase/config', { hostname: 'elsewhere' })).body.code, 'BOOTSTRAP_INCOMPLETE', 'no setting change in recovery');
  const founder = (await parent.get('/api/directory')).body.members[0];
  assert.equal((await parent.post(`/api/directory/members/${founder.memberId}`, { name: 'X' })).body.code, 'BOOTSTRAP_STATE');
  assert.equal((await parent.post('/api/directory/credentials/yubi-1/revoke')).status, 200, 'revoking is what recovery is for');
  assert.equal((await parent.post('/api/ingress/rollback', { confirm: 'ROLLBACK' })).body.code, 'BOOTSTRAP_INCOMPLETE', 'no host action in recovery');
  assert.equal((await parent.post('/api/ingress/services/homebase/publish', { confirm: 'PUBLISH' })).body.code, 'BOOTSTRAP_INCOMPLETE');
  const audit = app.directory && (await parent.get('/api/admin/audit')).body.entries.map((entry) => `${entry.action}:${entry.outcome}`);
  assert.ok(audit.includes('directory-recovery:entered'));
  assert.ok(audit.includes('directory-recovery:refused'));
});

test('whoami reads the directory\'s snapshot the way an app would', async (t) => {
  const { base } = await startServer(t);
  const parent = client(base, PARENT);
  await parent.post('/api/admin/setup', { passphrase: PASSPHRASE });
  const whoami = (await parent.get('/api/identity/whoami')).body;
  assert.equal(whoami.snapshot.ok, true, whoami.snapshot.message);
  assert.equal(whoami.snapshot.household, 'smith');
  assert.equal(whoami.apps['family-dinner'].role, 'parent');
  assert.equal(whoami.apps.helm.role, 'parent', 'the administrator gets operator apps by default');
});

test('with the directory off, nothing changes: the passphrase alone unlocks and the directory routes are absent', async (t) => {
  const { base } = await startServer(t, { directory: false });
  const anyone = client(base, '100.64.0.9');
  assert.equal((await anyone.post('/api/admin/setup', { passphrase: PASSPHRASE })).status, 200);
  assert.equal((await anyone.get('/api/admin/status')).body.unlocked, true);
  assert.equal((await anyone.get('/api/directory')).status, 404);
  assert.equal((await anyone.get('/api/identity/whoami')).status, 404);
});

test('an unlock in flight when root resets the passphrase opens no session', async (t) => {
  const { getAdminStatus, hashPassphrase, unlockAdmin } = require('../src/admin-auth');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new SqliteStateStore(path.join(root, 'state.sqlite3'));
  stateStore.init();
  stateStore.setAdminCredential({ passphraseHash: hashPassphrase(PASSPHRASE), createdAt: 'x', updatedAt: 'x' });
  // The identity lookup is where the request waits; the reset lands meanwhile.
  const directory = {
    caller: async () => { stateStore.setAdminCredential({ passphraseHash: hashPassphrase('reset by root'), createdAt: 'x', updatedAt: 'x' }); stateStore.deleteAllAdminSessions(); return { userId: '1001', login: 'parent@example.com' }; },
    claim: () => ({ user_id: '1001' }),
    isAdministrator: () => true,
    state: () => 'setup',
  };
  const headers = {};
  const res = { setHeader: (name, value) => { headers[name.toLowerCase()] = value; } };
  const result = await unlockAdmin({ headers: {} }, res, { passphrase: PASSPHRASE }, stateStore, { directory });
  assert.equal(result.statusCode, 409);
  assert.equal(result.payload.code, 'PASSPHRASE_CHANGED');
  assert.equal(headers['set-cookie'], undefined);
  assert.equal(stateStore.getAdminSession('anything'), null);
  const status = await getAdminStatus({ headers: { cookie: '' } }, stateStore, { directory: { ...directory, caller: async () => ({ userId: '1001' }) } });
  assert.equal(status.unlocked, false);
});
