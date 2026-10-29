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
  fs.writeFileSync(membersFile, JSON.stringify(members), { mode: 0o644 });
  fs.chmodSync(membersFile, 0o644);
  return { root, membersFile, snapshotFile: path.join(identityDir, 'snapshot.json') };
}

const UID = process.getuid();

// tailscaled as the tests see it: two members' devices and the host itself.
const PEERS = {
  '100.64.0.1': { Node: { Tags: [] }, UserProfile: { ID: 1001, LoginName: 'parent@example.com', DisplayName: 'Parent' } },
  '100.64.0.2': { Node: { Tags: [] }, UserProfile: { ID: 1002, LoginName: 'kid@example.com', DisplayName: 'Kid' } },
  '100.64.0.3': { Node: { Tags: ['tag:server'] }, UserProfile: { ID: 1001, LoginName: 'parent@example.com', DisplayName: 'Parent' } },
};
const tailscale = {
  identityWhois: async (addr) => { if (!PEERS[addr]) throw new Error('no such peer'); return PEERS[addr]; },
  identityStatus: async () => ({ Self: { TailscaleIPs: ['100.64.0.100'] } }),
};

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
    identityPreviewOwnerUid: UID,
    ...tailscale,
    ...extra,
  });
  await new Promise((resolve) => app.listen(resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  return `http://127.0.0.1:${app.server.address().port}`;
}

const PARENT = { 'x-sovereign-user-id': '1001', 'x-sovereign-login': 'parent@example.com' };
const from = (addr, headers = {}) => ({ 'x-forwarded-for': addr, ...headers });

test('the preview publishes a snapshot apps can read, and whoami shows what each app would resolve', async (t) => {
  const { root, membersFile, snapshotFile } = fixture(t);
  const base = await startServer(t, { identityPreviewFile: membersFile, identitySnapshotFile: snapshotFile, identitySnapshotTrustedRoot: root });

  assert.equal(fs.statSync(snapshotFile).mode & 0o777, 0o644);
  const published = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  assert.equal(published.household, 'smith');
  assert.deepEqual(published.keys, [], 'no keys: nothing can be stepped up against a preview');
  assert.equal(published.members[0].member_id, 'm_1001');

  const parent = await (await fetch(`${base}/api/identity/whoami`, { headers: from('100.64.0.1', PARENT) })).json();
  assert.deepEqual(parent.caller, { userId: '1001', login: 'parent@example.com' });
  assert.equal(parent.ingressHeaders, 'match');
  assert.equal(parent.snapshot.ok, true, parent.snapshot.message);
  assert.equal(parent.snapshot.household, 'smith');
  assert.deepEqual(parent.apps['family-pulse'], { memberId: 'm_1001', role: 'parent' });
  assert.deepEqual(parent.apps.helm, { reason: 'no_access' });

  const plain = await (await fetch(`${base}/api/identity/whoami`, { headers: from('100.64.0.1') })).json();
  assert.equal(plain.ingressHeaders, 'absent');
  assert.deepEqual(plain.apps['family-pulse'], { memberId: 'm_1001', role: 'parent' }, 'the caller, not the headers, decides');

  for (const headers of [{}, from('100.64.0.100'), from('100.64.0.9'), from('100.64.0.3'), from('100.64.0.1, 100.64.0.2')]) {
    const nobody = await (await fetch(`${base}/api/identity/whoami`, { headers })).json();
    assert.equal(nobody.caller, null, JSON.stringify(headers));
    assert.deepEqual(nobody.apps['family-pulse'], { reason: 'no_identity' });
  }
});

// Before cutover Serve's legacy route reaches Home Base without nginx, so a caller can send any X-Sovereign-*.
test('whoami never answers for the member named in forged identity headers', async (t) => {
  const { root, membersFile, snapshotFile } = fixture(t);
  const base = await startServer(t, { identityPreviewFile: membersFile, identitySnapshotFile: snapshotFile, identitySnapshotTrustedRoot: root });
  const kid = await (await fetch(`${base}/api/identity/whoami`, { headers: from('100.64.0.2', PARENT) })).json();
  assert.deepEqual(kid.caller, { userId: '1002', login: 'kid@example.com' });
  assert.equal(kid.ingressHeaders, 'differ');
  assert.deepEqual(kid.apps['family-pulse'], { reason: 'no_access' });
  assert.deepEqual(kid.apps['family-dinner'], { memberId: 'm_1002', role: 'kid' });
  assert.doesNotMatch(JSON.stringify(kid), /1001|parent@example\.com|m_1001/, 'nothing about the parent');
  const nobody = await (await fetch(`${base}/api/identity/whoami`, { headers: PARENT })).json();
  assert.equal(nobody.caller, null);
  assert.doesNotMatch(JSON.stringify(nobody), /1001|parent@example\.com|m_1001/);
});

test('whoami answers 404 while the preview is off', async (t) => {
  const base = await startServer(t, {});
  assert.equal((await fetch(`${base}/api/identity/whoami`, { headers: PARENT })).status, 404);
});

test('admission follows the published members, and only active ones', (t) => {
  const { root, membersFile, snapshotFile } = fixture(t);
  const directory = createPreviewDirectory({ membersFile, household: 'smith', snapshotFile, ownerUid: UID, trustedRoot: root });
  assert.equal(directory.lookup('1001'), null, 'nobody before the first publish');
  directory.publish();
  assert.deepEqual(directory.lookup('1001'), { admitted: true });
  assert.deepEqual(directory.lookup('1003'), { admitted: false });
  assert.equal(directory.lookup('9999'), null);
});

test('the generation keeps growing across restarts, and a bad members file publishes nothing and admits nobody', (t) => {
  const { root, membersFile, snapshotFile } = fixture(t);
  const logs = [];
  const first = createPreviewDirectory({ membersFile, household: 'smith', snapshotFile, ownerUid: UID, trustedRoot: root });
  first.publish();
  first.publish();
  assert.equal(JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).generation, 2);
  const second = createPreviewDirectory({ membersFile, household: 'smith', snapshotFile, ownerUid: UID, trustedRoot: root, log: (line) => logs.push(line) });
  second.publish();
  assert.equal(JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).generation, 3);

  fs.writeFileSync(membersFile, JSON.stringify({ members: [{ ...MEMBERS.members[0], role: 'administrator' }] }));
  second.publish();
  assert.equal(JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).generation, 3, 'the last good snapshot stays until it ages out');
  assert.equal(second.lookup('1001'), null);
  assert.match(logs[0], /not published .*role/);
});

