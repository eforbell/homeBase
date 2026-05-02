const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { SqliteStateStore } = require('../src/state/sqlite-store');
const { AppUpdateMonitor } = require('../src/services/app-update-monitor');

function run(command, cwd) {
  execSync(command, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Home Base Test',
      GIT_AUTHOR_EMAIL: 'homebase-test@example.com',
      GIT_COMMITTER_NAME: 'Home Base Test',
      GIT_COMMITTER_EMAIL: 'homebase-test@example.com',
    },
  });
}

function createStateStore(tempDir) {
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const store = new SqliteStateStore(dbPath);
  store.init();
  return store;
}

function baseInstallRecord(overrides = {}) {
  return {
    appId: 'family-help',
    name: 'Family Help',
    purpose: 'help desk',
    port: 3002,
    mountPath: '/help/',
    externalUrl: 'https://homebase.tailnet/help/',
    installRoot: '/tmp/placeholder',
    serviceName: 'family-help',
    ref: 'main',
    status: 'installed',
    plannedAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
    ...overrides,
  };
}

test('app update monitor marks update available when origin/main is ahead', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-update-monitor-'));
  const remoteDir = path.join(tempDir, 'remote.git');
  const writerDir = path.join(tempDir, 'writer');
  const installRoot = path.join(tempDir, 'install-root');

  run(`git init --bare ${remoteDir}`, tempDir);
  run(`git clone ${remoteDir} ${writerDir}`, tempDir);
  run('git checkout -b main', writerDir);
  fs.writeFileSync(path.join(writerDir, 'README.md'), 'first\n');
  run('git add README.md', writerDir);
  run('git commit -m "seed"', writerDir);
  run('git push -u origin main', writerDir);

  run(`git clone ${remoteDir} ${installRoot}`, tempDir);
  run('git checkout main', installRoot);

  fs.writeFileSync(path.join(writerDir, 'README.md'), 'second\n');
  run('git add README.md', writerDir);
  run('git commit -m "advance origin"', writerDir);
  run('git push origin main', writerDir);

  const store = createStateStore(tempDir);
  const monitor = new AppUpdateMonitor(store, { staleAfterMs: 0 });
  const install = baseInstallRecord({ installRoot, ref: 'main' });

  await monitor.refreshInstalledApps([install], { force: true });

  const statuses = store.listAppUpdateStatuses();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].appId, 'family-help');
  assert.equal(statuses[0].status, 'update-available');
  assert.equal(statuses[0].canUpdate, true);
  assert.equal(statuses[0].behindCount > 0, true);
});

test('app update monitor records check failure for invalid git ref', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-update-monitor-ref-'));
  const store = createStateStore(tempDir);
  const monitor = new AppUpdateMonitor(store, { staleAfterMs: 0 });

  await monitor.refreshInstalledApps([
    baseInstallRecord({ ref: 'main..oops' }),
  ], { force: true });

  const statuses = store.listAppUpdateStatuses();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].status, 'check-failed');
  assert.equal(statuses[0].canUpdate, null);
  assert.match(statuses[0].lastError, /Invalid git ref/i);
});

test('app update monitor uses ssh-key transport invocation for service user git checks', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-update-monitor-ssh-key-'));
  const store = createStateStore(tempDir);
  const monitor = new AppUpdateMonitor(store, {
    serviceUser: 'sovereign',
    gitTransport: 'ssh-key',
    gitSshKeyPath: '/opt/sovereign-home/.ssh/id_founder_homebase',
    gitSshKnownHostsPath: '/opt/sovereign-home/.ssh/known_hosts',
    gitSshStrictHostKeyChecking: 'accept-new',
  });

  const { command, commandArgs } = monitor.buildGitInvocation(['fetch', 'origin', '--prune'], '/opt/sovereign-home/apps/familyPulse');
  assert.equal(command, 'sudo');
  assert.equal(commandArgs[0], '-u');
  assert.equal(commandArgs[1], 'sovereign');
  assert.equal(commandArgs[2], 'env');
  assert.match(commandArgs[3], /^GIT_SSH_COMMAND=ssh -i \/opt\/sovereign-home\/\.ssh\/id_founder_homebase /);
  assert.match(commandArgs[3], /StrictHostKeyChecking=accept-new/);
  assert.match(commandArgs[3], /UserKnownHostsFile=\/opt\/sovereign-home\/\.ssh\/known_hosts/);
  assert.equal(commandArgs[4], 'git');
  assert.equal(commandArgs[5], '-C');
  assert.equal(commandArgs[6], '/opt/sovereign-home/apps/familyPulse');
});
