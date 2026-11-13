const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { createDirectory } = require('../src/identity/directory');
const { createDirectoryStore } = require('../src/identity/directory-store');

const founder = { userId: '1001', login: 'parent@example.com' };
const at = '2026-11-01T00:00:00.000Z';
function sql(db, statement, values = []) {
  const script = 'import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row; r=c.execute(sys.argv[2],json.loads(sys.argv[3])); print(json.dumps([dict(x) for x in r.fetchall()])); c.commit()';
  return JSON.parse(execFileSync('python3', ['-c', script, db, statement, JSON.stringify(values)], { encoding: 'utf8', stdio: 'pipe' }));
}
function fixture(t, legacy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-account-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'state.sqlite3');
  new SqliteStateStore(db).init();
  const store = createDirectoryStore(db);
  const directory = createDirectory({ dbPath: db, household: 'suite', catalog: [], snapshotFile: path.join(root, 'identity', 'snapshot.json') });
  if (legacy) {
    execFileSync('python3', ['-c', 'import sqlite3,sys; sqlite3.connect(sys.argv[1]).executescript(open(sys.argv[2]).read())', db, path.join(__dirname, 'fixtures/identity-pre-handles.sql')]);
    sql(db, "INSERT INTO identity_household VALUES (1,'active',3,4,NULL,?)", [at]);
    sql(db, "INSERT INTO identity_members VALUES ('m_admin','1001','parent@example.com','Parent','parent',1,'active',2,NULL,?,?)", [at, at]);
    sql(db, "INSERT INTO identity_credentials (credential_id,member_id,kind,label,orphaned,created_at,public_key,counter,transports,device_type,backed_up,root) VALUES ('old-key','m_admin','hardware','Old',0,?,'old-public',12,'[\"usb\"]','singleDevice',0,'old-root')", [at]);
  } else { directory.init(); directory.claim(founder); }
  return { root, db, store, directory };
}
const add = (directory, id = 'new-key') => directory.addCredential({ userId: founder.userId, credentialId: id, kind: 'hardware', publicKey: 'new-public', userHandle: directory.enrollmentHandleFor(founder.userId) });

function removeGuards(db) { // Deliberately simulate metadata corruption in this temporary database only.
  for (const { name } of sql(db, "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('identity_members','identity_credentials')")) sql(db, 'DROP TRIGGER "' + name.replaceAll('"', '""') + '"');
}

test('legacy migration is additive and assigns one persistent opaque enrollment handle', (t) => {
  const { db, store, directory } = fixture(t, true);
  const before = store.load();
  directory.init();
  const after = store.load();
  const userHandle = directory.enrollmentHandleFor(founder.userId);
  assert.equal(Buffer.from(userHandle, 'base64url').length, 32);
  assert.equal(Buffer.from(userHandle, 'base64url').toString('base64url'), userHandle);
  for (const key of ['state', 'generation', 'global_epoch', 'updated_at']) assert.equal(after.household[key], before.household[key]);
  for (const [key, value] of Object.entries(before.credentials[0])) assert.equal(after.credentials[0][key], value);
  assert.equal(after.credentials[0].handle_format, 'legacy-v1');
  assert.equal(after.credentials[0].webauthn_user_handle, null);
  assert.equal(after.household.webauthn_v2_issued_at, null);
  assert.equal(directory.credentialsFor(founder.userId)[0].userHandle, Buffer.from('1001').toString('base64url'));
  directory.init();
  assert.equal(directory.enrollmentHandleFor(founder.userId), userHandle);
  assert.equal(sql(db, 'SELECT epoch FROM identity_members')[0].epoch, 2);
});