// Whoever could write the members file could add themselves; Home Base must not launder that into a snapshot.
test('a members file root does not own, or that others can write or swap, publishes nothing and admits nobody', (t) => {
  const cases = [
    ['owned by a user, not root', ({ membersFile }) => membersFile, {}],
    ['writable by others', ({ membersFile }) => { fs.chmodSync(membersFile, 0o666); return membersFile; }, { ownerUid: UID }],
    ['writable by its group', ({ membersFile }) => { fs.chmodSync(membersFile, 0o664); return membersFile; }, { ownerUid: UID }],
    ['a symlink', ({ root, membersFile }) => { const link = path.join(root, 'link.json'); fs.symlinkSync(membersFile, link); return link; }, { ownerUid: UID }],
    ['in a directory others can write', ({ root }) => {
      const dir = path.join(root, 'shared');
      fs.mkdirSync(dir);
      fs.chmodSync(dir, 0o777);
      const file = path.join(dir, 'members.json');
      fs.writeFileSync(file, JSON.stringify(MEMBERS), { mode: 0o644 });
      return file;
    }, { ownerUid: UID }],
  ];
  for (const [name, arrange, options] of cases) {
    const context = fixture(t);
    const logs = [];
    const directory = createPreviewDirectory({ membersFile: arrange(context), household: 'smith', snapshotFile: context.snapshotFile, trustedRoot: context.root, log: (line) => logs.push(line), ...options });
    directory.publish();
    assert.equal(fs.existsSync(context.snapshotFile), false, name);
    assert.equal(directory.lookup('1001'), null, name);
    assert.match(logs[0] || '', /not published/, name);
  }
});
