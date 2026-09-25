const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createBaseHandlers, renderManagedFile, deployKeyStatus,
  GIT_DEPLOY_KEY_PATH, GIT_KNOWN_HOSTS_PATH, GITHUB_KNOWN_HOSTS, NGINX_GATEWAY_CONTENT,
} = require('../executor/handlers');
const { createFakeFs } = require('./fixtures/fake-fs');
const { appLayout } = require('../src/operations/app-layout');
const { getAppById } = require('../src/catalog');

const LAYOUT = appLayout(getAppById('family-dinner'));
const SOURCE = appLayout(getAppById('home-source'));

const SOVEREIGN = { uid: 1001, gid: 1002 };
const DINNER = '/opt/sovereign-home/apps/familyDinner';
const HTTPS_REPO = 'https://github.com/eforbell/familyDinner.git';
const SSH_REPO = 'ssh://git@github.com/eforbell/familyDinner.git';

function base(type, fields = {}) {
  return { id: 'test-op', type, title: 'test', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields };
}

function recordingRun(calls, respond = () => ({ stdout: '' })) {
  return async (input) => { calls.push(input); return respond(input); };
}

test('package handler runs apt non-interactively with fixed argv and rejects packages outside policy', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ run: recordingRun(calls) });
  await handlers['package.ensure'](base('package.ensure', { packages: ['git', 'openssh-client'], updateCache: true }), { layout: LAYOUT });
  assert.deepEqual(calls.map((call) => [call.binary, call.args]), [
    ['/usr/bin/apt-get', ['update']],
    ['/usr/bin/apt-get', ['install', '--yes', '--no-install-recommends', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'git', 'openssh-client']],
  ]);
  for (const call of calls) {
    assert.equal(call.env.DEBIAN_FRONTEND, 'noninteractive');
    assert.equal(call.uid, 0);
  }
  await assert.rejects(() => handlers['package.ensure'](base('package.ensure', { packages: ['git;reboot'], updateCache: false }), { layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
});

test('identity handler permits only sovereign and never accepts caller groups', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ run: recordingRun(calls), lookupUser: () => null });
  await handlers['identity.ensure-user'](base('identity.ensure-user', { user: 'sovereign' }), { layout: LAYOUT });
  assert.equal(calls[0].binary, '/usr/sbin/useradd');
  assert.deepEqual(calls[0].args, ['--system', '--home-dir', '/var/lib/sovereign-home/sovereign', '--shell', '/usr/sbin/nologin', 'sovereign']);
  await assert.rejects(() => handlers['identity.ensure-user'](base('identity.ensure-user', { user: 'root' }), { layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
});

test('managed app directories become sovereign-owned without following symlinks', async () => {
  const fsImpl = createFakeFs({ '/opt/sovereign-home/apps': { kind: 'dir' } });
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN });
  await handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-install' }), { layout: LAYOUT });
  assert.deepEqual(fsImpl.calls.at(-1), ['fchown', DINNER, 1001, 1002]);
  await handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'nginx-apps' }), { layout: LAYOUT });
  assert.deepEqual(fsImpl.calls.at(-1), ['fchown', '/etc/nginx/sovereign-home.d', 0, 0]);
  const missing = createBaseHandlers({ fsImpl, lookupUser: () => null });
  await assert.rejects(() => missing['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-root' }), { layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
});

test('the shared Sovereign Home root is returned to root so app code cannot replace Home Base itself', async () => {
  const fsImpl = createFakeFs({ '/opt/sovereign-home': { kind: 'dir', uid: 1001, gid: 1002, mode: 0o775 }, '/opt/sovereign-home/homebase/executor/server.js': 'root code' });
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN });
  await handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'sovereign-root' }), { layout: LAYOUT });
  assert.equal(fsImpl.entries.get('/opt/sovereign-home').uid, 0);
  assert.equal(fsImpl.entries.get('/opt/sovereign-home').mode, 0o755);
  await handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'sovereign-home' }), { layout: LAYOUT });
  assert.equal(fsImpl.entries.get('/var/lib/sovereign-home').uid, 0);
  assert.deepEqual([fsImpl.entries.get('/var/lib/sovereign-home/sovereign').uid, fsImpl.entries.get('/var/lib/sovereign-home/sovereign').mode], [1001, 0o700]);
});

