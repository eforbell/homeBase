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

test('home source install planner provisions import worker and continuity timers', () => {
  const plan = buildInstallPlan({
    appId: 'home-source',
    state: { installations: {} },
    options: {},
    config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', defaultHostname: 'homebase', defaultDomain: 'tailnet' },
  });

  assert.match(plan.files['home-source-import-worker.service'], /Description=Home Source Import Worker/);
  assert.match(plan.files['home-source-import-worker.service'], /ExecStart=node bin\/import-worker\.js/);
  assert.match(plan.script, /install -d -m 0750 -o sovereign -g sovereign \/var\/lib\/sovereign-home\/home-source\/data/);
  assert.match(plan.script, /install -d -m 0750 -o sovereign -g sovereign \/var\/lib\/sovereign-home\/home-source\/data\/documents/);
  assert.match(plan.script, /install -d -m 0750 -o sovereign -g sovereign \/var\/lib\/sovereign-home\/home-source\/data\/thumbnails/);
  assert.match(plan.script, /install -d -m 0750 -o sovereign -g sovereign \/var\/lib\/sovereign-home\/home-source\/data\/exports/);
  assert.match(plan.script, /sudo apt-get install -y poppler-utils/);
  assert.match(plan.script, /\/etc\/systemd\/system\/home-source-import-worker\.service/);
  assert.match(plan.script, /systemctl enable home-source-import-worker/);
  assert.match(plan.script, /systemctl restart home-source-import-worker/);
  assert.match(plan.files['.env'], /APP_URL=https:\/\/homebase\.tailnet\/source\//);
  assert.match(plan.files['.env'], /MAIL_TRANSPORT=smtp/);
  assert.match(plan.files['home-source-continuity-check.service'], /Type=oneshot/);
  assert.match(plan.files['home-source-continuity-check.service'], /ExecStart=node bin\/deadman-check\.js --once/);
  assert.match(plan.files['home-source-continuity-check.timer'], /OnCalendar=\*-\*-\* 09:00:00/);
  assert.match(plan.files['home-source-continuity-check.timer'], /RandomizedDelaySec=5m/);
  assert.match(plan.files['home-source-continuity-outbox.service'], /ExecStart=node bin\/continuity-outbox\.js --once/);
  assert.match(plan.files['home-source-continuity-outbox.timer'], /OnBootSec=5m/);
  assert.match(plan.files['home-source-continuity-outbox.timer'], /OnUnitActiveSec=15m/);
  assert.doesNotMatch(plan.files['home-source-continuity-outbox.timer'], /OnCalendar=undefined/);
  assert.match(plan.script, /\/etc\/systemd\/system\/home-source-continuity-check\.timer/);
  assert.match(plan.script, /\/etc\/systemd\/system\/home-source-continuity-outbox\.timer/);
  assert.match(plan.script, /systemctl enable home-source-continuity-check\.timer/);
  assert.match(plan.script, /systemctl restart home-source-continuity-outbox\.timer/);
});

test('home source reinstall preserves operator mail settings', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-home-source-env-'));
  const appDir = path.join(tempDir, 'homeSource');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.env'), [
    'MAIL_TRANSPORT=disabled',
    'SMTP_HOST=relay.family.test',
    'SMTP_PORT=2525',
    'SMTP_FROM=Home Source <vault@family.test>',
    'NOTIFICATION_TO=operator@family.test',
    '',
  ].join('\n'));

  const plan = buildInstallPlan({
    appId: 'home-source',
    state: { installations: { 'home-source': { installRoot: appDir } } },
    options: {},
    config: {
      port: 3080,
      serviceUser: 'sovereign',
      baseInstallDir: tempDir,
      defaultHostname: 'homebase',
      defaultDomain: 'tailnet',
    },
  });

  assert.match(plan.files['.env'], /MAIL_TRANSPORT=disabled/);
  assert.match(plan.files['.env'], /SMTP_HOST=relay\.family\.test/);
  assert.match(plan.files['.env'], /SMTP_PORT=2525/);
  assert.match(plan.files['.env'], /SMTP_FROM="Home Source <vault@family\.test>"/);
  assert.match(plan.files['.env'], /NOTIFICATION_TO=operator@family\.test/);
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

