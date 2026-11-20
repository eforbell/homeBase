const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSnapshotReader } = require('sovereign-auth');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { createDirectory } = require('../src/identity/directory');
const { createDirectoryStore } = require('../src/identity/directory-store');

const CATALOG = [{ id: 'family-dinner' }, { id: 'family-pulse' }, { id: 'helm', identity: { defaultAccess: 'administrator' } }];
const FOUNDER = { userId: '1001', login: 'parent@example.com', name: 'Parent' };
const KID = { userId: '1002', login: 'kid@example.com', name: 'Kid' };
const OTHER = { userId: '1003', login: 'other@example.com', name: 'Other' };

function fixture(t, { now = () => Date.now(), store } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-directory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identityDir = path.join(root, 'identity');
  fs.mkdirSync(identityDir);
  fs.chmodSync(identityDir, 0o755);
  const dbPath = path.join(root, 'state.sqlite3');
  const stateStore = new SqliteStateStore(dbPath);
  stateStore.init();
  const snapshotFile = path.join(identityDir, 'snapshot.json');
  const logs = [];
  const make = (extra = {}) => {
    const directory = createDirectory({ dbPath, catalog: CATALOG, household: 'smith', snapshotFile, now, log: (line) => logs.push(line), ...(store ? { store: store(dbPath) } : {}), ...extra });
    directory.init();
    return directory;
  };
  const reader = (options = {}) => createSnapshotReader({ homeBaseUid: process.getuid(), file: snapshotFile, trustedRoot: root, recheckMs: 0, ...options });
  const published = () => JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  return { root, dbPath, stateStore, snapshotFile, make, reader, published, logs };
}

function session(stateStore, userId) {
  stateStore.createAdminSession({ tokenHash: `t-${userId}-${Math.random()}`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), userId });
}

const sessions = (dbPath) => require('child_process').execFileSync('python3', ['-c', 'import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute("SELECT COUNT(*) FROM homebase_admin_sessions").fetchone()[0])', dbPath], { encoding: 'utf8' }).trim();

// Founder recorded, two credentials including a hardware key, activated.
function activeDirectory(context) {
  const directory = context.make();
  directory.claim(FOUNDER);
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'synced-1', kind: 'synced' });
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'yubi-1', kind: 'hardware' });
  directory.activate({ userId: FOUNDER.userId, credentialId: 'yubi-1' });
  return directory;
}

test('setup: the first identity with the passphrase becomes the administrator, and only that identity after', (t) => {
  const context = fixture(t);
  const directory = context.make();
  assert.equal(directory.state(), 'setup');
  const founder = directory.claim(FOUNDER);
  assert.equal(founder.administrator, true);
  assert.equal(founder.user_id, '1001');
  const generation = context.published().generation;
  assert.equal(directory.claim(FOUNDER).member_id, founder.member_id);
  assert.equal(context.published().generation, generation, 'unlocking again changes nothing');
  assert.throws(() => directory.claim(KID), { code: 'NOT_ADMINISTRATOR' });
  assert.deepEqual(context.published().members.map((member) => member.user_id), ['1001']);
  assert.deepEqual(context.published().members[0].apps, ['family-dinner', 'family-pulse', 'helm'], 'operator apps by default for the administrator');
});

test('setup → active needs D11 and a fresh hardware ceremony, and ends the passphrase sessions', (t) => {
  const context = fixture(t);
  const directory = context.make();
  directory.claim(FOUNDER);
  session(context.stateStore, FOUNDER.userId);
  assert.throws(() => directory.addCredential({ userId: KID.userId, credentialId: 'kid-1', kind: 'synced' }), { code: 'NOT_FOUND' });
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'yubi-1', kind: 'hardware' });
  assert.throws(() => directory.activate({ userId: FOUNDER.userId, credentialId: 'yubi-1' }), { code: 'CREDENTIALS_INCOMPLETE' }, 'one credential is not two');
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'synced-1', kind: 'synced' });
  assert.throws(() => directory.activate({ userId: FOUNDER.userId, credentialId: 'synced-1' }), { code: 'HARDWARE_CEREMONY_REQUIRED' });
  assert.throws(() => directory.activate({ userId: FOUNDER.userId, credentialId: 'nope' }), { code: 'HARDWARE_CEREMONY_REQUIRED' });
  assert.throws(() => directory.activate({ userId: KID.userId, credentialId: 'yubi-1' }), { code: 'NOT_ADMINISTRATOR' });
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'device-1', kind: 'device-bound' });
  assert.throws(() => directory.addCredential({ userId: FOUNDER.userId, credentialId: 'device-1', kind: 'synced' }), { code: 'CONFLICT' });
  assert.equal(sessions(context.dbPath), '1');
  directory.activate({ userId: FOUNDER.userId, credentialId: 'yubi-1' });
  assert.equal(directory.state(), 'active');
  assert.equal(sessions(context.dbPath), '0');
  assert.throws(() => directory.activate({ userId: FOUNDER.userId, credentialId: 'yubi-1' }), { code: 'BOOTSTRAP_STATE' });
});