test('a symlink swapped in after the lstat check is still never chowned or chmodded', async () => {
  const fsImpl = createFakeFs({ [DINNER]: { kind: 'dir', uid: 1001, gid: 1002 } });
  const originalOpen = fsImpl.openSync;
  // Simulate sovereign racing a rename between the handler's lstat and its ownership change.
  fsImpl.openSync = (target, ...rest) => {
    if (target === DINNER) fsImpl.entries.set(DINNER, { kind: 'link', target: '/etc/shadow', mode: 0o777, uid: 1001, gid: 1002 });
    return originalOpen(target, ...rest);
  };
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN });
  await assert.rejects(() => handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-install' }), { layout: LAYOUT }), (error) => error.code === 'ELOOP');
  assert.equal(fsImpl.calls.some(([call]) => /chown/.test(call)), false);
});

test('a sovereign-planted symlink at a managed directory is refused before any ownership change', async () => {
  const fsImpl = createFakeFs({ [DINNER]: { kind: 'link', target: '/etc' } });
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN });
  await assert.rejects(() => handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-install' }), { layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
  assert.equal(fsImpl.calls.some(([call]) => /chown/.test(call)), false);
});

const MIRROR = '/var/lib/sovereign-home/git-mirrors/familyDinner.git';
const ROOT_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

test('git handler fetches as root into a mirror and clones from it as sovereign', async () => {
  const calls = [];
  const fsImpl = createFakeFs({ [DINNER]: { kind: 'dir', uid: 1001, gid: 1002 }, '/etc/sovereign-home': { kind: 'dir' } });
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN, run: recordingRun(calls) });
  await handlers['git.sync'](base('git.sync', { repository: HTTPS_REPO, ref: 'main' }), { layout: LAYOUT });
  assert.deepEqual(calls.map((call) => [call.uid, call.args]), [
    [0, [...ROOT_GIT, 'clone', '--mirror', HTTPS_REPO, MIRROR]],
    [1001, ['clone', '--origin', 'origin', '--no-checkout', MIRROR, DINNER]],
    [1001, ['-C', DINNER, 'checkout', '-B', 'main', 'origin/main']],
  ]);
  for (const call of calls) {
    assert.equal(call.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal('GIT_SSH_COMMAND' in call.env, false);
  }
  for (const call of calls.filter((entry) => entry.uid === 1001)) assert.equal(call.env.GIT_CONFIG_SYSTEM, '/etc/sovereign-home/sovereign.gitconfig');
  const gitconfig = fsImpl.readFileSync('/etc/sovereign-home/sovereign.gitconfig');
  assert.match(gitconfig, /^\[safe\]\n/);
  assert.ok(gitconfig.includes(`\tdirectory = ${MIRROR}\n`));
  assert.ok(gitconfig.includes('\tdirectory = /var/lib/sovereign-home/git-mirrors/homeSource.git\n'), 'every catalog mirror is listed');
  assert.equal(fsImpl.entries.get('/etc/sovereign-home/sovereign.gitconfig').uid, 0);
  await assert.rejects(() => handlers['git.sync'](base('git.sync', { repository: 'https://evil.example/app.git', ref: 'main' }), { layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
});

test('git handler refreshes the mirror, fast-forwards an existing checkout, and refuses dirty or foreign trees', async () => {
  const calls = [];
  const fsImpl = createFakeFs({ [`${DINNER}/.git`]: { kind: 'dir' }, [MIRROR]: { kind: 'dir' }, '/etc/sovereign-home': { kind: 'dir' } });
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN, run: recordingRun(calls) });
  await handlers['git.sync'](base('git.sync', { repository: HTTPS_REPO, ref: 'main' }), { layout: LAYOUT });
  assert.deepEqual(calls.map((call) => [call.uid, call.args]), [
    [0, [...ROOT_GIT, '-C', MIRROR, 'remote', 'set-url', 'origin', HTTPS_REPO]],
    [0, [...ROOT_GIT, '-C', MIRROR, 'fetch', '--prune', 'origin']],
    [1001, ['-C', DINNER, 'status', '--porcelain']],
    [1001, ['-C', DINNER, 'remote', 'set-url', 'origin', MIRROR]],
    [1001, ['-C', DINNER, 'fetch', 'origin']],
    [1001, ['-C', DINNER, 'merge', '--ff-only', 'origin/main']],
  ]);

  const dirty = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN, run: recordingRun([], (input) => ({ stdout: input.args.includes('status') ? ' M server.js\n' : '' })) });
  await assert.rejects(() => dirty['git.sync'](base('git.sync', { repository: HTTPS_REPO, ref: 'main' }), { layout: LAYOUT }), /dirty/);

  const foreign = createBaseHandlers({ fsImpl: createFakeFs({ [`${DINNER}/stray.txt`]: 'x', '/etc/sovereign-home': { kind: 'dir' } }), lookupUser: () => SOVEREIGN, run: recordingRun([]) });
  await assert.rejects(() => foreign['git.sync'](base('git.sync', { repository: HTTPS_REPO, ref: 'main' }), { layout: LAYOUT }), /not empty/);
});

