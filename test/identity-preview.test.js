const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const { createPreviewDirectory } = require('../src/identity/preview-directory');

const MEMBERS = {
  members: [
    { user_id: '1001', login: 'parent@example.com', name: 'Parent', role: 'parent', apps: ['family-pulse', 'family-dinner'] },
    { user_id: '1002', login: 'kid@example.com', name: 'Kid', role: 'kid', apps: ['family-dinner'] },
    { user_id: '1003', login: 'former@example.com', name: 'Former', role: 'parent', apps: ['family-dinner'], status: 'disabled' },
  ],
};

function fixture(t, members = MEMBERS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identityDir = path.join(root, 'identity');
  fs.mkdirSync(identityDir, { mode: 0o755 });
  fs.chmodSync(identityDir, 0o755);
  const membersFile = path.join(root, 'identity-preview.json');
  fs.writeFileSync(membersFile, JSON.stringify(members));
  return { root, membersFile, snapshotFile: path.join(identityDir, 'snapshot.json') };
}

async function startServer(t, extra) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-preview-state-'));
  const app = createApp({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    bindHost: '127.0.0.1',
    serviceUser: 'sovereign',
    identitySocket: '',
    ingressCheckDelayMs: 3_600_000,
    instance: 'smith',
    ...extra,
  });
  await new Promise((resolve) => app.listen(resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  return `http://127.0.0.1:${app.server.address().port}`;
}

const PARENT = { 'x-sovereign-user-id': '1001', 'x-sovereign-login': 'parent@example.com' };

test('the preview publishes a snapshot apps can read, and whoami shows what each app would resolve', async (t) => {
  const { root, membersFile, snapshotFile } = fixture(t);
  const base = await startServer(t, { identityPreviewFile: membersFile, identitySnapshotFile: snapshotFile, identitySnapshotTrustedRoot: root });

  assert.equal(fs.statSync(snapshotFile).mode & 0o777, 0o644);
  const published = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  assert.equal(published.household, 'smith');
  assert.deepEqual(published.keys, [], 'no keys: nothing can be stepped up against a preview');
  assert.equal(published.members[0].member_id, 'm_1001');

  const parent = await (await fetch(`${base}/api/identity/whoami`, { headers: PARENT })).json();
  assert.deepEqual(parent.headers, { userId: '1001', login: 'parent@example.com' });
  assert.equal(parent.snapshot.ok, true, parent.snapshot.message);
  assert.equal(parent.snapshot.household, 'smith');
  assert.deepEqual(parent.apps['family-pulse'], { memberId: 'm_1001', role: 'parent' });
  assert.deepEqual(parent.apps.helm, { reason: 'no_access' });

  const nobody = await (await fetch(`${base}/api/identity/whoami`)).json();
  assert.deepEqual(nobody.apps['family-pulse'], { reason: 'no_identity' });
  const forged = await (await fetch(`${base}/api/identity/whoami`, { headers: { ...PARENT, 'x-sovereign-login': 'kid@example.com' } })).json();
  assert.deepEqual(forged.apps['family-dinner'], { reason: 'login_mismatch' });
});

test('whoami answers 404 while the preview is off', async (t) => {
  const base = await startServer(t, {});
  assert.equal((await fetch(`${base}/api/identity/whoami`, { headers: PARENT })).status, 404);
});

test('admission follows the published members, and only active ones', (t) => {
  const { membersFile, snapshotFile } = fixture(t);
  const directory = createPreviewDirectory({ membersFile, household: 'smith', snapshotFile });
  assert.equal(directory.lookup('1001'), null, 'nobody before the first publish');
  directory.publish();
  assert.deepEqual(directory.lookup('1001'), { admitted: true });
  assert.deepEqual(directory.lookup('1003'), { admitted: false });
  assert.equal(directory.lookup('9999'), null);
});

test('the generation keeps growing across restarts, and a bad members file publishes nothing and admits nobody', (t) => {
  const { membersFile, snapshotFile } = fixture(t);
  const logs = [];
  const first = createPreviewDirectory({ membersFile, household: 'smith', snapshotFile });
  first.publish();
  first.publish();
  assert.equal(JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).generation, 2);
  const second = createPreviewDirectory({ membersFile, household: 'smith', snapshotFile, log: (line) => logs.push(line) });
  second.publish();
  assert.equal(JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).generation, 3);

  fs.writeFileSync(membersFile, JSON.stringify({ members: [{ ...MEMBERS.members[0], role: 'administrator' }] }));
  second.publish();
  assert.equal(JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).generation, 3, 'the last good snapshot stays until it ages out');
  assert.equal(second.lookup('1001'), null);
  assert.match(logs[0], /not published .*role/);
});