test('active: the passphrase opens recovery only, for the recorded administrator only', (t) => {
  const context = fixture(t);
  const directory = activeDirectory(context);
  const before = context.published();
  assert.throws(() => directory.claim(FOUNDER), { code: 'RECOVERY_ONLY' });
  assert.throws(() => directory.enterRecovery(KID), { code: 'NOT_ADMINISTRATOR' });
  assert.throws(() => directory.enterRecovery({ ...KID, login: FOUNDER.login }), { code: 'NOT_ADMINISTRATOR' }, 'never by login');
  assert.equal(directory.state(), 'active');
  session(context.stateStore, FOUNDER.userId);
  directory.enterRecovery(FOUNDER);
  assert.equal(directory.state(), 'recovery');
  const after = context.published();
  assert.equal(after.global_epoch, before.global_epoch + 1, 'every assurance cookie stops working');
  assert.ok(after.generation > before.generation);
  assert.equal(sessions(context.dbPath), '0');
  const audit = context.stateStore.listAdminAudit(10).map((entry) => entry.action);
  assert.ok(audit.includes('directory-recovery'));
  assert.equal(directory.enterRecovery(FOUNDER).user_id, FOUNDER.userId, 'the passphrase again in recovery only reopens it');
  assert.equal(context.published().global_epoch, after.global_epoch);
});

test('recovery permits exactly re-enrolling the administrator and revoking, and returns to active only with a hardware ceremony', (t) => {
  const context = fixture(t);
  const directory = activeDirectory(context);
  directory.lookup(KID.userId, KID);
  directory.enterRecovery(FOUNDER);
  const actor = { userId: FOUNDER.userId };
  assert.throws(() => directory.addMember(actor, { userId: KID.userId, role: 'kid' }), { code: 'BOOTSTRAP_STATE' });
  const founder = directory.describe().members[0];
  assert.throws(() => directory.updateMember(actor, founder.memberId, { name: 'X' }), { code: 'BOOTSTRAP_STATE' });
  assert.throws(() => directory.issueGrant(actor, founder.memberId), { code: 'BOOTSTRAP_STATE' });
  // The D16 exception: the lost credentials go, replacements come in with no existing hardware check.
  directory.revokeCredential(actor, 'yubi-1');
  directory.revokeCredential(actor, 'synced-1');
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'synced-2', kind: 'synced' });
  assert.throws(() => directory.activate({ userId: FOUNDER.userId, credentialId: 'synced-2' }), { code: 'HARDWARE_CEREMONY_REQUIRED' });
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'yubi-2', kind: 'hardware' });
  assert.throws(() => directory.activate({ userId: FOUNDER.userId, credentialId: 'yubi-1' }), { code: 'HARDWARE_CEREMONY_REQUIRED' }, 'a revoked key is no ceremony');
  directory.activate({ userId: FOUNDER.userId, credentialId: 'yubi-2' });
  assert.equal(directory.state(), 'active');
});