test('independent directories allocate independent handles; v2 insertion sets a persistent store-owned marker', (t) => {
  const a = fixture(t); const b = fixture(t);
  assert.notEqual(a.directory.enrollmentHandleFor('1001'), b.directory.enrollmentHandleFor('1001'));
  assert.equal(a.store.load().household.webauthn_v2_issued_at, null);
  const registered = add(a.directory);
  assert.equal(registered.handle_format, 'isolated-v2');
  assert.equal(registered.webauthn_user_handle, a.directory.enrollmentHandleFor('1001'));
  const issued = a.store.load().household.webauthn_v2_issued_at;
  assert.ok(issued);
  const current = a.store.load();
  a.store.commit({ expectGeneration: current.household.generation, now: at, household: { webauthn_v2_issued_at: 'forged' } });
  assert.equal(a.store.load().household.webauthn_v2_issued_at, issued);
  a.directory.recordAssertion('1001', registered.credential_id, { kind: 'hardware', counter: 13, deviceType: 'singleDevice', backedUp: false });
  a.directory.revokeCredential(founder, registered.credential_id);
  assert.equal(a.store.load().household.webauthn_v2_issued_at, issued);
  assert.equal(a.store.load().credentials[0].webauthn_user_handle, registered.webauthn_user_handle);
  assert.throws(() => a.directory.addCredential({ userId: '1001', credentialId: 'bad', kind: 'hardware', publicKey: 'x', userHandle: b.directory.enrollmentHandleFor('1001') }), { code: 'INVALID_ENROLLMENT_HANDLE' });
});

test('corrupt credential metadata refuses ceremonies, but status and recovery revoke remain available', (t) => {
  const { db, store, directory } = fixture(t);
  add(directory);
  removeGuards(db);
  sql(db, "UPDATE identity_credentials SET webauthn_user_handle='corrupt!'");
  directory.init(); // Restore guards as a restart/restore would; recovery must still revoke the bad row.
  assert.doesNotThrow(() => directory.describe());
  assert.doesNotThrow(() => directory.standing('1001'));
  assert.throws(() => directory.credentialsFor('1001'), { code: 'INVALID_CREDENTIAL_HANDLE' });
  directory.revokeCredential(founder, 'new-key');
  assert.equal(directory.credentialsFor('1001').length, 0);
  assert.ok(store.load().credentials[0].revoked_at);
});

test('a missing or corrupt member enrollment handle never disables existing credential checks', (t) => {
  const { db, directory } = fixture(t);
  const credential = add(directory);
  removeGuards(db);
  sql(db, 'UPDATE identity_members SET webauthn_user_handle=NULL');
  assert.throws(() => directory.enrollmentHandleFor('1001'), /known-good identity metadata/i);
  directory.init();
  assert.equal(sql(db, 'SELECT webauthn_user_handle FROM identity_members')[0].webauthn_user_handle, null, 'do not invent another account handle over isolated credentials');
  removeGuards(db);
  assert.equal(directory.credentialsFor('1001')[0].userHandle, credential.webauthn_user_handle);
  sql(db, "UPDATE identity_members SET webauthn_user_handle='broken'");
  assert.throws(() => directory.enrollmentHandleFor('1001'), { code: 'INVALID_ENROLLMENT_HANDLE' });
  assert.equal(directory.credentialsFor('1001')[0].userHandle, credential.webauthn_user_handle);
});

test('immutable metadata cannot be rewritten and metadata constraint failures get their own result', (t) => {
  const { db, store, directory } = fixture(t);
  add(directory);
  assert.throws(() => sql(db, "UPDATE identity_credentials SET handle_format='legacy-v1',webauthn_user_handle=NULL"), /CREDENTIAL_HANDLE/);
  assert.throws(() => sql(db, "UPDATE identity_members SET webauthn_user_handle='changed'"), /MEMBER_HANDLE/);
  const before = store.load();
  const invalid = { ...before.credentials[0], credential_id: 'invalid', webauthn_user_handle: null };
  const result = store.commit({ expectGeneration: before.household.generation, now: at, credentials: [invalid] });
  assert.equal(result.handleError, 'INVALID_CREDENTIAL_HANDLE');
  assert.equal(store.load().credentials.length, 1);
  assert.equal(store.load().household.generation, before.household.generation);
});

