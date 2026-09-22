const test = require('node:test');
const assert = require('node:assert/strict');
const { createBaseHandlers } = require('../executor/handlers');

function base(type, fields = {}) {
  return { id: 'test-op', type, title: 'test', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields };
}

test('package handler uses fixed apt argv and rejects packages outside policy', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ run: async (input) => { calls.push(input); return {}; } });
  await handlers['package.ensure'](base('package.ensure', { packages: ['git', 'nginx'], updateCache: true }));
  assert.deepEqual(calls.map((call) => [call.binary, call.args]), [
    ['/usr/bin/apt-get', ['update']],
    ['/usr/bin/apt-get', ['install', '--yes', '--no-install-recommends', 'git', 'nginx']],
  ]);
  await assert.rejects(() => handlers['package.ensure'](base('package.ensure', { packages: ['git;reboot'], updateCache: false })), (error) => error.code === 'POLICY_DENIED');
});

test('identity handler permits only sovereign and never accepts caller groups', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ run: async (input) => { calls.push(input); return {}; }, lookupUser: () => null });
  await handlers['identity.ensure-user'](base('identity.ensure-user', { user: 'sovereign' }));
  assert.equal(calls[0].binary, '/usr/sbin/useradd');
  assert.deepEqual(calls[0].args, ['--system', '--home-dir', '/opt/sovereign-home', '--shell', '/usr/sbin/nologin', 'sovereign']);
  await assert.rejects(() => handlers['identity.ensure-user'](base('identity.ensure-user', { user: 'root' })), (error) => error.code === 'POLICY_DENIED');
});


test('managed app directories require sovereign and become sovereign-owned', async () => {
  const calls = [];
  const fsImpl = { existsSync: () => false, mkdirSync: (...args) => calls.push(['mkdir', ...args]), chownSync: (...args) => calls.push(['chown', ...args]), lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }) };
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => ({ uid: 1001, gid: 1002 }) });
  await handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-root' }));
  assert.deepEqual(calls.at(-1), ['chown', '/opt/sovereign-home/apps', 1001, 1002]);
  const missing = createBaseHandlers({ fsImpl, lookupUser: () => null });
  await assert.rejects(() => missing['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-root' })), (error) => error.code === 'POLICY_DENIED');
});

test('git handler only synchronizes Family Dinner with sovereign and fixed argv', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ fsImpl: { existsSync: () => false }, lookupUser: () => ({ uid: 1001, gid: 1002 }), run: async (input) => { calls.push(input); return { stdout: '' }; } });
  await handlers['git.sync'](base('git.sync', { repository: 'https://github.com/eforbell/familyDinner.git', ref: 'main', destination: 'familyDinner' }));
  assert.deepEqual(calls.map((call) => [call.binary, call.args]), [
    ['/usr/bin/git', ['clone', '--origin', 'origin', '--branch', 'main', '--single-branch', 'https://github.com/eforbell/familyDinner.git', '/opt/sovereign-home/apps/familyDinner']],
    ['/usr/bin/git', ['-C', '/opt/sovereign-home/apps/familyDinner', 'status', '--porcelain']],
    ['/usr/bin/git', ['-C', '/opt/sovereign-home/apps/familyDinner', 'pull', '--ff-only', 'origin', 'main']],
  ]);
  assert.equal(calls[0].uid, 1001);
  await assert.rejects(() => handlers['git.sync'](base('git.sync', { repository: 'https://evil.example/app.git', ref: 'main', destination: 'familyDinner' })), (error) => error.code === 'POLICY_DENIED');
});

test('npm handler maps closed task names to sovereign argv', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ lookupUser: () => ({ uid: 1001, gid: 1002 }), run: async (input) => { calls.push(input); return { stdout: 'done' }; } });
  assert.equal(await handlers['runtime.run-npm'](base('runtime.run-npm', { task: 'migrate' })), 'done');
  assert.deepEqual(calls[0].args, ['run', 'db:migrate']);
  assert.equal(calls[0].uid, 1001);
  await assert.rejects(() => handlers['runtime.run-npm'](base('runtime.run-npm', { task: 'install-production;id' })), (error) => error.code === 'POLICY_DENIED');
});

test('systemd and nginx handlers expose only fixed units and shell-free argv', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ run: async (input) => { calls.push(input); return {}; } });
  await handlers['systemd.ensure-service'](base('systemd.ensure-service', { unit: 'family-dinner.service', action: 'enable-and-restart' }));
  await handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload', {}));
  assert.deepEqual(calls.map((call) => [call.binary, call.args]), [
    ['/usr/bin/systemctl', ['enable', '--now', 'family-dinner.service']],
    ['/usr/sbin/nginx', ['-t']],
    ['/usr/bin/systemctl', ['reload', 'nginx.service']],
  ]);
  await assert.rejects(() => handlers['systemd.ensure-service'](base('systemd.ensure-service', { unit: 'family-dinner.service;reboot', action: 'restart' })), (error) => error.code === 'POLICY_DENIED');
});

test('PostgreSQL handlers use postgres uid and never place Dinner passwords in argv or env', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ lookupUser: (name) => name === 'postgres' ? { uid: 999, gid: 999 } : null, run: async (input) => { calls.push(input); return {}; } });
  await handlers['postgres.ensure-role'](base('postgres.ensure-role', { role: 'family_dinner', passwordSecretRef: 'familyDinnerDatabasePassword' }), { secretBindings: { familyDinnerDatabasePassword: 'canary pass' } });
  await handlers['postgres.ensure-database'](base('postgres.ensure-database', { database: 'family_dinner', owner: 'family_dinner' }));
  assert.equal(calls[0].binary, '/usr/bin/psql');
  assert.equal(calls[0].uid, 999);
  assert.doesNotMatch(JSON.stringify(calls[0].args), /canary/);
  assert.doesNotMatch(JSON.stringify(calls[0].env), /canary/);
  assert.match(calls[0].stdin, /canary pass/);
});

test('managed Dinner files have fixed destinations and never accept caller content', () => {
  const { renderManagedFile } = require('../executor/handlers');
  const env = renderManagedFile(base('filesystem.write-managed-file', { template: 'family-dinner-env-v1' }), { familyDinnerDatabasePassword: 'canary' });
  assert.equal(env.path, '/opt/sovereign-home/apps/familyDinner/.env');
  assert.equal(env.mode, 0o640);
  assert.match(env.content, /canary/);
  const unit = renderManagedFile(base('filesystem.write-managed-file', { template: 'family-dinner-service-v1' }));
  assert.match(unit.content, /User=sovereign/);
  assert.throws(() => renderManagedFile(base('filesystem.write-managed-file', { template: '../../etc/shadow' })), (error) => error.code === 'POLICY_DENIED');
});

test('managed-file handler rejects a symlinked parent before creating its temporary file', async () => {
  const calls = [];
  const fsImpl = { existsSync: () => true, realpathSync: () => '/etc', lstatSync: () => ({ isSymbolicLink: () => false }), writeFileSync: (...args) => calls.push(args), chmodSync() {}, chownSync() {}, renameSync() {} };
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => ({ uid: 1, gid: 1 }) });
  await assert.rejects(() => handlers['filesystem.write-managed-file'](base('filesystem.write-managed-file', { template: 'family-dinner-service-v1' })), (error) => error.code === 'POLICY_DENIED');
  assert.equal(calls.length, 0);
});