test('active: the administrator keeps D11, checked and written in one transaction', (t) => {
  const context = fixture(t);
  const directory = activeDirectory(context);
  const actor = { userId: FOUNDER.userId };
  // With the every-time hardware check those changes will need; the admin session alone changes nothing.
  const everyTime = { hardwareEveryTime: true };
  assert.throws(() => directory.revokeCredential(actor, 'synced-1'), { code: 'ADMINISTRATOR_CREDENTIAL' });
  assert.throws(() => directory.revokeCredential(actor, 'yubi-1', everyTime), { code: 'LAST_ADMINISTRATOR_CREDENTIAL' });
  assert.throws(() => directory.revokeCredential(actor, 'synced-1', everyTime), { code: 'LAST_ADMINISTRATOR_CREDENTIAL' });
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'yubi-2', kind: 'hardware' });
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'synced-2', kind: 'synced' });
  assert.throws(() => directory.revokeCredential(KID, 'yubi-1'), { code: 'NOT_ADMINISTRATOR' });

  // Two writers read the same directory: each revocation alone keeps D11, both together would not. The
  // second one's commit finds the generation moved, rebuilds from a fresh read, and is refused.
  let racing = true;
  const racer = createDirectory({
    dbPath: context.dbPath, catalog: CATALOG, household: 'smith', snapshotFile: context.snapshotFile,
    store: (() => {
      const store = createDirectoryStore(context.dbPath);
      return {
        ...store,
        commit(change) {
          if (racing) { racing = false; directory.revokeCredential(actor, 'yubi-1', everyTime); directory.revokeCredential(actor, 'synced-1', everyTime); }
          return store.commit(change);
        },
      };
    })(),
  });
  assert.throws(() => racer.revokeCredential(actor, 'yubi-2', everyTime), { code: 'LAST_ADMINISTRATOR_CREDENTIAL' });
  const live = directory.describe().members[0].credentials.filter((credential) => !credential.revokedAt).map((credential) => credential.credentialId);
  assert.deepEqual(live.sort(), ['synced-2', 'yubi-2']);
});

test('revoking a credential, disabling a member or changing access moves the generation and the member epoch', (t) => {
  const context = fixture(t);
  const directory = activeDirectory(context);
  const actor = { userId: FOUNDER.userId };
  const apps = context.reader();
  directory.lookup(KID.userId, KID);
  const kid = directory.addMember(actor, { userId: KID.userId, role: 'kid' });
  directory.addCredential({ userId: KID.userId, credentialId: 'kid-1', kind: 'synced' });
  const epochOf = () => apps.current().snapshot.byUserId.get(KID.userId).epoch;
  let generation = apps.current().snapshot.generation;
  const moved = () => { const next = apps.current().snapshot.generation; assert.ok(next > generation); generation = next; };
  assert.equal(epochOf(), 0);
  assert.deepEqual([...apps.current().snapshot.byUserId.get(KID.userId).apps], ['family-dinner', 'family-pulse'], 'operator apps default to administrators');
  directory.revokeCredential(actor, 'kid-1');
  assert.equal(epochOf(), 1); moved();
  directory.updateMember(actor, kid.member_id, { name: 'Kiddo' });
  assert.equal(epochOf(), 1, 'a name is not access'); moved();
  directory.updateMember(actor, kid.member_id, { apps: ['family-dinner'] });
  assert.equal(epochOf(), 2); moved();
  directory.updateMember(actor, kid.member_id, { apps: ['family-dinner'] });
  assert.equal(epochOf(), 2, 'the same access again'); moved();
  directory.updateMember(actor, kid.member_id, { status: 'disabled' });
  assert.equal(epochOf(), 3); moved();
  assert.equal(directory.lookup(KID.userId, KID).admitted, false);
  assert.throws(() => directory.updateMember(actor, kid.member_id, { apps: ['nope'] }), { code: 'INVALID' });
  assert.throws(() => directory.updateMember(actor, kid.member_id, { role: 'administrator' }), { code: 'INVALID' });
  assert.throws(() => directory.updateMember(actor, kid.member_id, { administrator: true }), { code: 'NOT_AVAILABLE' });
  const founder = directory.describe().members.find((member) => member.administrator);
  assert.throws(() => directory.updateMember(actor, founder.memberId, { status: 'disabled' }), { code: 'LAST_ADMINISTRATOR' });
});