test('install planner preserves Family Dinner OpenAI model env during reinstall', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-install-dinner-openai-'));
  const appDir = path.join(tempDir, 'familyDinner');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.env'), [
    'DATABASE_URL=postgresql://family_dinner:existing-pass@127.0.0.1:5432/family_dinner',
    'OPENAI_API_KEY=existing-openai-key',
    'OPENAI_MODEL=gpt-5.4-nano',
    'OPENAI_RECIPE_MODEL=gpt-5.4-nano',
    'OPENAI_REASONING_EFFORT=low',
    '',
  ].join('\n'));

  const plan = buildInstallPlan({
    appId: 'family-dinner',
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

  assert.match(plan.files['.env'], /OPENAI_API_KEY=existing-openai-key/);
  assert.match(plan.files['.env'], /OPENAI_MODEL=gpt-5\.4-nano/);
  assert.match(plan.files['.env'], /OPENAI_RECIPE_MODEL=gpt-5\.4-nano/);
  assert.match(plan.files['.env'], /OPENAI_REASONING_EFFORT=low/);
  assert.doesNotMatch(plan.files['.env'], /OPENAI_MODEL=gpt-4o-mini/);
  assert.doesNotMatch(plan.files['.env'], /OPENAI_RECIPE_MODEL=gpt-4o-mini/);
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

test('install planner preserves operator-enabled chain status flags during bitcoin accounting reinstall', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-install-chain-status-'));
  const appDir = path.join(tempDir, 'bitcoinAccounting');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.env'), [
    'BITCOIN_CHAIN_STATUS_ENABLED=1',
    'BITCOIN_RPC_URL=http://127.0.0.1:8332',
    'BITCOIN_RPC_COOKIE_FILE=/var/lib/bitcoind/.cookie',
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

  assert.match(plan.files['.env'], /BITCOIN_CHAIN_STATUS_ENABLED=1/);
  assert.doesNotMatch(plan.files['.env'], /BITCOIN_CHAIN_STATUS_ENABLED=0/);
  assert.match(plan.files['.env'], /BITCOIN_RPC_URL=http:\/\/127\.0\.0\.1:8332/);
  assert.match(plan.files['.env'], /BITCOIN_RPC_COOKIE_FILE=\/var\/lib\/bitcoind\/\.cookie/);
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

test('helm plan renders HomeBase-preserved subpath, Helm env, timers, and python units', () => {
  const plan = buildInstallPlan({
    appId: 'helm',
    state: { installations: {} },
    options: { dbPassword: 'helm-pass' },
    config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', defaultHostname: 'homebase', defaultDomain: 'tailnet' },
  });

  assert.equal(plan.install.port, 3011);
  assert.equal(plan.install.health.readinessPath, '/health');
  assert.match(plan.files['.env'], /HELM_ENV=production/);
  assert.match(plan.files['.env'], /HELM_WEB_BASE_PATH=\/helm/);
  assert.match(plan.files['.env'], /HELM_DATABASE_URL=postgresql:\/\/helm:helm-pass@127\.0\.0\.1:5432\/helm/);
  assert.match(plan.files['.env'], /SCHWAB_TOKEN_PATH=\.\/\.secrets\/schwab_tokens\.db/);
  assert.match(plan.files['.env'], /HELM_AUTH_ENABLED=1/);
  assert.doesNotMatch(plan.files['.env'], /MONITOR_CONCENTRATION_CAP_PCT/);
  assert.match(plan.files['helm-web.service'], /UMask=0077/);
  assert.match(plan.files['helm-web.service'], /ExecStart=\/opt\/sovereign-home\/apps\/helm\/\.venv\/bin\/uvicorn/);
  assert.match(plan.files['helm-sync.service'], /UMask=0077/);
  assert.match(plan.files['helm-sync.service'], /ExecStart=\/opt\/sovereign-home\/apps\/helm\/\.venv\/bin\/helm sync/);
  assert.match(plan.files['helm-sync.timer'], /OnCalendar=Mon\.\.Fri 08:00 America\/New_York/);
  assert.match(plan.files['helm-review.service'], /UMask=0077/);
  assert.match(plan.files['helm-review.service'], /ExecStart=\/opt\/sovereign-home\/apps\/helm\/\.venv\/bin\/helm review --trigger weekly --if-due/);
  assert.match(plan.files['helm-review.timer'], /OnCalendar=Mon 08:15/);
  assert.match(plan.files['helm-review.timer'], /Persistent=true/);
  assert.match(plan.files['helm-research.service'], /UMask=0077/);
  assert.match(plan.files['helm-research.service'], /ExecStart=\/opt\/sovereign-home\/apps\/helm\/\.venv\/bin\/helm research/);
  assert.match(plan.files['helm-research.timer'], /OnCalendar=Sat 08:30/);
  assert.match(plan.files['helm-research.timer'], /Persistent=true/);
  assert.match(plan.files['helm-monitor.service'], /UMask=0077/);
  assert.match(plan.files['helm-monitor.service'], /Environment=PYTHONUNBUFFERED=1/);
  assert.match(plan.files['helm-monitor.timer'], /OnCalendar=Mon\.\.Fri 09\.\.16:00\/30/);
  assert.match(plan.files['helm-monitor.timer'], /Persistent=false/);
  assert.match(plan.files['helm-token-refresh.timer'], /OnCalendar=\*-\*-\* 07:30/);
  assert.match(plan.files['helm.nginx.conf'], /location \/helm\//);
  assert.match(plan.files['helm.nginx.conf'], /proxy_pass http:\/\/127\.0\.0\.1:3011;/);
  assert.doesNotMatch(plan.files['helm.nginx.conf'], /proxy_pass http:\/\/127\.0\.0\.1:3011\//);
  assert.match(plan.script, /install -d -m 0700 \.secrets/);
  assert.match(plan.script, /migrations\/run_migration\.py/);
  assert.match(plan.script, /systemctl enable helm-sync\.timer/);
  assert.match(plan.script, /systemctl enable helm-review\.timer/);
  assert.match(plan.script, /systemctl restart helm-token-refresh\.timer/);
});

test('install planner preserves existing Helm database URL and production secrets', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-install-helm-env-'));
  const appDir = path.join(tempDir, 'helm');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.env'), [
    'HELM_DATABASE_URL=postgresql://existing:existing-pass@127.0.0.1:5432/existing_helm',
    'SCHWAB_APP_KEY=existing-key',
    'SCHWAB_APP_SECRET=existing-secret',
    'SCHWAB_CALLBACK_URL=https://schwab-callback.example.com/oauth/callback',
    'ADVISOR_PROVIDER=openai',
    'ADVISOR_MODEL=gpt-5.4-mini-2026-03-17',
    'HELM_MODEL_SYNTHESIS_ENABLED=1',
    'OPENAI_API_KEY=existing-openai',
    'BRRR_SECRET=existing-brrr',
    'HELM_AUTH_PASSPHRASE=existing-passphrase',
    'HELM_SESSION_SECRET=existing-session',
    '',
  ].join('\n'));

  const plan = buildInstallPlan({
    appId: 'helm',
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

  assert.equal(plan.install.dbName, 'existing_helm');
  assert.equal(plan.install.dbUser, 'existing');
  assert.match(plan.files['.env'], /HELM_DATABASE_URL=postgresql:\/\/existing:existing-pass@127\.0\.0\.1:5432\/existing_helm/);
  assert.match(plan.files['.env'], /SCHWAB_APP_KEY=existing-key/);
  assert.match(plan.files['.env'], /SCHWAB_APP_SECRET=existing-secret/);
  assert.match(plan.files['.env'], /ADVISOR_PROVIDER=openai/);
  assert.match(plan.files['.env'], /ADVISOR_MODEL=gpt-5\.4-mini-2026-03-17/);
  assert.match(plan.files['.env'], /HELM_MODEL_SYNTHESIS_ENABLED=1/);
  assert.match(plan.files['.env'], /OPENAI_API_KEY=existing-openai/);
  assert.match(plan.files['.env'], /BRRR_SECRET=existing-brrr/);
  assert.match(plan.files['.env'], /HELM_SESSION_SECRET=existing-session/);
  assert.doesNotMatch(plan.script, /CREATE ROLE/);
  assert.doesNotMatch(plan.script, /createdb --owner=/);
});

test('install planner does not skip Helm database bootstrap when only HELM_TEST_DATABASE_URL exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-install-helm-test-db-only-'));
  const appDir = path.join(tempDir, 'helm');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.env'), [
    'HELM_TEST_DATABASE_URL=postgresql://helm:helm@127.0.0.1:5432/helm_test',
    '',
  ].join('\n'));

  const plan = buildInstallPlan({
    appId: 'helm',
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

  assert.match(plan.files['.env'], /HELM_TEST_DATABASE_URL=postgresql:\/\/helm:helm@127\.0\.0\.1:5432\/helm_test/);
  assert.match(plan.files['.env'], /HELM_DATABASE_URL=postgresql:\/\/helm:[A-Za-z0-9_-]+@127\.0\.0\.1:5432\/helm/);
  assert.match(plan.script, /CREATE ROLE helm LOGIN PASSWORD/);
  assert.match(plan.script, /createdb --owner=helm helm/);
});
