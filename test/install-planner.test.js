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

test('bug base install planner renders nginx snippet for bug-base-mcp sidecar', () => {
  const plan = buildInstallPlan({
    appId: 'bug-base',
    state: { installations: {} },
    options: {},
    config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', defaultHostname: 'homebase', defaultDomain: 'tailnet' },
  });

  assert.match(plan.files['bug-base-mcp.nginx.conf'], /location \/bugs\/mcp\//);
  assert.match(plan.files['bug-base-mcp.nginx.conf'], /proxy_pass http:\/\/127\.0\.0\.1:\d+\/mcp\//);
  assert.match(plan.script, /\/etc\/nginx\/snippets\/bug-base-mcp\.conf/);
  assert.match(plan.files['.env'], /MCP_PORT=\d+/);
});

test('home source install planner provisions import worker service sidecar', () => {
  const plan = buildInstallPlan({
    appId: 'home-source',
    state: { installations: {} },
    options: {},
    config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', defaultHostname: 'homebase', defaultDomain: 'tailnet' },
  });

  assert.match(plan.files['home-source-import-worker.service'], /Description=Home Source Import Worker/);
  assert.match(plan.files['home-source-import-worker.service'], /ExecStart=node bin\/import-worker\.js/);
  assert.match(plan.script, /sudo apt-get install -y poppler-utils/);
  assert.match(plan.script, /\/etc\/systemd\/system\/home-source-import-worker\.service/);
  assert.match(plan.script, /systemctl enable home-source-import-worker/);
  assert.match(plan.script, /systemctl restart home-source-import-worker/);
});

test('family pulse plan renders notification timer units', () => {
  const plan = buildInstallPlan({
    appId: 'family-pulse',
    state: { installations: {} },
    options: {},
    config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', defaultHostname: 'homebase', defaultDomain: 'tailnet' },
  });

  assert.match(plan.files['family-pulse-notifications.service'], /Description=Family Pulse notification runner/);
  assert.match(plan.files['family-pulse-notifications.service'], /ExecStart=node scripts\/send-notifications\.js/);
  assert.match(plan.files['family-pulse-notifications.timer'], /OnCalendar=\*:0\/30/);
  assert.match(plan.script, /systemctl enable family-pulse-notifications\.timer/);
  assert.match(plan.script, /systemctl restart family-pulse-notifications\.timer/);
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

test('install planner preserves existing DATABASE_URL identity for legacy postgres installs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-install-db-url-'));
  const appDir = path.join(tempDir, 'familyHelp');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.env'), [
    'DATABASE_URL=postgresql://dbuser:legacy-pass@127.0.0.1:5432/family_help',
    '',
  ].join('\n'));

  const plan = buildInstallPlan({
    appId: 'family-help',
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

  assert.match(plan.files['.env'], /DATABASE_URL=postgresql:\/\/dbuser:legacy-pass@127\.0\.0\.1:5432\/family_help/);
  assert.equal(plan.install.dbName, 'family_help');
  assert.equal(plan.install.dbUser, 'dbuser');
  assert.doesNotMatch(plan.script, /CREATE ROLE/);
  assert.doesNotMatch(plan.script, /ALTER ROLE/);
  assert.doesNotMatch(plan.script, /createdb --owner=/);
});


test('install planner preserves existing split postgres credentials for postgres-or-sqlite apps', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-install-pg-split-'));
  const appDir = path.join(tempDir, 'bitcoinAccounting');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.env'), [
    'DB_BACKEND=postgres',
    'PGHOST=127.0.0.1',
    'PGPORT=5432',
    'PGUSER=dbuser',
    'PGPASSWORD=shared-postgres-pass',
    'PGDATABASE=bitcoin_accounting',
    '',
  ].join('\n'));

  const plan = buildInstallPlan({
    appId: 'bitcoin-accounting',
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

  assert.match(plan.files['.env'], /PGUSER=dbuser/);
  assert.match(plan.files['.env'], /PGPASSWORD=shared-postgres-pass/);
  assert.match(plan.files['.env'], /PGDATABASE=bitcoin_accounting/);
  assert.doesNotMatch(plan.script, /CREATE ROLE/);
  assert.doesNotMatch(plan.script, /ALTER ROLE/);
  assert.doesNotMatch(plan.script, /createdb --owner=/);
});