test('a login is never the person: a new account with a member\'s login is unknown, and a member\'s new login is recorded', async (t) => {
  const context = fixture(t);
  const directory = context.make();
  directory.claim(FOUNDER);
  const actor = { userId: FOUNDER.userId };
  const impostor = { userId: '2001', login: FOUNDER.login, name: 'Parent' };
  assert.equal(directory.lookup(impostor.userId, impostor), null);
  assert.throws(() => directory.addMember(actor, { userId: impostor.userId, role: 'parent' }), { code: 'LOGIN_HELD' });
  assert.throws(() => directory.claim(impostor), { code: 'NOT_ADMINISTRATOR' });
  assert.equal(directory.isAdministrator(impostor.userId), false);
  assert.throws(() => directory.addMember(actor, { userId: '3001', role: 'kid' }), { code: 'NOT_SEEN' }, 'IDs come from identity lookups, never typed in');

  // The founder's identity provider renamed them: same stable ID, new login. The lookup (a GET) only notes
  // it; the background tick records it.
  const generation = context.published().generation;
  assert.deepEqual(directory.lookup(FOUNDER.userId, { ...FOUNDER, login: 'parent@new.example' }), { admitted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.published().generation, generation, 'nothing written from the request path');
  directory.syncLogins();
  assert.equal(context.published().members[0].login, 'parent@new.example');
  assert.equal(directory.isAdministrator(FOUNDER.userId), true);
  // Now the old login is free, and the account holding it can be added as itself.
  directory.lookup(impostor.userId, impostor);
  directory.addMember(actor, { userId: impostor.userId, role: 'kid', name: 'Someone else' });
  assert.equal(directory.isAdministrator(impostor.userId), false);
});

test('enrollment grants: active only, for a member with no credentials, single use, 15 minutes', (t) => {
  let clock = Date.parse('2026-10-29T12:00:00Z');
  const context = fixture(t, { now: () => clock });
  const directory = activeDirectory(context);
  const actor = { userId: FOUNDER.userId };
  directory.lookup(KID.userId, KID);
  const kid = directory.addMember(actor, { userId: KID.userId, role: 'kid' });
  assert.throws(() => directory.issueGrant(KID, kid.member_id), { code: 'NOT_ADMINISTRATOR' });
  const { code, expiresAt } = directory.issueGrant(actor, kid.member_id);
  assert.equal(expiresAt, '2026-10-29T12:15:00.000Z');
  assert.equal(directory.consumeGrant(kid.member_id, 'wrong'), false);
  assert.equal(directory.consumeGrant(kid.member_id, code), true);
  assert.equal(directory.consumeGrant(kid.member_id, code), false, 'single use');
  const second = directory.issueGrant(actor, kid.member_id);
  clock += 15 * 60_000;
  assert.equal(directory.consumeGrant(kid.member_id, second.code), false, 'expired');
  const third = directory.issueGrant(actor, kid.member_id);
  const fourth = directory.issueGrant(actor, kid.member_id);
  assert.equal(directory.consumeGrant(kid.member_id, third.code), false, 'a new grant replaces the old');
  assert.equal(directory.consumeGrant(kid.member_id, fourth.code), true);
  directory.addCredential({ userId: KID.userId, credentialId: 'kid-1', kind: 'synced' });
  assert.throws(() => directory.issueGrant(actor, kid.member_id), { code: 'HAS_CREDENTIALS' });
  const founder = directory.describe().members.find((member) => member.administrator);
  assert.doesNotMatch(JSON.stringify(directory.describe()), new RegExp(fourth.code), 'grants are stored hashed');
  assert.throws(() => directory.issueGrant(actor, founder.memberId), { code: 'HAS_CREDENTIALS' });
});

test('passkeyInvite: a live grant for an active member with no usable passkey, until it expires or is used', (t) => {
  let clock = Date.parse('2026-10-29T12:00:00Z');
  const context = fixture(t, { now: () => clock });
  const directory = activeDirectory(context);
  const actor = { userId: FOUNDER.userId };
  directory.lookup(KID.userId, KID);
  const kid = directory.addMember(actor, { userId: KID.userId, role: 'kid' });
  assert.equal(directory.passkeyInvite(KID.userId), null, 'no grant');
  const { code, expiresAt } = directory.issueGrant(actor, kid.member_id);
  assert.deepEqual(directory.passkeyInvite(KID.userId), { expiresAt });
  assert.ok(!JSON.stringify(directory.passkeyInvite(KID.userId)).includes(code));
  clock += 15 * 60_000;
  assert.equal(directory.passkeyInvite(KID.userId), null, 'expired');
  directory.issueGrant(actor, kid.member_id);
  directory.updateMember(actor, kid.member_id, { status: 'disabled' });
  assert.equal(directory.passkeyInvite(KID.userId), null, 'disabled');
  directory.updateMember(actor, kid.member_id, { status: 'active' });
  directory.issueGrant(actor, kid.member_id);
  directory.addCredential({ userId: KID.userId, credentialId: 'kid-1', kind: 'synced' });
  assert.equal(directory.passkeyInvite(KID.userId), null, 'used: a passkey now');
  assert.equal(directory.passkeyInvite(FOUNDER.userId), null, 'the administrator has passkeys');
  assert.equal(directory.passkeyInvite('nobody'), null);
});

test('reset returns to setup: administrator credentials and sessions revoked, global epoch moved, new passphrase', (t) => {
  const context = fixture(t);
  const directory = activeDirectory(context);
  const before = context.published();
  session(context.stateStore, FOUNDER.userId);
  directory.reset({ passphraseHash: 'salt:hash' });
  assert.equal(directory.state(), 'setup');
  const after = context.published();
  assert.equal(after.global_epoch, before.global_epoch + 1);
  assert.equal(after.members[0].epoch, before.members[0].epoch + 1);
  assert.equal(sessions(context.dbPath), '0');
  assert.equal(context.stateStore.getAdminCredential().passphraseHash, 'salt:hash');
  assert.ok(directory.describe().members[0].credentials.every((credential) => credential.revokedAt));
  assert.throws(() => directory.claim(KID), { code: 'NOT_ADMINISTRATOR' }, 'the same administrator by default');
  assert.equal(directory.claim(FOUNDER).user_id, FOUNDER.userId);
  assert.ok(context.stateStore.listAdminAudit(10).some((entry) => entry.action === 'admin-reset'));
});

test('reset --administrator: only that login can found, and the old administrator is demoted then', (t) => {
  const context = fixture(t);
  const directory = activeDirectory(context);
  directory.reset({ passphraseHash: 'salt:hash', administratorLogin: OTHER.login });
  assert.equal(directory.isAdministrator(FOUNDER.userId), true, 'until the new founder arrives');
  assert.throws(() => directory.claim(FOUNDER), { code: 'NOT_ADMINISTRATOR' });
  assert.throws(() => directory.claim(KID), { code: 'NOT_ADMINISTRATOR' });
  directory.claim(OTHER);
  assert.equal(directory.isAdministrator(OTHER.userId), true);
  assert.equal(directory.isAdministrator(FOUNDER.userId), false);
  const old = context.published().members.find((member) => member.user_id === FOUNDER.userId);
  assert.deepEqual(old.apps, ['family-dinner', 'family-pulse'], 'no operator apps once demoted');
  assert.equal(directory.describe().pendingAdministratorLogin, null);
});

test('the generation never goes below the published snapshot, and stays put between changes', (t) => {
  const context = fixture(t);
  fs.writeFileSync(context.snapshotFile, JSON.stringify({ generation: 41 }));
  const directory = context.make();
  directory.publish();
  assert.equal(context.published().generation, 41);
  directory.publish();
  assert.equal(context.published().generation, 41);
  directory.claim(FOUNDER);
  assert.equal(context.published().generation, 42);
  const restarted = context.make();
  restarted.publish();
  assert.equal(context.published().generation, 42);
});

test('apps refuse a snapshot that is stale (Home Base stopped), writable by others, or swapped for a symlink', (t) => {
  let clock = Date.now();
  const context = fixture(t, { now: () => clock });
  const directory = context.make();
  directory.claim(FOUNDER);
  assert.equal(context.reader({ now: () => clock }).current().ok, true);
  assert.equal(context.reader({ now: () => clock + 119_000 }).current().ok, true);
  assert.equal(context.reader({ now: () => clock + 121_000 }).current().reason, 'stale');
  fs.chmodSync(context.snapshotFile, 0o666);
  assert.equal(context.reader().current().reason, 'untrusted');
  fs.chmodSync(context.snapshotFile, 0o644);
  const real = `${context.snapshotFile}.real`;
  fs.renameSync(context.snapshotFile, real);
  fs.symlinkSync(real, context.snapshotFile);
  assert.equal(context.reader().current().reason, 'untrusted');
  fs.rmSync(context.snapshotFile);
  directory.publish();
  assert.equal(fs.lstatSync(context.snapshotFile).isSymbolicLink(), false, 'the next publish replaces it');
  assert.equal(context.reader().current().ok, true);
});

test('a directory that can\'t publish admits nobody', (t) => {
  const context = fixture(t);
  const directory = context.make();
  directory.claim(FOUNDER);
  assert.deepEqual(directory.lookup(FOUNDER.userId, FOUNDER), { admitted: true });
  fs.chmodSync(path.dirname(context.snapshotFile), 0o555);
  directory.publish();
  fs.chmodSync(path.dirname(context.snapshotFile), 0o755);
  assert.equal(directory.lookup(FOUNDER.userId, FOUNDER), null);
  assert.match(context.logs.at(-1), /not published/);
});

test('a login change waits out recovery, which permits only re-enrolling and revoking', (t) => {
  const context = fixture(t);
  const directory = activeDirectory(context);
  directory.enterRecovery(FOUNDER);
  directory.publish();
  directory.lookup(FOUNDER.userId, { ...FOUNDER, login: 'parent@new.example' });
  const generation = context.published().generation;
  directory.syncLogins();
  assert.equal(context.published().generation, generation);
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'yubi-2', kind: 'hardware' });
  directory.activate({ userId: FOUNDER.userId, credentialId: 'yubi-2' });
  directory.syncLogins();
  assert.equal(context.published().members[0].login, 'parent@new.example');
});