test('concurrent init converges, and a stale pre-allocation edit preserves the allocated identity', async (t) => {
  const { db, store, directory } = fixture(t, true);
  const stale = store.load();
  const modulePath = require.resolve('../src/identity/directory-store');
  const script = 'require(process.argv[1]).createDirectoryStore(process.argv[2]).init({generation:3,now:process.argv[3]})';
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, modulePath, db, at]);
    let error = ''; child.stderr.on('data', (chunk) => { error += chunk; }); child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(error)));
  })));
  const allocated = directory.enrollmentHandleFor('1001');
  const edited = { ...stale.members[0], name: 'Edited' };
  const revoked = { ...stale.credentials[0], revoked_at: at };
  const result = store.commit({ expectGeneration: stale.household.generation, now: at, members: [edited], credentials: [revoked] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(directory.enrollmentHandleFor('1001'), allocated);
  assert.equal(store.load().credentials[0].handle_format, 'legacy-v1');
  assert.equal(store.load().members[0].name, 'Edited');
});

// Same field projection and ON CONFLICT behavior as the pre-upgrade writer (48ae02d).
function oldUpsert(db, table, key, fields, record) {
  const marks = fields.map(() => '?').join(',');
  const changes = fields.filter((name) => name !== key).map((name) => name + '=excluded.' + name).join(',');
  sql(db, 'INSERT INTO ' + table + ' (' + fields.join(',') + ') VALUES (' + marks + ') ON CONFLICT(' + key + ') DO UPDATE SET ' + changes, fields.map((name) => record[name] ?? null));
}
const oldMemberFields = ['member_id', 'user_id', 'login', 'name', 'role', 'administrator', 'status', 'epoch', 'apps', 'created_at', 'updated_at'];
const oldCredentialFields = ['credential_id', 'member_id', 'kind', 'label', 'orphaned', 'created_at', 'revoked_at', 'public_key', 'counter', 'transports', 'aaguid', 'device_type', 'backed_up', 'root', 'last_used_at'];

test('pre-upgrade writers preserve v2 metadata, insert legacy defaults and leave missing member allocation to init', (t) => {
  const { db, store, directory } = fixture(t);
  const isolated = add(directory);
  const original = store.load();
  oldUpsert(db, 'identity_credentials', 'credential_id', oldCredentialFields, { ...isolated, label: 'Old writer edit', counter: 8, revoked_at: at });
  const retained = store.load().credentials[0];
  assert.equal(retained.handle_format, 'isolated-v2');
  assert.equal(retained.webauthn_user_handle, isolated.webauthn_user_handle);
  assert.equal(retained.revoked_at, at);
  const owner = original.members[0];
  const extra = { ...owner, member_id: 'm_other', user_id: '1002', login: 'kid@example.com', administrator: 0 };
  oldUpsert(db, 'identity_members', 'member_id', oldMemberFields, extra);
  oldUpsert(db, 'identity_credentials', 'credential_id', oldCredentialFields, { ...isolated, credential_id: 'old-insert', member_id: 'm_other', revoked_at: null });
  assert.equal(store.load().members.find((row) => row.user_id === '1002').webauthn_user_handle, null);
  assert.throws(() => directory.enrollmentHandleFor('1002'), /restart/i);
  assert.equal(directory.credentialsFor('1002')[0].userHandle, Buffer.from('1002').toString('base64url'));
  directory.init();
  assert.equal(Buffer.from(directory.enrollmentHandleFor('1002'), 'base64url').length, 32);
  assert.equal(directory.enrollmentHandleFor('1001'), owner.webauthn_user_handle);
  const legacy = store.load().credentials.find((row) => row.credential_id === 'old-insert');
  assert.equal(legacy.handle_format, 'legacy-v1');
  assert.equal(legacy.webauthn_user_handle, null);
  assert.equal(store.load().household.webauthn_v2_issued_at, original.household.webauthn_v2_issued_at);
});

