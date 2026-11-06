const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHomeBaseRuntimePlan } = require('../src/services/homebase-runtime-planner');

test('homebase runtime plan renders hardened plan-only service scaffolding', () => {
  const plan = buildHomeBaseRuntimePlan({
    port: 3080,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    gitTransport: 'https',
  });

  assert.equal(plan.kind, 'homebase-runtime');
  assert.equal(plan.runtime.user, 'homebase');
  assert.equal(plan.runtime.enablePrivilegedJobs, false);
  assert.equal(plan.runtime.executionMode, 'plan-only');
  assert.match(plan.files['homebase.service'], /Description=Home Base Control Plane/);
  assert.match(plan.files['homebase.service'], /NoNewPrivileges=true/);
  assert.match(plan.files['homebase.service'], /ProtectSystem=strict/);
  assert.match(plan.files['homebase.env'], /^HOME_BASE_DATA_DIR=\/var\/lib\/sovereign-home\/homebase$/m, 'beside the database (#155)');
  assert.match(plan.files['homebase.env'], /HOME_BASE_STATE_DB=\/var\/lib\/sovereign-home\/homebase\/home-base\.sqlite3/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_BIND_HOST=127\.0\.0\.1/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_EXECUTION_MODE=plan-only/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_ENABLE_PRIVILEGED_JOBS=0/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_AUTO_BOOTSTRAP=0/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_AUTO_BOOTSTRAP_MODE=execute/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_REPOSITORY_URL=https:\/\/github\.com\/eforbell\/homeBase\.git/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_REPOSITORY_SSH_URL=git@github\.com:eforbell\/homeBase\.git/);
  assert.equal(plan.runtime.autoBootstrap, false);
  assert.doesNotMatch(plan.script, /usermod -aG sovereign homebase/);
  assert.match(plan.script, /install -d -m 0755 -o root -g root '\/opt\/sovereign-home\/homebase'/);
  assert.match(plan.script, /install -d -m 0700 -o 'homebase' -g 'homebase' '\/var\/lib\/sovereign-home\/homebase'/);
  assert.match(plan.script, /chown -R root:root '\/opt\/sovereign-home\/homebase'/);
  assert.match(plan.script, /chmod 0640 '\/etc\/sovereign-home\/homebase\.env'/);
  assert.doesNotMatch(plan.script, /NOPASSWD:ALL/);
  assert.match(plan.script, /Refusing to continue while an existing Home Base sudoers policy is present/);
  assert.match(plan.script, /systemctl enable homebase/);
  assert.match(plan.script, /Stop the shell-run instance/);
});

test('homebase runtime plan persists ssh-key git settings for service self-update', () => {
  const plan = buildHomeBaseRuntimePlan({
    port: 3080,
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    gitTransport: 'ssh-key',
    gitSshKeyPath: '/opt/sovereign-home/.ssh/id_founder_homebase',
    gitSshKnownHostsPath: '/opt/sovereign-home/.ssh/known_hosts',
  });

  assert.match(plan.files['homebase.env'], /HOME_BASE_GIT_TRANSPORT=ssh-key/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_GIT_SSH_KEY_PATH=\/opt\/sovereign-home\/\.ssh\/id_founder_homebase/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_GIT_SSH_KNOWN_HOSTS_PATH=\/opt\/sovereign-home\/\.ssh\/known_hosts/);
});

test('homebase runtime plan refuses to generate legacy broad sudoers wiring', () => {
  assert.throws(() => buildHomeBaseRuntimePlan({
    port: 3080,
    homeBaseExecutionMode: 'legacy-sudo',
    homeBaseEnablePrivilegedJobs: true,
  }, {
    enablePrivilegedJobs: true,
  }), /no longer generates privileged sudoers/i);
});

test('homebase runtime plan refuses auto-bootstrap in the installed service', () => {
  assert.throws(() => buildHomeBaseRuntimePlan({ port: 3080 }, {
    autoBootstrap: true,
  }), /auto-bootstrap is unavailable/i);
});

test('homebase runtime plan rejects command-bearing runtime options', () => {
  const maliciousOptions = [
    { runtimeUser: 'homebase;touch-pwned' },
    { appDir: '/opt/homebase;touch-pwned' },
    { stateDir: '/var/lib/homebase;touch-pwned' },
    { stateDbPath: '/var/lib/homebase/state;touch-pwned' },
    { envFile: '/etc/homebase.env;touch-pwned' },
    { port: '3080;touch-pwned' },
    { bindHost: '0.0.0.0' },
  ];

  for (const options of maliciousOptions) {
    assert.throws(() => buildHomeBaseRuntimePlan({ port: 3080 }, options));
  }
});

test('homebase runtime plan rejects multiline environment values', () => {
  assert.throws(() => buildHomeBaseRuntimePlan({
    port: 3080,
    defaultHostname: 'homebase\nEOF\ntouch /tmp/pwned',
  }), /single-line value/i);
});

test('the data directory follows the database when an env file names only that (#155)', () => {
  const { loadConfig } = require('../src/config');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createIngressControl } = require('../src/services/ingress-control');
  assert.equal(loadConfig({ HOME_BASE_STATE_DB: '/var/lib/x/home-base.sqlite3' }).dataDir, '/var/lib/x');
  assert.equal(loadConfig({ HOME_BASE_STATE_DB: '/var/lib/x/home-base.sqlite3' }).stateDbPath, '/var/lib/x/home-base.sqlite3', 'the database stays where it is');
  assert.equal(loadConfig({ HOME_BASE_DATA_DIR: '/data', HOME_BASE_STATE_DB: '/var/lib/x/db' }).dataDir, '/data', 'an explicit setting wins');
  assert.equal(loadConfig({ HOME_BASE_DATA_DIR: '/data' }).stateDbPath, '/data/home-base.sqlite3');
  assert.equal(loadConfig({}).dataDir, path.join(process.cwd(), '.data'), 'a checkout with neither (development) is unchanged');
  // A confirmation is written where the database lives, and is there for the next process to read.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-dir-'));
  const config = { ...loadConfig({ HOME_BASE_STATE_DB: path.join(root, 'home-base.sqlite3') }), instance: 'smith', defaultDomain: 'example-tailnet.ts.net' };
  const cli = async (args) => (args[0] === 'status' ? { Self: { ID: 'nSelf', Tags: ['tag:smith-host'] } } : { version: '0.0.1', services: {} });
  const control = createIngressControl({ config, cli });
  return control.confirm('home', { hostNodeId: 'nSelf', confirmedBy: null, assurance: 'passphrase-session' }).then(() => {
    assert.deepEqual(fs.readdirSync(root), ['ingress-confirmations.json']);
    fs.rmSync(root, { recursive: true });
  });
});