test('publishing is one step across processes: a publisher that read an older generation never replaces a newer one', (t) => {
  const context = fixture(t);
  const directory = context.make();
  directory.claim(FOUNDER);
  const logs = [];
  const second = context.make();
  // The first publisher has built its snapshot from generation N when the root CLI commits N+1 and publishes.
  const attempts = [];
  const first = createDirectory({
    dbPath: context.dbPath, catalog: CATALOG, household: 'smith', snapshotFile: context.snapshotFile, log: (line) => logs.push(line),
    store: (() => {
      const store = createDirectoryStore(context.dbPath);
      return {
        ...store,
        publish(snapshot) {
          if (!attempts.length) second.reset({ passphraseHash: 'salt:hash' });
          const result = store.publish(snapshot);
          attempts.push([snapshot.expectGeneration, result.ok]);
          return result;
        },
      };
    })(),
  });
  const before = context.published();
  first.publish();
  assert.deepEqual(attempts, [[before.generation, false], [before.generation + 1, true]], 'refused, then rebuilt from the newer read');
  assert.equal(context.published().generation, before.generation + 1);
  assert.equal(context.published().global_epoch, before.global_epoch + 1);
  assert.deepEqual(logs, []);

  // A database older than what is published (restored by hand) publishes nothing and admits nobody.
  fs.writeFileSync(context.snapshotFile, JSON.stringify({ generation: 9_999 }));
  first.publish();
  assert.equal(context.published().generation, 9_999);
  assert.equal(first.lookup(FOUNDER.userId, FOUNDER), null);
  assert.match(logs.at(-1), /newer than the database/);
});