test('a failed migration rolls back DDL and preserves existing handles before a successful retry', (t) => {
  const { db, directory } = fixture(t, true);
  const duplicate = Buffer.alloc(32, 7).toString('base64url');
  sql(db, 'ALTER TABLE identity_members ADD COLUMN webauthn_user_handle TEXT');
  sql(db, 'UPDATE identity_members SET webauthn_user_handle=?', [duplicate]);
  sql(db, "INSERT INTO identity_members VALUES ('m_other','1002','kid@example.com','Kid','kid',0,'active',0,NULL,?,?,?)", [at, at, duplicate]);
  assert.throws(() => directory.init(), /UNIQUE constraint/);
  assert.equal(sql(db, 'PRAGMA table_info(identity_credentials)').some((row) => row.name === 'handle_format'), false);
  assert.equal(sql(db, 'PRAGMA table_info(identity_household)').some((row) => row.name === 'webauthn_v2_issued_at'), false);
  sql(db, 'UPDATE identity_members SET webauthn_user_handle=? WHERE user_id=\'1002\'', [Buffer.alloc(32, 8).toString('base64url')]);
  directory.init();
  assert.equal(directory.enrollmentHandleFor('1001'), duplicate);
});

test('an unknown stored credential format is still revocable through raw recovery operations', (t) => {
  const { db, directory } = fixture(t);
  add(directory);
  removeGuards(db);
  execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA ignore_check_constraints=ON"); c.execute("UPDATE identity_credentials SET handle_format=\'unknown\'"); c.commit()', db]);
  directory.init();
  assert.throws(() => directory.credentialsFor('1001'), { code: 'INVALID_CREDENTIAL_HANDLE' });
  assert.doesNotThrow(() => directory.describe());
  directory.revokeCredential(founder, 'new-key');
  assert.equal(directory.credentialsFor('1001').length, 0);
});

test('store commits reject non-null immutable mismatches instead of reporting a misleading success', (t) => {
  const { store, directory } = fixture(t);
  add(directory);
  const initial = store.load();
  for (const patch of [{ member_id: 'foreign' }, { handle_format: 'legacy-v1' }, { webauthn_user_handle: Buffer.alloc(32, 9).toString('base64url') }]) {
    const result = store.commit({ expectGeneration: initial.household.generation, now: at, credentials: [{ ...initial.credentials[0], ...patch }] });
    assert.equal(result.handleError, 'INVALID_CREDENTIAL_HANDLE');
    assert.equal(store.load().household.generation, initial.household.generation);
  }
  const owner = initial.members[0];
  const result = store.commit({ expectGeneration: initial.household.generation, now: at, members: [{ ...owner, webauthn_user_handle: Buffer.alloc(32, 10).toString('base64url') }] });
  assert.equal(result.handleError, 'INVALID_MEMBER_HANDLE');
});

test('v2 owner association and member handle shape are enforced inside the store', (t) => {
  const { store, directory } = fixture(t);
  const initial = store.load();
  const owner = initial.members[0];
  const record = { credential_id: 'foreign-handle', member_id: owner.member_id, kind: 'hardware', label: 'x', orphaned: 0, created_at: at, revoked_at: null, public_key: 'x', counter: 0, backed_up: 0, handle_format: 'isolated-v2', webauthn_user_handle: Buffer.alloc(32, 11).toString('base64url') };
  assert.equal(store.commit({ expectGeneration: initial.household.generation, now: at, credentials: [record] }).handleError, 'INVALID_CREDENTIAL_HANDLE');
  const other = { ...owner, member_id: 'm_other', user_id: '1002', login: 'kid@example.com', webauthn_user_handle: 'broken' };
  assert.equal(store.commit({ expectGeneration: initial.household.generation, now: at, members: [other] }).handleError, 'INVALID_MEMBER_HANDLE');
  const duplicateUser = { ...other, user_id: owner.user_id, webauthn_user_handle: Buffer.alloc(32, 12).toString('base64url') };
  assert.ok(store.commit({ expectGeneration: initial.household.generation, now: at, members: [duplicateUser] }).integrity);
  assert.equal(store.load().household.webauthn_v2_issued_at, null);
  assert.equal(directory.enrollmentHandleFor('1001'), owner.webauthn_user_handle);
});