test('SSH transport keeps the deploy key with root and pins GitHub host keys', async () => {
  const calls = [];
  const fsImpl = createFakeFs({
    [DINNER]: { kind: 'dir' },
    [GIT_DEPLOY_KEY_PATH]: { kind: 'file', content: 'PRIVATE-KEY-CANARY', mode: 0o600, uid: 0 },
  });
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN, run: recordingRun(calls) });
  await handlers['git.sync'](base('git.sync', { repository: SSH_REPO, ref: 'main' }), { layout: LAYOUT });
  const [fetch, ...sovereignCalls] = calls;
  assert.equal(fetch.uid, 0);
  assert.equal(fetch.args.at(-2), SSH_REPO);
  assert.match(fetch.env.GIT_SSH_COMMAND, new RegExp(`-i ${GIT_DEPLOY_KEY_PATH} `));
  assert.match(fetch.env.GIT_SSH_COMMAND, /-o StrictHostKeyChecking=yes/);
  assert.match(fetch.env.GIT_SSH_COMMAND, new RegExp(`UserKnownHostsFile=${GIT_KNOWN_HOSTS_PATH} `));
  assert.equal(fsImpl.readFileSync(GIT_KNOWN_HOSTS_PATH), `${GITHUB_KNOWN_HOSTS}\n`);
  for (const call of sovereignCalls) {
    assert.equal(call.uid, 1001);
    assert.equal('GIT_SSH_COMMAND' in call.env, false, 'sovereign git must never see credentials');
  }
  // The key is never copied anywhere sovereign could reach.
  assert.deepEqual([...fsImpl.entries.values()].filter((entry) => entry.content === 'PRIVATE-KEY-CANARY').length, 1);
  for (const call of calls) assert.doesNotMatch(JSON.stringify(call), /PRIVATE-KEY-CANARY/);
});

test('SSH transport refuses missing or exposed deploy keys before any git runs', async () => {
  const calls = [];
  const missing = createBaseHandlers({ fsImpl: createFakeFs({ [DINNER]: { kind: 'dir' } }), lookupUser: () => SOVEREIGN, run: recordingRun(calls) });
  await assert.rejects(() => missing['git.sync'](base('git.sync', { repository: SSH_REPO, ref: 'main' }), { layout: LAYOUT }), /--git-ssh-key/);
  const exposed = createBaseHandlers({ fsImpl: createFakeFs({ [DINNER]: { kind: 'dir' }, [GIT_DEPLOY_KEY_PATH]: { kind: 'file', content: 'k', mode: 0o644, uid: 0 } }), lookupUser: () => SOVEREIGN, run: recordingRun(calls) });
  await assert.rejects(() => exposed['git.sync'](base('git.sync', { repository: SSH_REPO, ref: 'main' }), { layout: LAYOUT }), /mode 0600/);
  assert.equal(calls.length, 0);
});

test('deploy key status distinguishes present, missing, and insecure keys', () => {
  assert.equal(deployKeyStatus(createFakeFs()), 'missing');
  assert.equal(deployKeyStatus(createFakeFs({ [GIT_DEPLOY_KEY_PATH]: { kind: 'file', content: 'k', mode: 0o600, uid: 0 } })), 'present');
  assert.equal(deployKeyStatus(createFakeFs({ [GIT_DEPLOY_KEY_PATH]: { kind: 'file', content: 'k', mode: 0o640, uid: 0 } })), 'insecure');
  assert.equal(deployKeyStatus(createFakeFs({ [GIT_DEPLOY_KEY_PATH]: { kind: 'file', content: 'k', mode: 0o600, uid: 1001 } })), 'insecure');
});