test('the latest login observation wins, including one back to the recorded login', (t) => {
  const context = fixture(t);
  const directory = context.make();
  directory.claim(FOUNDER);
  directory.lookup(FOUNDER.userId, { ...FOUNDER, login: 'parent@new.example' });
  directory.lookup(FOUNDER.userId, FOUNDER);
  directory.syncLogins();
  assert.equal(context.published().members[0].login, FOUNDER.login);
});

test('a claim made on a passphrase root has since replaced is refused', (t) => {
  const context = fixture(t);
  const directory = context.make();
  context.stateStore.setAdminCredential({ passphraseHash: 'salt:new', createdAt: 'x', updatedAt: 'x' });
  assert.throws(() => directory.claim(FOUNDER, { passphraseHash: 'salt:old' }), { code: 'PASSPHRASE_CHANGED' });
  assert.equal(directory.describe().members.length, 0, 'no founder recorded');
  assert.equal(directory.claim(FOUNDER, { passphraseHash: 'salt:new' }).user_id, FOUNDER.userId);
});

test('a snapshot write that fails leaves no temporary file behind', (t) => {
  const context = fixture(t);
  const directory = context.make();
  directory.claim(FOUNDER);
  const dir = path.dirname(context.snapshotFile);
  const before = fs.readdirSync(dir).sort();
  // The rename fails once the target is a directory; the temporary file was already written and synced.
  fs.rmSync(context.snapshotFile);
  fs.mkdirSync(context.snapshotFile);
  fs.writeFileSync(path.join(context.snapshotFile, 'keep'), '');
  directory.publish();
  assert.match(context.logs.at(-1), /not published/);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test('a passkey ceremony commits only if what authorized it still holds when it lands', (t) => {
  const context = fixture(t);
  const directory = context.make();
  directory.claim(FOUNDER);
  const seen = () => {
    const standing = directory.standing(FOUNDER.userId);
    return { state: standing.state, globalEpoch: standing.globalEpoch, epoch: standing.member.epoch };
  };
  context.stateStore.setAdminCredential({ passphraseHash: 'first:hash', createdAt: 'x', updatedAt: 'x' });

  // An enrollment authorized in setup, landing after root's reset changed the passphrase, is refused.
  const setupView = seen();
  directory.reset({ passphraseHash: 'second:hash' });
  assert.throws(() => directory.addCredential({ userId: FOUNDER.userId, credentialId: 'late', kind: 'synced', expect: setupView, expectPassphraseHash: 'first:hash' }), { code: 'STALE' });
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'synced-1', kind: 'synced', expect: seen(), expectPassphraseHash: 'second:hash' });
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'yubi-1', kind: 'hardware', expect: seen() });

  // An activation authorized before another activation and a recovery doesn't undo the recovery.
  const before = seen();
  directory.activate({ userId: FOUNDER.userId, credentialId: 'yubi-1', expect: before });
  directory.enterRecovery(FOUNDER);
  assert.equal(directory.state(), 'recovery');
  assert.throws(() => directory.activate({ userId: FOUNDER.userId, credentialId: 'yubi-1', expect: before }), { code: 'STALE' });
  assert.equal(directory.state(), 'recovery');

  // A member's enrollment authorized by a check that a revocation has since spent is refused.
  directory.activate({ userId: FOUNDER.userId, credentialId: 'yubi-1', expect: seen() });
  const candidate = directory.lookup(KID.userId, KID);
  assert.equal(candidate, null);
  directory.addMember({ userId: FOUNDER.userId }, { userId: KID.userId, role: 'kid' });
  directory.addCredential({ userId: KID.userId, credentialId: 'kid-1', kind: 'synced' });
  const kidStanding = directory.standing(KID.userId);
  const kidView = { state: kidStanding.state, globalEpoch: kidStanding.globalEpoch, epoch: kidStanding.member.epoch };
  directory.revokeCredential({ userId: FOUNDER.userId }, 'kid-1');
  assert.throws(() => directory.addCredential({ userId: KID.userId, credentialId: 'kid-2', kind: 'synced', expect: kidView }), { code: 'STALE' });
  assert.throws(() => directory.revokeOwnCredential(KID.userId, 'kid-1', { expect: kidView }), { code: 'STALE' });
});

