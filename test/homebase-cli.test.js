const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main, parseArgs } = require('../bin/homebase');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { createDirectory } = require('../src/identity/directory');
const { verifyPassphrase } = require('../src/admin-auth');
const { getCatalog } = require('../src/catalog');

const FOUNDER = { userId: '1001', login: 'parent@example.com', name: 'Parent' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'identity'));
  const env = {
    HOME_BASE_ENV_FILE: path.join(root, 'missing.env'),
    HOME_BASE_STATE_DB: path.join(root, 'state.sqlite3'),
    HOME_BASE_IDENTITY_SNAPSHOT: path.join(root, 'identity', 'snapshot.json'),
    HOME_BASE_INSTANCE: 'smith',
    HOME_BASE_DIRECTORY: 'on',
  };
  new SqliteStateStore(env.HOME_BASE_STATE_DB).init();
  const directory = createDirectory({ dbPath: env.HOME_BASE_STATE_DB, catalog: getCatalog(), household: 'smith', snapshotFile: env.HOME_BASE_IDENTITY_SNAPSHOT });
  directory.init();
  directory.claim(FOUNDER);
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'synced-1', kind: 'synced' });
  directory.addCredential({ userId: FOUNDER.userId, credentialId: 'yubi-1', kind: 'hardware' });
  directory.activate({ userId: FOUNDER.userId, credentialId: 'yubi-1' });
  const stateStore = new SqliteStateStore(env.HOME_BASE_STATE_DB);
  stateStore.setAdminCredential({ passphraseHash: 'old:hash', createdAt: 'x', updatedAt: 'x' });
  return { env, directory, stateStore };
}

function run(env, argv, answers, { root = true } = {}) {
  const lines = [];
  const became = [];
  const queue = [...answers];
  return main(argv, {
    env: { ...env },
    prompt: async () => queue.shift() ?? '',
    isRoot: () => root,
    becomeHomeBase: (user) => became.push(user),
    out: (line) => lines.push(line),
  }).then((code) => ({ code, lines, became }));
}

test('arguments: admin reset, optionally with one --administrator login', () => {
  assert.deepEqual(parseArgs(['admin', 'reset']), { administratorLogin: null });
  assert.deepEqual(parseArgs(['admin', 'reset', '--administrator', 'new@example.com']), { administratorLogin: 'new@example.com' });
  for (const argv of [[], ['admin'], ['admin', 'rest'], ['admin', 'reset', '--administrator'], ['admin', 'reset', '--administrator', 'a b'], ['admin', 'reset', 'extra']]) {
    assert.match(parseArgs(argv).error, /usage/, argv.join(' '));
  }
});

test('reset refuses without root, a matching passphrase, or the typed confirmation, and then changes nothing', async (t) => {
  const { env, directory, stateStore } = fixture(t);
  assert.equal((await run(env, ['admin', 'reset'], [], { root: false })).code, 1);
  assert.equal((await run(env, ['admin', 'reset'], ['short'])).code, 1);
  assert.equal((await run(env, ['admin', 'reset'], ['a long passphrase', 'a different one'])).code, 1);
  const unconfirmed = await run(env, ['admin', 'reset'], ['a long passphrase', 'a long passphrase', 'yes']);
  assert.equal(unconfirmed.code, 1);
  assert.deepEqual(unconfirmed.became, [], 'nothing written');
  assert.equal(directory.state(), 'active');
  assert.equal(stateStore.getAdminCredential().passphraseHash, 'old:hash');
  assert.equal((await run({ ...env, HOME_BASE_DIRECTORY: 'off' }, ['admin', 'reset'], [])).code, 1);
});

test('reset as Home Base\'s user: setup, administrator credentials revoked, the new passphrase set, audited', async (t) => {
  const { env, directory, stateStore } = fixture(t);
  const epoch = JSON.parse(fs.readFileSync(env.HOME_BASE_IDENTITY_SNAPSHOT, 'utf8')).global_epoch;
  const result = await run(env, ['admin', 'reset'], ['a long passphrase', 'a long passphrase', 'RESET']);
  assert.equal(result.code, 0, result.lines.join('\n'));
  assert.deepEqual(result.became, ['homebase']);
  assert.equal(directory.state(), 'setup');
  assert.equal(JSON.parse(fs.readFileSync(env.HOME_BASE_IDENTITY_SNAPSHOT, 'utf8')).global_epoch, epoch + 1, 'published at once');
  assert.equal(verifyPassphrase('a long passphrase', stateStore.getAdminCredential().passphraseHash), true);
  assert.match(result.lines[0], /2 administrator credential\(s\) revoked/);
  assert.ok(stateStore.listAdminAudit(5).some((entry) => entry.action === 'admin-reset'));
  assert.equal(directory.claim(FOUNDER).user_id, FOUNDER.userId);
});

test('reset --administrator records the next founder\'s login', async (t) => {
  const { env, directory } = fixture(t);
  const result = await run(env, ['admin', 'reset', '--administrator', 'new@example.com'], ['a long passphrase', 'a long passphrase', 'RESET']);
  assert.equal(result.code, 0);
  assert.equal(directory.describe().pendingAdministratorLogin, 'new@example.com');
  assert.throws(() => directory.claim(FOUNDER), { code: 'NOT_ADMINISTRATOR' });
});