test('a transaction failure after the first v2 insert rolls back its marker, and restored markers are immutable', (t) => {
  const { db, store, directory } = fixture(t);
  const initial = store.load();
  const record = { credential_id: 'good-first', member_id: initial.members[0].member_id, kind: 'hardware', label: 'x', orphaned: 0, created_at: at, revoked_at: null, public_key: 'x', counter: 0, backed_up: 0, handle_format: 'isolated-v2', webauthn_user_handle: directory.enrollmentHandleFor('1001') };
  const result = store.commit({ expectGeneration: initial.household.generation, now: at, credentials: [record, { ...record, credential_id: 'bad-next', webauthn_user_handle: null }] });
  assert.equal(result.handleError, 'INVALID_CREDENTIAL_HANDLE');
  assert.equal(store.load().credentials.length, 0);
  assert.equal(store.load().household.webauthn_v2_issued_at, null);
  add(directory);
  const issued = store.load().household.webauthn_v2_issued_at;
  assert.throws(() => sql(db, 'UPDATE identity_household SET webauthn_v2_issued_at=NULL'), /INVALID_PASSKEY_MARKER/);
  sql(db, 'DROP TRIGGER identity_passkey_marker_immutable');
  sql(db, 'UPDATE identity_household SET webauthn_v2_issued_at=NULL');
  directory.init();
  assert.equal(store.load().household.webauthn_v2_issued_at, issued);
});

test('init has a bounded busy failure under a held writer lock, with no partial migration', { timeout: 30000 }, async (t) => {
  const { db, directory } = fixture(t, true);
  const { once } = require('node:events');
  const locker = spawn('python3', ['-u', '-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("BEGIN IMMEDIATE"); print("LOCKED",flush=True); input(); c.commit()', db]);
  const exited = new Promise((resolve, reject) => { locker.once('error', reject); locker.once('exit', resolve); });
  await Promise.race([once(locker.stdout, 'data'), exited.then(() => { throw new Error('Writer lock did not start'); })]);
  try {
    const modulePath = require.resolve('../src/identity/directory-store');
    const started = Date.now();
    const failure = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'require(process.argv[1]).createDirectoryStore(process.argv[2]).init({generation:3,now:process.argv[3]})', modulePath, db, at]);
      let error = ''; child.stderr.on('data', (chunk) => { error += chunk; }); child.once('error', reject);
      child.once('exit', (code) => resolve({ code, error }));
    });
    assert.notEqual(failure.code, 0);
    assert.match(failure.error, /database is locked/);
    assert.ok(Date.now() - started >= 4000);
    assert.equal(sql(db, 'PRAGMA table_info(identity_credentials)').some((row) => row.name === 'handle_format'), false);
  } finally { locker.stdin.end('\n'); await exited; }
  directory.init();
  assert.equal(Buffer.from(directory.enrollmentHandleFor('1001'), 'base64url').length, 32);
});

test('init refreshes a prior feature-slice trigger and rejects unknown/null insert formats by name', (t) => {
  const { db, store, directory } = fixture(t);
  sql(db, 'DROP TRIGGER identity_credential_handle_insert');
  sql(db, "CREATE TRIGGER identity_credential_handle_insert BEFORE INSERT ON identity_credentials WHEN NEW.handle_format='isolated-v2' AND NEW.webauthn_user_handle IS NULL BEGIN SELECT RAISE(ABORT,'INVALID_CREDENTIAL_HANDLE'); END");
  directory.init();
  const before = store.load();
  const owner = before.members[0];
  const record = { credential_id: 'foreign', member_id: owner.member_id, kind: 'hardware', label: 'x', orphaned: 0, created_at: at, revoked_at: null, public_key: 'x', counter: 0, backed_up: 0, handle_format: 'isolated-v2', webauthn_user_handle: Buffer.alloc(32, 13).toString('base64url') };
  assert.equal(store.commit({ expectGeneration: before.household.generation, now: at, credentials: [record] }).handleError, 'INVALID_CREDENTIAL_HANDLE');
  for (const format of ['unknown', null, undefined]) {
    assert.equal(store.commit({ expectGeneration: before.household.generation, now: at, credentials: [{ ...record, handle_format: format, webauthn_user_handle: null }] }).handleError, 'INVALID_CREDENTIAL_HANDLE');
  }
  assert.throws(() => sql(db, "INSERT INTO identity_credentials (credential_id,member_id,kind,created_at,handle_format) VALUES ('bad-format',?,'hardware',?,'unknown')", [owner.member_id, at]), /INVALID_CREDENTIAL_HANDLE/);
  assert.equal(store.load().household.webauthn_v2_issued_at, null);
});