// App instances (native handoff, part 1): one installation of the household's app, with its App Attest key.
const KEY = (n) => Buffer.alloc(32, n).toString('base64');
const instance = (userId, n = 1, extra = {}) => ({ userId, keyId: KEY(n), publicKey: `spki-${n}`, environment: 'production', label: `Phone ${n}`, ...extra });

test('app instances: registered to an active member in active Home Base, listed, and found by key', (t) => {
  const context = fixture(t);
  const setupOnly = context.make();
  setupOnly.claim(FOUNDER);
  assert.throws(() => setupOnly.registerAppInstance(instance(FOUNDER.userId)), { code: 'BOOTSTRAP_STATE' });

  const directory = activeDirectory(fixture(t));
  directory.lookup(KID.userId, KID);
  const kid = directory.addMember({ userId: FOUNDER.userId }, { userId: KID.userId, role: 'kid' });
  const registered = directory.registerAppInstance(instance(KID.userId, 1, { label: ' Kid\u0007\'s phone ', receipt: 'receipt-bytes' }));
  assert.equal(registered.memberId, kid.member_id);
  assert.equal(registered.label, 'Kid\'s phone', 'control characters and spaces are dropped');
  assert.throws(() => directory.registerAppInstance(instance(KID.userId, 1)), { code: 'APP_INSTANCE_EXISTS' });
  assert.throws(() => directory.registerAppInstance(instance(OTHER.userId, 2)), { code: 'NOT_FOUND' }, 'only members');
  assert.throws(() => directory.registerAppInstance(instance(KID.userId, 3, { keyId: 'not a key' })), { code: 'INVALID' });
  assert.throws(() => directory.registerAppInstance(instance(KID.userId, 3, { keyId: KEY(3).replace('=', 'A') })), { code: 'INVALID' });
  assert.throws(() => directory.registerAppInstance(instance(KID.userId, 3, { environment: 'simulator' })), { code: 'INVALID' });
  assert.throws(() => directory.registerAppInstance(instance(KID.userId, 3, { counter: -1 })), { code: 'INVALID' });

  assert.deepEqual(directory.appInstance(KEY(1)), { keyId: KEY(1), userId: KID.userId, memberId: kid.member_id, publicKey: 'spki-1', counter: 0, label: 'Kid\'s phone' });
  assert.equal(directory.appInstance(KEY(9)), null);
  assert.equal(directory.appInstance('not a key'), null);
  const listed = directory.describe().members.find((member) => member.memberId === kid.member_id).appInstances;
  assert.deepEqual(listed.map(({ keyId, label, environment, lastUsedAt }) => ({ keyId, label, environment, lastUsedAt })), [{ keyId: KEY(1), label: 'Kid\'s phone', environment: 'production', lastUsedAt: null }]);
  assert.equal(JSON.stringify(directory.describe()).includes('receipt-bytes'), false, 'the receipt stays in the database');
  assert.equal(JSON.stringify(directory.describe()).includes('spki-1'), false, 'and so does the key');
});