test('pinned GitHub host keys match the fingerprints GitHub publishes', () => {
  const published = {
    'ssh-ed25519': 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
    'ecdsa-sha2-nistp256': 'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
  };
  const lines = GITHUB_KNOWN_HOSTS.split('\n');
  assert.equal(lines.length, Object.keys(published).length);
  for (const line of lines) {
    const [host, type, blob] = line.split(' ');
    assert.equal(host, 'github.com');
    const fingerprint = `SHA256:${crypto.createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
    assert.equal(fingerprint, published[type]);
  }
});

test('npm handler maps closed task names to sovereign argv', async () => {
  const calls = [];
  const fsImpl = createFakeFs({ [DINNER]: { kind: 'dir', uid: 1001 } });
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN, run: recordingRun(calls, () => ({ stdout: 'done' })) });
  assert.equal(await handlers['runtime.run-app-task'](base('runtime.run-app-task', { task: 'migrate' }), { layout: LAYOUT }), 'done');
  assert.deepEqual(calls[0].args, ['run', 'db:migrate']);
  assert.equal(calls[0].uid, 1001);
  assert.equal(calls[0].env.HOME, '/var/lib/sovereign-home/sovereign');
  await assert.rejects(() => handlers['runtime.run-app-task'](base('runtime.run-app-task', { task: 'install-dependencies;id' }), { layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
});

test('systemd enable-and-restart really restarts, and nginx validates before reloading', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ run: recordingRun(calls) });
  await handlers['systemd.ensure-service'](base('systemd.ensure-service', { unit: 'family-dinner.service', action: 'enable-and-restart' }), { layout: LAYOUT });
  await handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload', {}), { layout: LAYOUT });
  assert.deepEqual(calls.map((call) => [call.binary, call.args]), [
    ['/usr/bin/systemctl', ['enable', '--now', 'family-dinner.service']],
    ['/usr/bin/systemctl', ['restart', 'family-dinner.service']],
    ['/usr/sbin/nginx', ['-t']],
    ['/usr/bin/systemctl', ['reload', 'nginx.service']],
  ]);
  await assert.rejects(() => handlers['systemd.ensure-service'](base('systemd.ensure-service', { unit: 'family-dinner.service;reboot', action: 'restart' }), { layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
});

test('PostgreSQL handlers send valid psql input on stdin and never place passwords in argv or env', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ lookupUser: (name) => name === 'postgres' ? { uid: 999, gid: 999 } : null, run: recordingRun(calls) });
  await handlers['postgres.ensure-role'](base('postgres.ensure-role', { role: 'family_dinner', passwordSecretRef: 'databasePassword' }), { secretBindings: { databasePassword: "can'ary-pass" }, layout: LAYOUT });
  await handlers['postgres.ensure-database'](base('postgres.ensure-database', { database: 'family_dinner', owner: 'family_dinner' }), { layout: LAYOUT });
  assert.equal(calls[0].binary, '/usr/bin/psql');
  assert.equal(calls[0].uid, 999);
  assert.doesNotMatch(JSON.stringify(calls[0].args), /canary|can'ary/);
  assert.doesNotMatch(JSON.stringify(calls[0].env), /can'ary/);
  assert.match(calls[0].stdin, /ALTER ROLE "family_dinner" WITH LOGIN PASSWORD 'can''ary-pass';/);
  assert.doesNotMatch(calls[0].stdin, /\\password/);
  assert.match(calls[1].stdin, /\)\\gexec\n/);
  await assert.rejects(() => handlers['postgres.ensure-role'](base('postgres.ensure-role', { role: 'family_dinner', passwordSecretRef: 'databasePassword' }), { secretBindings: { databasePassword: 'two\nlines-pass' }, layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
});

test('managed files have fixed destinations and never accept caller content', () => {
  assert.equal(renderManagedFile(base('filesystem.write-managed-file', { template: 'app-env-v1' }), { layout: LAYOUT }).path, `${DINNER}/.env`);
  const unit = renderManagedFile(base('filesystem.write-managed-file', { template: 'app-service-v1', unit: 'family-dinner.service' }), { layout: LAYOUT });
  assert.match(unit.content, /User=sovereign/);
  assert.match(unit.content, /NoNewPrivileges=yes/);
  // systemd reads EnvironmentFile= as root; Dinner loads its sovereign-owned .env via dotenv instead.
  assert.doesNotMatch(unit.content, /EnvironmentFile=/);
  const snippet = renderManagedFile(base('filesystem.write-managed-file', { template: 'app-nginx-v1' }), { layout: LAYOUT });
  assert.equal(snippet.path, '/etc/nginx/sovereign-home.d/family-dinner.conf');
  assert.match(snippet.content, /X-Forwarded-Prefix \/dinner;/);
  assert.throws(() => renderManagedFile(base('filesystem.write-managed-file', { template: '../../etc/shadow' }), { layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
});

test('app env is read and written under the sovereign identity; root files are written directly', async () => {
  const fsImpl = createFakeFs({ [DINNER]: { kind: 'dir' }, [`${DINNER}/.env`]: 'OPENAI_API_KEY=sk-keep\n', '/etc/systemd/system': { kind: 'dir' } });
  const identities = [];
  let current = 'root';
  const asUser = (user, fn) => { identities.push(user); current = 'sovereign'; try { return fn(); } finally { current = 'root'; } };
  const originalOpen = fsImpl.openSync;
  const opens = [];
  fsImpl.openSync = (target, ...rest) => { opens.push([target, current]); return originalOpen(target, ...rest); };
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN, asUser });
  await handlers['filesystem.write-managed-file'](base('filesystem.write-managed-file', { template: 'app-env-v1', site: { hostname: 'homebase', domain: 'tailnet', householdTimezone: 'America/New_York' } }), { secretBindings: { databasePassword: 'canary-pass' }, layout: LAYOUT });
  await handlers['filesystem.write-managed-file'](base('filesystem.write-managed-file', { template: 'app-service-v1', unit: 'family-dinner.service' }), { layout: LAYOUT });
  assert.deepEqual(identities, [SOVEREIGN]);
  assert.deepEqual(opens.map(([target, who]) => [target.replace(/\.tmp-[0-9a-f]+$/, '.tmp'), who]), [
    [`${DINNER}/.env.tmp`, 'sovereign'],
    ['/etc/systemd/system/family-dinner.service.tmp', 'root'],
  ]);
  const written = fsImpl.readFileSync(`${DINNER}/.env`);
  assert.match(written, /^OPENAI_API_KEY=sk-keep$/m);
  assert.match(written, /canary-pass/);
  assert.equal(fsImpl.entries.get(`${DINNER}/.env`).mode, 0o640);
});

test('managed-file handler rejects a symlinked parent before creating its temporary file', async () => {
  const fsImpl = createFakeFs({ '/etc/systemd/system': { kind: 'link', target: '/tmp/evil' } });
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN });
  await assert.rejects(() => handlers['filesystem.write-managed-file'](base('filesystem.write-managed-file', { template: 'app-service-v1', unit: 'family-dinner.service' }), { layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
  assert.equal(fsImpl.calls.some(([call]) => call === 'open'), false);
});

test('nginx gateway installs the managed site, enables it, and retires the stock default link', async () => {
  const fsImpl = createFakeFs({
    '/etc/nginx/sites-available/default': 'server {}',
    '/etc/nginx/sites-enabled/default': { kind: 'link', target: '/etc/nginx/sites-available/default' },
  });
  const handlers = createBaseHandlers({ fsImpl });
  await handlers['nginx.ensure-gateway'](base('nginx.ensure-gateway'), { layout: LAYOUT });
  assert.equal(fsImpl.readFileSync('/etc/nginx/sites-available/sovereign-home'), NGINX_GATEWAY_CONTENT);
  assert.match(NGINX_GATEWAY_CONTENT, /include \/etc\/nginx\/sovereign-home\.d\/\*\.conf;/);
  assert.equal(fsImpl.readlinkSync('/etc/nginx/sites-enabled/sovereign-home'), '/etc/nginx/sites-available/sovereign-home');
  assert.equal(fsImpl.existsSync('/etc/nginx/sites-enabled/default'), false);
  assert.equal(fsImpl.existsSync('/etc/nginx/sites-available/default'), true);
  await handlers['nginx.ensure-gateway'](base('nginx.ensure-gateway'), { layout: LAYOUT });

  const customized = createBaseHandlers({ fsImpl: createFakeFs({ '/etc/nginx/sites-available': { kind: 'dir' }, '/etc/nginx/sites-enabled/default': 'server { custom }' }) });
  await assert.rejects(() => customized['nginx.ensure-gateway'](base('nginx.ensure-gateway'), { layout: LAYOUT }), /disable it manually/);
});

test('homeSource: storage lives outside the checkout, sovereign-owned 0750 under a root-owned parent', async () => {
  const fsImpl = createFakeFs({ '/var/lib/sovereign-home': { kind: 'dir' } });
  const handlers = createBaseHandlers({ fsImpl, lookupUser: () => SOVEREIGN });
  await handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-storage-root' }), { layout: SOURCE });
  for (const subpath of ['documents', 'thumbnails', 'exports']) {
    await handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-storage', subpath }), { layout: SOURCE });
  }
  const entry = (target) => fsImpl.entries.get(target);
  assert.deepEqual([entry('/var/lib/sovereign-home/home-source').uid, entry('/var/lib/sovereign-home/home-source').mode], [0, 0o755]);
  assert.deepEqual([entry('/var/lib/sovereign-home/home-source/data').uid, entry('/var/lib/sovereign-home/home-source/data').mode], [1001, 0o750]);
  assert.equal(entry('/var/lib/sovereign-home/home-source/data/documents').uid, 1001);
  await assert.rejects(() => handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-storage', subpath: 'etc' }), { layout: SOURCE }), (error) => error.code === 'POLICY_DENIED');
  await assert.rejects(() => handlers['filesystem.ensure-directory'](base('filesystem.ensure-directory', { purpose: 'app-storage-root' }), { layout: LAYOUT }), /no storage/);
});

test('homeSource: service, sidecar, and timer units come from the catalog with fixed argv and no EnvironmentFile', () => {
  const render = (template, unit) => renderManagedFile(base('filesystem.write-managed-file', { purpose: 'systemd-unit', template, unit }), { layout: SOURCE });
  const service = render('app-service-v1', 'home-source.service');
  assert.equal(service.path, '/etc/systemd/system/home-source.service');
  assert.match(service.content, /^ExecStart=\/usr\/bin\/node server\.js$/m);
  assert.match(service.content, /^WorkingDirectory=\/opt\/sovereign-home\/apps\/homeSource$/m);
  const sidecar = render('app-sidecar-service-v1', 'home-source-import-worker.service');
  assert.match(sidecar.content, /^ExecStart=\/usr\/bin\/node bin\/import-worker\.js$/m);
  assert.match(sidecar.content, /^Environment=NODE_ENV=production$/m);
  const oneshot = render('app-timer-service-v1', 'home-source-continuity-check.service');
  assert.match(oneshot.content, /^Type=oneshot$/m);
  assert.match(oneshot.content, /^ExecStart=\/usr\/bin\/node bin\/deadman-check\.js --once$/m);
  assert.doesNotMatch(oneshot.content, /\[Install\]/);
  const timer = render('app-timer-v1', 'home-source-continuity-outbox.timer');
  assert.match(timer.content, /^OnBootSec=5m$/m);
  assert.match(timer.content, /^OnUnitActiveSec=15m$/m);
  assert.match(timer.content, /^Unit=home-source-continuity-outbox\.service$/m);
  for (const unit of [service, sidecar, oneshot, timer]) {
    assert.doesNotMatch(unit.content, /EnvironmentFile=/);
    if (!unit.path.endsWith('.timer')) assert.match(unit.content, /^User=sovereign$/m);
  }
  assert.throws(() => render('app-sidecar-service-v1', 'family-dinner.service'), (error) => error.code === 'POLICY_DENIED');
  assert.throws(() => render('app-timer-v1', 'ssh.timer'), (error) => error.code === 'POLICY_DENIED');
  const snippet = renderManagedFile(base('filesystem.write-managed-file', { purpose: 'nginx-snippet', template: 'app-nginx-v1' }), { layout: SOURCE });
  assert.equal(snippet.path, '/etc/nginx/sovereign-home.d/home-source.conf');
  assert.match(snippet.content, /proxy_pass http:\/\/127\.0\.0\.1:3008\/;/);
  assert.match(snippet.content, /X-Forwarded-Prefix \/source;/);
});

test('homeSource: migrations, packages, units, and database names are bound to its layout', async () => {
  const calls = [];
  const fsImpl = createFakeFs({ '/opt/sovereign-home/apps/homeSource': { kind: 'dir', uid: 1001 } });
  const handlers = createBaseHandlers({ fsImpl, lookupUser: (name) => (name === 'postgres' ? { uid: 999, gid: 999 } : SOVEREIGN), run: recordingRun(calls) });
  await handlers['runtime.run-app-task'](base('runtime.run-app-task', { task: 'migrate' }), { layout: SOURCE });
  assert.deepEqual([calls[0].binary, calls[0].args, calls[0].cwd, calls[0].uid], ['/usr/bin/node', ['db/migrate.js'], '/opt/sovereign-home/apps/homeSource', 1001]);
  await handlers['package.ensure'](base('package.ensure', { packages: ['tesseract-ocr', 'poppler-utils'], updateCache: false }), { layout: SOURCE });
  await assert.rejects(() => handlers['package.ensure'](base('package.ensure', { packages: ['tesseract-ocr'], updateCache: false }), { layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
  await handlers['systemd.ensure-service'](base('systemd.ensure-service', { unit: 'home-source-continuity-check.timer', action: 'enable-and-restart' }), { layout: SOURCE });
  await assert.rejects(() => handlers['systemd.ensure-service'](base('systemd.ensure-service', { unit: 'home-source.service', action: 'restart' }), { layout: LAYOUT }), (error) => error.code === 'POLICY_DENIED');
  await handlers['postgres.ensure-database'](base('postgres.ensure-database', { database: 'homesource', owner: 'homesource' }), { layout: SOURCE });
  const sql = calls.at(-1).stdin;
  assert.match(sql, /CREATE DATABASE "homesource" OWNER "homesource"/);
  assert.match(sql, /\\gexec\n/);
  await assert.rejects(() => handlers['postgres.ensure-database'](base('postgres.ensure-database', { database: 'family_dinner', owner: 'family_dinner' }), { layout: SOURCE }), (error) => error.code === 'POLICY_DENIED');
});

test('upload limits from the catalog reach both the executor and legacy nginx snippets', () => {
  const executorSnippet = renderManagedFile(base('filesystem.write-managed-file', { purpose: 'nginx-snippet', template: 'app-nginx-v1' }), { layout: SOURCE });
  assert.match(executorSnippet.content, /^ {4}client_max_body_size 55M;$/m);
  const dinnerSnippet = renderManagedFile(base('filesystem.write-managed-file', { purpose: 'nginx-snippet', template: 'app-nginx-v1' }), { layout: LAYOUT });
  assert.doesNotMatch(dinnerSnippet.content, /client_max_body_size/);
  const { buildInstallPlan } = require('../src/services/install-planner');
  const legacy = buildInstallPlan({ appId: 'home-source', state: { installations: {} }, options: {}, config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/tmp/none', defaultHostname: 'homebase', defaultDomain: 'tailnet' } });
  assert.match(legacy.files['home-source.nginx.conf'], /^ {4}client_max_body_size 55M;$/m);
});

test('unit descriptions cannot continue onto the next line or expand specifiers', () => {
  const layout = { ...SOURCE, service: { ...SOURCE.service, description: 'Evil %n \\' } };
  const unit = renderManagedFile(base('filesystem.write-managed-file', { purpose: 'systemd-unit', template: 'app-service-v1', unit: 'home-source.service' }), { layout });
  assert.match(unit.content, /^Description=Evil %%n $/m);
  assert.match(unit.content, /^After=network.target postgresql.service$/m);
});

test('app tasks refuse a checkout that is not a real sovereign-owned directory', async () => {
  const calls = [];
  const planted = createFakeFs({ '/opt/sovereign-home/apps/homeSource': { kind: 'link', target: '/root' } });
  const handlers = createBaseHandlers({ fsImpl: planted, lookupUser: () => SOVEREIGN, run: recordingRun(calls) });
  await assert.rejects(() => handlers['runtime.run-app-task'](base('runtime.run-app-task', { task: 'migrate' }), { layout: SOURCE }), /not a sovereign-owned directory/);
  const rootOwned = createFakeFs({ '/opt/sovereign-home/apps/homeSource': { kind: 'dir', uid: 0 } });
  const handlers2 = createBaseHandlers({ fsImpl: rootOwned, lookupUser: () => SOVEREIGN, run: recordingRun(calls) });
  await assert.rejects(() => handlers2['runtime.run-app-task'](base('runtime.run-app-task', { task: 'migrate' }), { layout: SOURCE }), /not a sovereign-owned directory/);
  assert.equal(calls.length, 0);
});