test('a canonical but mismatched member handle cannot create a second account over isolated credentials', (t) => {
  const { db, directory } = fixture(t);
  const credential = add(directory);
  removeGuards(db);
  sql(db, 'UPDATE identity_members SET webauthn_user_handle=?', [Buffer.alloc(32, 14).toString('base64url')]);
  directory.init();
  assert.throws(() => directory.enrollmentHandleFor('1001'), /known-good identity metadata/i);
  assert.equal(directory.credentialsFor('1001')[0].userHandle, credential.webauthn_user_handle);
});

test('init refreshes every currently managed trigger rather than leaving a stale no-op body', (t) => {
  const { db, directory } = fixture(t);
  const guards = sql(db, "SELECT name,tbl_name FROM sqlite_master WHERE type='trigger' AND name LIKE 'identity_%'");
  assert.ok(guards.length >= 7);
  for (const { name, tbl_name } of guards) {
    sql(db, 'DROP TRIGGER "' + name + '"');
    sql(db, 'CREATE TRIGGER "' + name + '" BEFORE INSERT ON "' + tbl_name + '" BEGIN SELECT 1; END');
  }
  directory.init();
  for (const { name } of guards) {
    const refreshed = sql(db, "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", [name]);
    assert.equal(refreshed.length, 1);
    assert.doesNotMatch(refreshed[0].sql, /BEGIN SELECT 1;/);
  }
});

test('revoked isolated history still prevents a new namespace; a verified offline restore preserves auth state', (t) => {
  const { db, store, directory } = fixture(t);
  const credential = add(directory);
  directory.revokeCredential(founder, credential.credential_id);
  const before = store.load();
  removeGuards(db);
  sql(db, "UPDATE identity_members SET webauthn_user_handle=? WHERE user_id='1001'", [Buffer.alloc(32, 16).toString('base64url')]);
  directory.init();
  assert.throws(() => directory.enrollmentHandleFor('1001'), /known-good identity metadata/i);
  const repair = `
import base64,sqlite3,sys
c=sqlite3.connect(sys.argv[1],isolation_level=None)
c.execute("BEGIN IMMEDIATE")
try:
    expected=sys.argv[2]
    raw=base64.urlsafe_b64decode(expected+'=')
    assert len(raw)==32 and base64.urlsafe_b64encode(raw).decode().rstrip('=')==expected
    owner=c.execute("SELECT member_id FROM identity_members WHERE user_id=?",('1001',)).fetchone()[0]
    handles={r[0] for r in c.execute("SELECT webauthn_user_handle FROM identity_credentials WHERE member_id=? AND handle_format='isolated-v2'",(owner,))}
    assert handles=={expected},'Original account value must be proven, not guessed'
    guard=c.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='identity_member_handle_immutable'").fetchone()[0]
    c.execute("DROP TRIGGER identity_member_handle_immutable")
    c.execute("UPDATE identity_members SET webauthn_user_handle=? WHERE member_id=?",(expected,owner))
    c.execute(guard)
    c.execute("COMMIT")
except BaseException:
    c.execute("ROLLBACK")
    raise
`;
  assert.throws(() => execFileSync('python3', ['-c', repair, db, Buffer.alloc(32, 17).toString('base64url')], { stdio: 'pipe' }), /Original account value/);
  assert.throws(() => directory.enrollmentHandleFor('1001'), /known-good identity metadata/i);
  execFileSync('python3', ['-c', repair, db, credential.webauthn_user_handle], { stdio: 'pipe' });
  directory.init();
  assert.equal(directory.enrollmentHandleFor('1001'), credential.webauthn_user_handle);
  assert.deepEqual(store.load().household, before.household);
  assert.deepEqual(store.load().credentials, before.credentials);
  assert.deepEqual(store.load().members, before.members);
  assert.throws(() => sql(db, "UPDATE identity_members SET webauthn_user_handle='changed'"), /INVALID_MEMBER_HANDLE/);
});