test('app instances: the counter only moves from the value its check read', (t) => {
  const directory = activeDirectory(fixture(t));
  directory.registerAppInstance(instance(FOUNDER.userId));
  assert.equal(directory.advanceAppInstance(KEY(1), 0, 1), true);
  assert.equal(directory.advanceAppInstance(KEY(1), 0, 2), false, 'a racing assertion that read 0 loses');
  assert.equal(directory.advanceAppInstance(KEY(1), 1, 1), false, 'never sideways');
  assert.equal(directory.advanceAppInstance(KEY(1), 1, 0), false, 'never back');
  assert.equal(directory.advanceAppInstance(KEY(9), 0, 1), false, 'no such key');
  assert.equal(directory.advanceAppInstance(KEY(1), 1, 5), true);
  assert.equal(directory.appInstance(KEY(1)).counter, 5);
  assert.ok(directory.describe().members[0].appInstances[0].lastUsedAt);
});

test('app instances: the administrator revokes one; disabling a member removes theirs', (t) => {
  const context = fixture(t);
  const directory = activeDirectory(context);
  directory.lookup(KID.userId, KID);
  const kid = directory.addMember({ userId: FOUNDER.userId }, { userId: KID.userId, role: 'kid' });
  directory.registerAppInstance(instance(KID.userId, 1));
  directory.registerAppInstance(instance(KID.userId, 2));
  directory.registerAppInstance(instance(FOUNDER.userId, 3));

  assert.throws(() => directory.revokeAppInstance({ userId: KID.userId }, KEY(1)), { code: 'NOT_ADMINISTRATOR' });
  assert.deepEqual(directory.revokeAppInstance({ userId: FOUNDER.userId }, KEY(1)), { revoked: KEY(1) });
  assert.equal(directory.appInstance(KEY(1)), null);
  assert.throws(() => directory.revokeAppInstance({ userId: FOUNDER.userId }, KEY(1)), { code: 'NOT_FOUND' });

  directory.updateMember({ userId: FOUNDER.userId }, kid.member_id, { status: 'disabled' });
  assert.equal(directory.appInstance(KEY(2)), null);
  directory.updateMember({ userId: FOUNDER.userId }, kid.member_id, { status: 'active' });
  assert.equal(directory.appInstance(KEY(2)), null, 'gone, not hidden: re-enabled, the app registers again');
  assert.equal(directory.appInstance(KEY(3)).userId, FOUNDER.userId, 'other members keep theirs');

  const audit = context.stateStore.listAdminAudit(50);
  assert.ok(audit.some((entry) => entry.action === 'app-instance-register'));
  assert.ok(audit.some((entry) => entry.action === 'app-instance-revoke' && entry.target === kid.member_id));
  assert.ok(audit.some((entry) => entry.action === 'member-update' && /; 1 app instance\(s\) removed$/.test(entry.outcome)));
});

test('app instances: a database from before them gains the table', (t) => {
  const context = fixture(t);
  const directory = activeDirectory(context);
  require('child_process').execFileSync('python3', ['-c', 'import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute("DROP TABLE identity_app_instances");c.commit()', context.dbPath]);
  const again = context.make();
  again.registerAppInstance(instance(FOUNDER.userId));
  assert.equal(again.appInstance(KEY(1)).userId, FOUNDER.userId);
  assert.equal(directory.appInstance(KEY(1)).userId, FOUNDER.userId);
});
