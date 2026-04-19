const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
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


test('family pulse nginx route strips mount prefix for vanilla Express app', () => {
  const plan = buildInstallPlan({
    appId: 'family-pulse',
    state: { installations: {} },
    options: {},
    config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', defaultHostname: 'homebase', defaultDomain: 'tailnet' },
  });

  assert.match(plan.files['family-pulse.nginx.conf'], /location \/pulse\//);
  assert.match(plan.files['family-pulse.nginx.conf'], /proxy_pass http:\/\/127\.0\.0\.1:\d+\//);
  assert.match(plan.files['family-pulse.nginx.conf'], /return 301 \/pulse\//);
  assert.match(plan.files['family-pulse.nginx.conf'], /X-Forwarded-Prefix \/pulse/);
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

test('install planner uses provided git ref for deploy/reinstall plans', () => {
  const plan = buildInstallPlan({
    appId: 'family-help',
    state: { installations: {} },
    options: { ref: 'feature/test-ref' },
    config: {
      port: 3080,
      serviceUser: 'sovereign',
      baseInstallDir: '/opt/sovereign-home/apps',
      defaultHostname: 'homebase',
      defaultDomain: 'tailnet',
    },
  });

  assert.equal(plan.app.ref, 'feature/test-ref');
  assert.equal(plan.stateRecord.ref, 'feature/test-ref');
  assert.match(plan.script, /git -C .* checkout feature\/test-ref/);
});

test('install planner rejects unsafe git refs', () => {
  assert.throws(() => {
    buildInstallPlan({
      appId: 'family-help',
      state: { installations: {} },
      options: { ref: 'main;rm -rf /' },
      config: {
        port: 3080,
        serviceUser: 'sovereign',
        baseInstallDir: '/opt/sovereign-home/apps',
        defaultHostname: 'homebase',
        defaultDomain: 'tailnet',
      },
    });
  }, /Invalid git ref/);
});

test('install planner preserves existing secret and oauth env values during reinstall', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-install-env-'));
  const appDir = path.join(tempDir, 'familyPulse');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.env'), [
    'PLAID_CLIENT_ID=existing-client',
    'PLAID_SECRET=existing-secret',
    'PLAID_OAUTH_REDIRECT_URI=https://test.example/pulse/oauth/callback',
    'BOOTSTRAP_SECRET=existing-bootstrap-secret',
    '',
  ].join('\n'));

  const plan = buildInstallPlan({
    appId: 'family-pulse',
    state: { installations: {} },
    options: {},
    config: {
      port: 3080,
      serviceUser: 'sovereign',
      baseInstallDir: tempDir,
      defaultHostname: 'homebase',
      defaultDomain: 'tailnet',
    },
  });

  assert.match(plan.files['.env'], /PLAID_CLIENT_ID=existing-client/);
  assert.match(plan.files['.env'], /PLAID_SECRET=existing-secret/);
  assert.match(plan.files['.env'], /PLAID_OAUTH_REDIRECT_URI=https:\/\/test\.example\/pulse\/oauth\/callback/);
  assert.match(plan.files['.env'], /BOOTSTRAP_SECRET=existing-bootstrap-secret/);
});