test('install planner skips postgres bootstrap for existing sqlite-backed bitcoin accounting installs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-install-sqlite-skip-'));
  const appDir = path.join(tempDir, 'bitcoinAccounting');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.env'), [
    'DB_BACKEND=sqlite',
    'SQLITE_DB_PATH=/var/lib/bitcoin-accounting/ledger.db',
    '',
  ].join('\n'));

  const plan = buildInstallPlan({
    appId: 'bitcoin-accounting',
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

  assert.match(plan.files['.env'], /DB_BACKEND=sqlite/);
  assert.match(plan.files['.env'], /SQLITE_DB_PATH=\/var\/lib\/bitcoin-accounting\/ledger.db/);
  assert.doesNotMatch(plan.script, /CREATE ROLE/);
  assert.doesNotMatch(plan.script, /ALTER ROLE/);
  assert.doesNotMatch(plan.script, /createdb --owner=/);
});

test('install planner uses local sovereign font env values when shared nginx fonts are available', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-font-local-'));
  const sharedRoot = path.join(tempDir, 'sovereign-home');
  const fontDir = path.join(sharedRoot, 'assets', 'fonts');
  fs.mkdirSync(fontDir, { recursive: true });
  fs.writeFileSync(path.join(fontDir, 'source-sans-3.css'), '/* test */\n');
  fs.writeFileSync(path.join(fontDir, 'jetbrains-mono.css'), '/* test */\n');

  const plan = buildInstallPlan({
    appId: 'family-help',
    state: { installations: {} },
    options: {},
    config: {
      port: 3080,
      serviceUser: 'sovereign',
      baseInstallDir: path.join(sharedRoot, 'apps'),
      homeBaseSharedRoot: sharedRoot,
      homeBaseAssetsRoot: path.join(sharedRoot, 'assets'),
      sovereignFontMountPath: '/_sovereign/fonts/',
      defaultHostname: 'homebase',
      defaultDomain: 'tailnet',
    },
  });

  assert.match(plan.files['.env'], /SOVEREIGN_FONT_SOURCE=local/);
  assert.match(plan.files['.env'], /SOVEREIGN_FONT_SANS_CSS_URL_LOCAL=https:\/\/homebase\.tailnet\/_sovereign\/fonts\/source-sans-3\.css/);
  assert.match(plan.files['.env'], /SOVEREIGN_FONT_MONO_CSS_URL_LOCAL=https:\/\/homebase\.tailnet\/_sovereign\/fonts\/jetbrains-mono\.css/);
});

test('install planner falls back to google sovereign font env values when local fonts are unavailable', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-font-google-'));
  const sharedRoot = path.join(tempDir, 'sovereign-home');

  const plan = buildInstallPlan({
    appId: 'family-help',
    state: { installations: {} },
    options: {},
    config: {
      port: 3080,
      serviceUser: 'sovereign',
      baseInstallDir: path.join(sharedRoot, 'apps'),
      homeBaseSharedRoot: sharedRoot,
      homeBaseAssetsRoot: path.join(sharedRoot, 'assets'),
      defaultHostname: 'homebase',
      defaultDomain: 'tailnet',
    },
  });

  assert.match(plan.files['.env'], /SOVEREIGN_FONT_SOURCE=google/);
  assert.match(plan.files['.env'], /SOVEREIGN_FONT_SANS_CSS_URL="?https:\/\/fonts\.googleapis\.com\/css2\?family=Source\+Sans\+3:wght@400;500;600;700&display=swap"?/);
});
