const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInstallPlan } = require('../src/services/install-planner');

test('install planner allocates a free port when the preferred port is already used', () => {
  const plan = buildInstallPlan({
    appId: 'family-help',
    state: {
      installations: {
        dinner: { port: 3000 },
        plan: { port: 3001 },
        help: { port: 3002 },
        pulse: { port: 3003 },
      },
    },
    options: {},
    config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', defaultHostname: 'homebase', defaultDomain: 'tailnet' },
  });

  assert.equal(plan.install.port, 3004);
});

test('bitcoin accounting plan renders postgres-oriented env and readiness probes', () => {
  const plan = buildInstallPlan({
    appId: 'bitcoin-accounting',
    state: { installations: {} },
    options: { dbPassword: 'secret-pass' },
    config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', defaultHostname: 'homebase', defaultDomain: 'tailnet' },
  });

  assert.match(plan.files['.env'], /DB_BACKEND=postgres/);
  assert.match(plan.files['.env'], /BITCOIN_ACCOUNTING_WEB_BASE_PATH=\/bitcoin-accounting/);
  assert.match(plan.script, /bitcoin-accounting-web-init/);
  assert.equal(plan.install.health.readinessPath, '/api/ready');
  assert.match(plan.files['bitcoin-accounting-web.service'], /ExecStart=\/opt\/sovereign-home\/apps\/bitcoinAccounting\/.venv\/bin\/uvicorn/);
  assert.match(plan.files['bitcoin-accounting.nginx.conf'], /proxy_pass http:\/\/127\.0\.0\.1:\d+;/);
  assert.doesNotMatch(plan.files['bitcoin-accounting.nginx.conf'], /proxy_pass http:\/\/127\.0\.0\.1:\d+\/;/);
  assert.match(plan.files['bitcoin-accounting.nginx.conf'], /return 301 \/bitcoin-accounting\//);
  assert.match(plan.files['bitcoin-accounting.nginx.conf'], /X-Forwarded-Prefix \/bitcoin-accounting/);
});

test('install planner uses HTTPS repository URLs by default', () => {
  const plan = buildInstallPlan({
    appId: 'family-help',
    state: { installations: {} },
    options: {},
    config: {
      port: 3080,
      serviceUser: 'sovereign',
      baseInstallDir: '/opt/sovereign-home/apps',
      defaultHostname: 'homebase',
      defaultDomain: 'tailnet',
    },
  });

  assert.equal(plan.app.repoUrl, 'https://github.com/eforbell/familyHelp.git');
  assert.match(plan.script, /git clone https:\/\/github.com\/eforbell\/familyHelp.git/);
  assert.match(plan.script, /sudo -u sovereign -H bash -lc 'cd \/opt\/sovereign-home\/apps\/familyHelp && npm ci --omit=dev'/);
});

test('install planner prefers SSH repository URLs when explicitly configured', () => {
  const plan = buildInstallPlan({
    appId: 'family-help',
    state: { installations: {} },
    options: {},
    config: {
      port: 3080,
      serviceUser: 'sovereign',
      baseInstallDir: '/opt/sovereign-home/apps',
      defaultHostname: 'homebase',
      defaultDomain: 'tailnet',
      gitTransport: 'ssh',
    },
  });

  assert.equal(plan.app.repoUrl, 'git@github.com:eforbell/familyHelp.git');
  assert.match(plan.script, /git clone git@github.com:eforbell\/familyHelp.git/);
  assert.match(plan.script, /preserve-env=SSH_AUTH_SOCK/);
  assert.match(plan.script, /sudo -u sovereign -H bash -lc 'cd \/opt\/sovereign-home\/apps\/familyHelp && npm ci --omit=dev'/);
  assert.match(plan.script, /Timed out waiting for http:\/\/127.0.0.1:3002/);
});

test('install planner supports dedicated ssh key mode for founder workflows', () => {
  const plan = buildInstallPlan({
    appId: 'family-help',
    state: { installations: {} },
    options: {},
    config: {
      port: 3080,
      serviceUser: 'sovereign',
      baseInstallDir: '/opt/sovereign-home/apps',
      defaultHostname: 'homebase',
      defaultDomain: 'tailnet',
      gitTransport: 'ssh-key',
      gitSshKeyPath: '/opt/sovereign-home/.ssh/id_founder_homebase',
      gitSshKnownHostsPath: '/opt/sovereign-home/.ssh/known_hosts',
      gitSshStrictHostKeyChecking: 'accept-new',
    },
  });

  assert.equal(plan.app.repoUrl, 'git@github.com:eforbell/familyHelp.git');
  assert.match(plan.script, /GIT_SSH_COMMAND='ssh -i \/opt\/sovereign-home\/\.ssh\/id_founder_homebase/);
  assert.match(plan.script, /UserKnownHostsFile=\/opt\/sovereign-home\/\.ssh\/known_hosts/);
});
