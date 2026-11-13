const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { getAppById } = require('../src/catalog');
const { createIdentityResolver } = require('../src/identity/identity-endpoint');
const { DOMAIN, HOMEBASE, KID, PARENT, PASSPHRASE, PEER_WHOIS, activeHousehold, browser, startServer } = require('./support/household');

function install(root, appId, status = 'installed') {
  const app = getAppById(appId);
  new SqliteStateStore(path.join(root, 'state.sqlite3')).upsertInstallation({
    appId, name: 'Untrusted installation label', purpose: 'private', port: 3999,
    mountPath: app.network.preferredMountPath, externalUrl: 'https://old.example/wrong/',
    installRoot: '/private/app', serviceName: 'private.service', ref: 'private-ref',
    status, plannedAt: 'x', updatedAt: 'x',
  });
}

async function admit({ app, parent }, apps = null) {
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  const added = await parent.post('/api/directory/members', { userId: '1002', role: 'kid', apps });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  return added.body.memberId;
}

test('member home: legacy hosts explicitly retain the old dashboard path', async (t) => {
  const { base } = await startServer(t, { config: { directory: false } });
  assert.equal((await browser(base, KID).get('/api/home')).body.state, 'legacy');
});

test('member home: an ingress-observed visitor becomes a member without any credential ceremony', async (t) => {
  const household = await activeHousehold(t);
  const { app, base, parent, root, snapshot } = household;
  install(root, 'family-dinner');
  const kid = browser(base, KID);
  const before = snapshot().generation;
  let home = (await kid.get('/api/home')).body;
  assert.equal(home.state, 'waiting');
  assert.equal(home.candidateObserved, false, 'the home GET itself never records candidates');
  assert.deepEqual(app.directory.describe().candidates, []);
  assert.equal(snapshot().generation, before);

  // The same auth_request resolver nginx runs before forwarding the first page/API request.
  const resolve = createIdentityResolver({ directory: app.directory, whois: PEER_WHOIS,
    status: async () => ({ Self: { TailscaleIPs: ['100.64.0.100'] } }) });
  assert.equal(await resolve({ 'x-sovereign-client-addr': KID, 'x-sovereign-serve-login': 'kid@example.com' }), null);
  home = (await kid.get('/api/home')).body;
  assert.equal(home.candidateObserved, true);
  assert.deepEqual(home.apps, []);
  const directory = (await parent.get('/api/directory')).body;
  assert.equal(directory.candidates[0].login, home.caller.login);
  assert.equal(directory.candidates.length, 1);

  await admit(household, ['family-dinner']);
  home = (await kid.get('/api/home')).body;
  assert.equal(home.state, 'member');
  assert.equal(home.canUnlockAdmin, false);
  assert.deepEqual(home.apps, [{ id: 'family-dinner', name: 'Family Dinner', icon: getAppById('family-dinner').icon,
    url: `https://smith-home.${DOMAIN}/dinner/` }]);
  const member = app.directory.describe().members.find((entry) => entry.userId === '1002');
  assert.equal(member.credentials.length, 0);
  assert.equal(member.grantExpiresAt, null);
  assert.equal((await kid.get('/api/state')).status, 401);
  const response = await fetch(`${base}/api/home`, { headers: { 'x-forwarded-for': KID, 'x-forwarded-host': HOMEBASE } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(await response.json()).sort(), ['apps', 'caller', 'canUnlockAdmin', 'state']);
});

test('member home: grants, installed status, operator defaults and current hostnames filter the server response', async (t) => {
  const household = await activeHousehold(t);
  const { root, base, parent } = household;
  for (const id of ['family-dinner', 'family-pulse', 'helm']) install(root, id);
  install(root, 'family-plan', 'planned');
  const id = await admit(household);
  const kid = browser(base, KID);
  let home = (await kid.get('/api/home')).body;
  assert.deepEqual(home.apps.map((app) => app.id).sort(), ['family-dinner', 'family-pulse']);
  assert.equal(home.apps.find((app) => app.id === 'family-pulse').url, `https://smith-pulse.${DOMAIN}/pulse/`);
  assert.doesNotMatch(JSON.stringify(home), /private|old\.example|3999|installRoot|serviceName|credentials|memberId|jobs|catalog/);
  assert.deepEqual(Object.keys(home.apps[0]).sort(), ['icon', 'id', 'name', 'url']);
  assert.equal((await parent.post(`/api/directory/members/${id}`, { apps: ['family-pulse'] })).status, 200);
  assert.deepEqual((await kid.get('/api/home')).body.apps.map((app) => app.id), ['family-pulse']);
  assert.equal((await parent.post(`/api/directory/members/${id}`, { apps: [] })).status, 200);
  home = (await kid.get('/api/home')).body;
  assert.equal(home.state, 'member');
  assert.deepEqual(home.apps, []);
  assert.equal((await parent.post(`/api/directory/members/${id}`, { status: 'disabled' })).status, 200);
  home = (await kid.get('/api/home')).body;
  assert.equal(home.state, 'disabled');
  assert.deepEqual(home.apps, []);
  assert.equal(home.canUnlockAdmin, false);
  assert.deepEqual(household.app.directory.describe().candidates, [], 'disabled members are not new candidates');
});

test('member home: unidentified, forged and tagged callers never get inventory', async (t) => {
  const { base, root } = await activeHousehold(t, { whois: async (addr) => addr === '100.64.0.3'
    ? { Node: { Tags: ['tag:device'] }, UserProfile: { ID: 1001, LoginName: 'parent@example.com' } }
    : PEER_WHOIS(addr) });
  install(root, 'family-dinner');
  for (const addr of ['', '100.64.0.3', '100.64.0.100', '100.64.0.9', `${PARENT}, ${KID}`]) {
    const response = await fetch(`${base}/api/home`, { headers: { 'x-forwarded-for': addr,
      'x-sovereign-user-id': '1001', 'x-sovereign-login': 'parent@example.com', 'x-forwarded-host': HOMEBASE } });
    const home = await response.json();
    assert.equal(home.state, 'unidentified', addr);
    assert.equal(home.caller, null);
    assert.deepEqual(home.apps, []);
  }
});

test('member home: snapshot failures and login mismatch fail closed without host details', async (t) => {
  const household = await activeHousehold(t);
  const { app, root, base } = household;
  await admit(household);
  install(root, 'family-dinner');
  const kid = browser(base, KID);
  const lockedAdmin = browser(base, PARENT);
  assert.equal((await kid.get('/api/home')).body.apps.length, 1);
  const file = path.join(root, 'identity', 'snapshot.json');
  const original = fs.readFileSync(file, 'utf8');
  const check = async () => {
    const home = (await kid.get('/api/home')).body;
    assert.equal(home.state, 'unavailable');
    assert.deepEqual(home.apps, []);
    assert.doesNotMatch(JSON.stringify(home), /snapshot|\/identity|hb-passkeys|message|reason|generation/);
  };
  const checkAdmin = async () => {
    const home = (await lockedAdmin.get('/api/home')).body;
    assert.equal(home.state, 'unavailable');
    assert.equal(home.canUnlockAdmin, true, 'snapshot failure must not hide the administrator unlock entry');
    assert.deepEqual(home.apps, []);
    assert.equal((await lockedAdmin.get('/api/state')).status, 401);
  };
  for (const patch of [
    (data) => { data.written_at = new Date(Date.now() - 180_000).toISOString(); },
    (data) => { data.members.find((member) => member.user_id === '1002').login = 'changed@example.com'; },
  ]) {
    const data = JSON.parse(original); patch(data); fs.writeFileSync(file, JSON.stringify(data)); await check();
  }
  fs.writeFileSync(file, 'not JSON'); await check(); await checkAdmin();
  fs.writeFileSync(file, original); fs.chmodSync(path.dirname(file), 0o777); await check();
  fs.chmodSync(path.dirname(file), 0o755); fs.unlinkSync(file); await check();
  app.directory.publish();
  assert.equal((await kid.get('/api/home')).body.state, 'member', 'a retry recovers');
  const mismatch = JSON.parse(original);
  mismatch.members.find((member) => member.user_id === '1001').login = 'renamed-parent@example.com';
  fs.writeFileSync(file, JSON.stringify(mismatch)); await checkAdmin();
  app.directory.publish();

  // A publisher failure stops admission immediately, even if its last good file has not aged out yet.
  fs.renameSync(file, `${file}.saved`);
  fs.mkdirSync(file);
  assert.equal(app.directory.publish(), null);
  fs.rmdirSync(file);
  fs.renameSync(`${file}.saved`, file);
  await check(); await checkAdmin();
  app.directory.publish();
  assert.equal((await kid.get('/api/home')).body.state, 'member');
});

test('member home: locked administrator gets a launcher; lifecycle restrictions and unlocked admin survive', async (t) => {
  const { base: setupBase } = await startServer(t);
  assert.equal((await browser(setupBase, KID).get('/api/home')).body.state, 'setup');
  const setupAdmin = browser(setupBase, PARENT);
  assert.equal((await setupAdmin.post('/api/admin/setup', { passphrase: PASSPHRASE })).status, 200);
  const setup = (await setupAdmin.get('/api/home')).body;
  assert.equal(setup.state, 'administrator');
  assert.equal(setup.lifecycle, 'setup');
  assert.deepEqual(setup.apps, []);
  assert.equal((await browser(setupBase, KID).get('/api/home')).body.state, 'setup');
  const { root, base, parent } = await activeHousehold(t);
  install(root, 'family-dinner');
  assert.equal((await parent.get('/api/home')).body.state, 'administrator');
  const locked = browser(base, PARENT);
  const home = (await locked.get('/api/home')).body;
  assert.equal(home.state, 'member');
  assert.equal(home.canUnlockAdmin, true);
  assert.equal(home.apps.length, 1);
  assert.equal((await locked.get('/api/state')).status, 401);
  assert.equal((await parent.post('/api/directory/recovery', { passphrase: PASSPHRASE })).status, 200);
  const recoveryAdmin = (await parent.get('/api/home')).body;
  assert.equal(recoveryAdmin.state, 'administrator');
  assert.equal(recoveryAdmin.lifecycle, 'recovery');
  assert.deepEqual(recoveryAdmin.apps, []);
  for (const client of [locked, browser(base, KID)]) {
    const recovery = (await client.get('/api/home')).body;
    assert.equal(recovery.state, 'recovery');
    assert.deepEqual(recovery.apps, []);
  }
});
