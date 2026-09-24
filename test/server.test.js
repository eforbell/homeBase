const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const { SqliteStateStore } = require('../src/state/sqlite-store');

async function startServer(config) {
  const app = createApp(config);
  await new Promise((resolve) => app.server.listen(0, resolve));
  const address = app.server.address();
  return {
    app,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function assertUnlockedRealExecuteResult(response, payload) {
  assert.equal([202, 409].includes(response.status), true);
  if (response.status === 202) {
    assert.equal(payload.ok, true);
    return;
  }
  assert.equal(typeof payload.error, 'string');
  assert.match(payload.error, /Preflight checks must pass/i);
  assert.doesNotMatch(payload.error, /Admin unlock is required/i);
  assert.doesNotMatch(payload.error, /Admin setup is required/i);
}

async function setupAdminCookie(baseUrl, passphrase = 'test-admin-passphrase') {
  const setupRes = await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /hb_admin_session=/);
  return cookie;
}

test('managed listener binds to loopback by default', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-loopback-'));
  const app = createApp({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  await new Promise((resolve) => app.listen(resolve));
  try {
    assert.equal(app.server.address().address, '127.0.0.1');
  } finally {
    await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('HTTP API exposes catalog and can persist a planned install', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const catalogRes = await fetch(`${server.url}/api/catalog`);
    const catalog = await catalogRes.json();
    assert.equal(Array.isArray(catalog.apps), true);
    assert.equal(catalog.apps.some((entry) => entry.id === 'family-dinner'), true);

    const installRes = await fetch(`${server.url}/api/apps/family-dinner/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountPath: '/dinner/' }),
    });
    const installPlan = await installRes.json();
    assert.equal(installPlan.app.id, 'family-dinner');

    const stateRes = await fetch(`${server.url}/api/state`);
    const state = await stateRes.json();
    assert.equal(state.installations['family-dinner'].status, 'planned');
  } finally {
    await server.close();
  }
});

test('a saved dry-run can be discarded without an uninstall job or host mutation', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-discard-plan-'));
  const server = await startServer({
    appName: 'Home Base', stateDbPath: path.join(tempDir, 'state.sqlite3'), port: 0,
    serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', baseBackupDir: path.join(tempDir, 'backups'), baseConfigDir: '/etc/sovereign-home', defaultHostname: 'homebase', defaultDomain: 'tailnet',
  });
  try {
    await fetch(`${server.url}/api/apps/family-dinner/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mountPath: '/dinner/' }),
    });
    const cookie = await setupAdminCookie(server.url);
    const discard = await fetch(`${server.url}/api/apps/family-dinner/discard-plan`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ confirm: 'DISCARD' }),
    });
    assert.equal(discard.status, 200);
    assert.equal((await discard.json()).discarded, true);
    const state = await (await fetch(`${server.url}/api/state`)).json();
    assert.equal(state.installations['family-dinner'], undefined);
    assert.equal(state.jobs.length, 0);
  } finally {
    await server.close();
  }
});

test('state exposes active install jobs separately from recent jobs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-active-install-'));
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: dbPath,
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const store = new SqliteStateStore(dbPath);
    const createdAt = new Date().toISOString();
    const { id } = store.createJob({
      kind: 'install',
      target: 'family-plan',
      status: 'running',
      dryRun: false,
      createdAt,
      currentStep: 'install-app',
      planJson: JSON.stringify({ app: { id: 'family-plan' } }),
    });

    const stateRes = await fetch(`${server.url}/api/state`);
    const state = await stateRes.json();
    const active = state.activeJobs.find((job) => job.id === id);

    assert.equal(active.kind, 'install');
    assert.equal(active.target, 'family-plan');
    assert.equal(active.status, 'running');
    assert.equal(active.dryRun, false);
  } finally {
    await server.close();
  }
});

test('home page route serves static dashboard shell and state still carries external urls', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-setup-link-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    await fetch(`${server.url}/api/apps/family-help/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountPath: '/help/' }),
    });
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);

    const stateRes = await fetch(`${server.url}/api/state`);
    const state = await stateRes.json();
    assert.equal(state.installations['family-help'].externalUrl, 'https://homebase.tailnet/help/');
  } finally {
    await server.close();
  }
});

test('control-plane routes serve their page shells and legacy /settings redirects to /config', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-control-plane-pages-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    for (const route of ['/status', '/admin', '/config', '/network']) {
      const res = await fetch(`${server.url}${route}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
    }

    const redirectRes = await fetch(`${server.url}/settings`, { redirect: 'manual' });
    assert.equal(redirectRes.status, 302);
    assert.equal(redirectRes.headers.get('location'), '/config');
  } finally {
    await server.close();
  }
});

test('homebase runtime plan endpoint returns service-install scaffolding', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-runtime-plan-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
  });

  try {
    const res = await fetch(`${server.url}/api/homebase/runtime-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const plan = await res.json();
    assert.equal(plan.kind, 'homebase-runtime');
    assert.equal(plan.runtime.serviceName, 'homebase');
  } finally {
    await server.close();
  }
});

test('homebase runtime plan endpoint rejects command-bearing options', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-runtime-plan-invalid-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
  });

  try {
    const res = await fetch(`${server.url}/api/homebase/runtime-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appDir: '/opt/homebase; touch /tmp/pwned' }),
    });
    const payload = await res.json();
    assert.equal(res.status, 400);
    assert.match(payload.error, /appDir must be an absolute path/i);
  } finally {
    await server.close();
  }
});

test('homebase install-self dry-run creates a runtime job', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-runtime-job-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
  });

  try {
    const adminCookie = await setupAdminCookie(server.url);
    const res = await fetch(`${server.url}/api/homebase/install-self`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true, port: 3180 }),
    });
    const payload = await res.json();
    assert.equal(payload.ok, true);
    const jobRes = await fetch(`${server.url}/api/jobs/${payload.jobId}`, { headers: { cookie: adminCookie } });
    const job = await jobRes.json();
    assert.equal(job.kind, 'homebase-runtime');
  } finally {
    await server.close();
  }
});

test('startup reconciles stale homebase update jobs that already issued service restart', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-update-reconcile-'));
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const store = new SqliteStateStore(dbPath);
  store.init();
  const { id } = store.createJob({
    kind: 'homebase-update',
    target: 'homebase',
    status: 'running',
    dryRun: false,
    createdAt: '2026-04-23T00:00:00.000Z',
    currentStep: 'restart-service',
    planJson: JSON.stringify({
      executionSteps: [
        { id: 'git-pull' },
        { id: 'install-deps' },
        { id: 'restart-service' },
      ],
    }),
  });
  store.appendJobLog(id, '$ sudo systemctl restart homebase\n');

  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: dbPath,
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const adminCookie = await setupAdminCookie(server.url);
    const jobRes = await fetch(`${server.url}/api/jobs/${id}`, { headers: { cookie: adminCookie } });
    const job = await jobRes.json();
    assert.equal(job.status, 'completed');
    assert.match(job.log, /marking update job completed during startup/i);
    assert.match(job.resultJson, /reconciledAfterRestart/);
  } finally {
    await server.close();
  }
});

test('startup does not reconcile stale homebase update jobs that never issued restart command', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-update-no-reconcile-'));
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const store = new SqliteStateStore(dbPath);
  store.init();
  const { id } = store.createJob({
    kind: 'homebase-update',
    target: 'homebase',
    status: 'running',
    dryRun: false,
    createdAt: '2026-04-23T00:00:00.000Z',
    currentStep: 'restart-service',
    planJson: JSON.stringify({
      executionSteps: [
        { id: 'git-pull' },
        { id: 'install-deps' },
        { id: 'restart-service' },
      ],
    }),
  });
  store.appendJobLog(id, '$ sudo -u homebase -H bash -lc \'cd /opt/sovereign-home/homebase && npm ci --omit=dev\'\n');

  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: dbPath,
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const adminCookie = await setupAdminCookie(server.url);
    const jobRes = await fetch(`${server.url}/api/jobs/${id}`, { headers: { cookie: adminCookie } });
    const job = await jobRes.json();
    assert.equal(job.status, 'running');
    assert.doesNotMatch(job.log, /marking update job completed during startup/i);
  } finally {
    await server.close();
  }
});

test('homebase status endpoint returns runtime state summary', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-status-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
  });

  try {
    const res = await fetch(`${server.url}/api/homebase/status`);
    const payload = await res.json();
    assert.equal(payload.runtimeUser, 'homebase');
    assert.equal(payload.bindHost, '127.0.0.1');
    assert.equal(payload.executionMode, 'plan-only');
    assert.equal(payload.privilegedJobsEnabled, false);
    assert.equal(payload.legacyBroadSudoersDetected, false);
    assert.equal(payload.sudoersPolicyStatus, 'absent');
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.paths.stateDbExists, 'boolean');
  } finally {
    await server.close();
  }
});

test('homebase status reports executor mode without calling it legacy sudo', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-status-executor-'));
  const server = await startServer({
    appName: 'Home Base', stateDbPath: path.join(tempDir, 'state.sqlite3'), port: 0,
    serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', baseBackupDir: '/var/lib/sovereign-home/backups', baseConfigDir: '/etc/sovereign-home', defaultHostname: 'homebase', defaultDomain: 'tailnet',
    homeBaseExecutionMode: 'executor', homeBaseEnablePrivilegedJobs: true,
  });
  try {
    const payload = await (await fetch(`${server.url}/api/homebase/status`)).json();
    assert.equal(payload.executionMode, 'executor');
    assert.equal(payload.privilegedJobsEnabled, true);
  } finally {
    await server.close();
  }
});

test('homebase status reports unknown when a configured sudoers path cannot be read as a file', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-sudoers-status-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
    homeBaseSudoersFile: tempDir,
  });

  try {
    const res = await fetch(`${server.url}/api/homebase/status`);
    const payload = await res.json();
    assert.equal(payload.paths.sudoersFileExists, true);
    assert.equal(payload.legacyBroadSudoersDetected, false);
    assert.equal(payload.sudoersPolicyStatus, 'unknown');
  } finally {
    await server.close();
  }
});

test('homebase status detects broad sudoers for the configured runtime user', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-sudoers-user-'));
  const sudoersFile = path.join(tempDir, 'homebase-sudoers');
  fs.writeFileSync(sudoersFile, 'customhb ALL=(ALL) NOPASSWD:ALL\n');
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
    homeBaseRuntimeUser: 'customhb',
    homeBaseSudoersFile: sudoersFile,
  });

  try {
    const res = await fetch(`${server.url}/api/homebase/status`);
    const payload = await res.json();
    assert.equal(payload.legacyBroadSudoersDetected, true);
    assert.equal(payload.sudoersPolicyStatus, 'legacy-broad');
  } finally {
    await server.close();
  }
});

test('apps health endpoint returns deployment and runtime state snapshot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-app-health-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    await fetch(`${server.url}/api/apps/family-help/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountPath: '/help/' }),
    });
    const res = await fetch(`${server.url}/api/apps/health`);
    const payload = await res.json();
    const item = payload.byAppId['family-help'];
    assert.equal(typeof payload.checkedAt, 'string');
    assert.equal(item.deploymentStatus, 'planned');
    assert.equal(item.runtimeStatus, 'not-installed');
    assert.equal(typeof item.recoveryHint, 'string');
  } finally {
    await server.close();
  }
});

test('homebase config endpoint returns defaults and persists validated updates', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-config-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
  });

  try {
    const beforeRes = await fetch(`${server.url}/api/homebase/config`);
    const before = await beforeRes.json();
    assert.equal(before.hostname, 'homebase');
    assert.equal(before.hostnameIsPlaceholder, true);
    assert.equal(before.gitTransport, 'https');
    assert.equal(before.healthAlertsEnabled, false);
    assert.equal(before.healthAlertsWebhookUrl, '');
    assert.equal(before.tailscaleManagedServiceId, 'svc:home');

    const updateRes = await fetch(`${server.url}/api/homebase/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostname: 'erebor',
        domain: 'example.ts.net',
        gitTransport: 'ssh-key',
        gitSshKeyPath: '/home/sovereign/.ssh/id_ed25519',
        healthAlertsEnabled: true,
        healthAlertsWebhookUrl: 'https://alerts.example.test/hook',
        tailscaleManagedServiceId: 'svc:test',
      }),
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.hostname, 'erebor');
    assert.equal(updated.domain, 'example.ts.net');
    assert.equal(updated.gitTransport, 'ssh-key');
    assert.equal(updated.gitSshKeyPath, '/home/sovereign/.ssh/id_ed25519');
    assert.equal(updated.healthAlertsEnabled, true);
    assert.equal(updated.healthAlertsWebhookUrl, 'https://alerts.example.test/hook');
    assert.equal(updated.tailscaleManagedServiceId, 'svc:test');
    assert.equal(updated.hostnameIsPlaceholder, false);

    const afterRes = await fetch(`${server.url}/api/homebase/config`);
    const after = await afterRes.json();
    assert.equal(after.hostname, 'erebor');
    assert.equal(after.gitTransport, 'ssh-key');
    assert.equal(after.healthAlertsEnabled, true);
    assert.equal(after.tailscaleManagedServiceId, 'svc:test');
  } finally {
    await server.close();
  }
});

test('admin status starts unconfigured and locked', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-admin-status-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
  });

  try {
    const res = await fetch(`${server.url}/api/admin/status`);
    const payload = await res.json();
    assert.equal(payload.configured, false);
    assert.equal(payload.unlocked, false);
  } finally {
    await server.close();
  }
});

test('plan-only mode blocks real host execution after admin unlock', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-plan-only-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
    homeBaseExecutionMode: 'plan-only',
    homeBaseEnablePrivilegedJobs: false,
  });

  try {
    const cookie = await setupAdminCookie(server.url, 'plan-only-passphrase');
    const res = await fetch(`${server.url}/api/bootstrap/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE' }),
    });
    const payload = await res.json();
    assert.equal(res.status, 409);
    assert.equal(payload.code, 'PRIVILEGED_EXECUTION_DISABLED');
    assert.equal(payload.executionMode, 'plan-only');
    assert.match(payload.error, /operator shell/i);

    const auditRes = await fetch(`${server.url}/api/admin/audit?limit=1`, {
      headers: { cookie },
    });
    assert.equal(auditRes.status, 200);
    const audit = await auditRes.json();
    assert.equal(audit.entries[0].outcome, 'blocked-execution-mode');
  } finally {
    await server.close();
  }
});

test('real execute requires admin setup/unlock', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-admin-guard-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
    homeBaseEnablePrivilegedJobs: true,
  });

  try {
    const withoutAdminRes = await fetch(`${server.url}/api/bootstrap/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE' }),
    });
    const withoutAdmin = await withoutAdminRes.json();
    assert.equal(withoutAdminRes.status, 409);
    assert.match(withoutAdmin.error, /Admin setup is required/i);

    const setupRes = await fetch(`${server.url}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'very-secure-passphrase' }),
    });
    assert.equal(setupRes.status, 200);
    const setupCookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
    assert.match(setupCookie, /hb_admin_session=/);

    const lockRes = await fetch(`${server.url}/api/admin/lock`, {
      method: 'POST',
      headers: { cookie: setupCookie },
    });
    assert.equal(lockRes.status, 200);

    const lockedExecuteRes = await fetch(`${server.url}/api/bootstrap/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE' }),
    });
    const lockedExecute = await lockedExecuteRes.json();
    assert.equal(lockedExecuteRes.status, 401);
    assert.match(lockedExecute.error, /Admin unlock is required/i);

    const unlockRes = await fetch(`${server.url}/api/admin/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'very-secure-passphrase' }),
    });
    assert.equal(unlockRes.status, 200);
    const unlockCookie = (unlockRes.headers.get('set-cookie') || '').split(';')[0];
    assert.match(unlockCookie, /hb_admin_session=/);

    const unlockedExecuteRes = await fetch(`${server.url}/api/bootstrap/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: unlockCookie },
      body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE' }),
    });
    const unlockedExecute = await unlockedExecuteRes.json();
    assertUnlockedRealExecuteResult(unlockedExecuteRes, unlockedExecute);
  } finally {
    await server.close();
  }
});

test('admin passphrase rotation requires unlock and invalidates prior sessions', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-admin-rotate-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
    homeBaseEnablePrivilegedJobs: true,
  });

  try {
    await fetch(`${server.url}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'first-passphrase' }),
    });
    const unlockRes = await fetch(`${server.url}/api/admin/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'first-passphrase' }),
    });
    const unlockCookie = (unlockRes.headers.get('set-cookie') || '').split(';')[0];

    const badRotateRes = await fetch(`${server.url}/api/admin/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: unlockCookie },
      body: JSON.stringify({ currentPassphrase: 'wrong', newPassphrase: 'second-passphrase' }),
    });
    assert.equal(badRotateRes.status, 403);

    const rotateRes = await fetch(`${server.url}/api/admin/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: unlockCookie },
      body: JSON.stringify({ currentPassphrase: 'first-passphrase', newPassphrase: 'second-passphrase' }),
    });
    assert.equal(rotateRes.status, 200);
    const rotatedCookie = (rotateRes.headers.get('set-cookie') || '').split(';')[0];
    assert.match(rotatedCookie, /hb_admin_session=/);

    const oldSessionRes = await fetch(`${server.url}/api/bootstrap/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: unlockCookie },
      body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE' }),
    });
    const oldSessionPayload = await oldSessionRes.json();
    assert.equal(oldSessionRes.status, 401);
    assert.match(oldSessionPayload.error, /Admin unlock is required/i);

    const newSessionRes = await fetch(`${server.url}/api/bootstrap/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: rotatedCookie },
      body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE' }),
    });
    const newSessionPayload = await newSessionRes.json();
    assertUnlockedRealExecuteResult(newSessionRes, newSessionPayload);

    const oldPassUnlock = await fetch(`${server.url}/api/admin/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'first-passphrase' }),
    });
    assert.equal(oldPassUnlock.status, 403);

    const newPassUnlock = await fetch(`${server.url}/api/admin/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'second-passphrase' }),
    });
    assert.equal(newPassUnlock.status, 200);
  } finally {
    await server.close();
  }
});

test('admin audit endpoint requires unlock and records destructive attempts', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-admin-audit-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
    homeBaseEnablePrivilegedJobs: true,
  });

  try {
    await fetch(`${server.url}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'audit-passphrase' }),
    });

    const lockedAuditRes = await fetch(`${server.url}/api/admin/audit`);
    assert.equal(lockedAuditRes.status, 401);

    const unlockRes = await fetch(`${server.url}/api/admin/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'audit-passphrase' }),
    });
    const cookie = (unlockRes.headers.get('set-cookie') || '').split(';')[0];

    const attemptRes = await fetch(`${server.url}/api/bootstrap/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE' }),
    });
    const attemptPayload = await attemptRes.json();
    assertUnlockedRealExecuteResult(attemptRes, attemptPayload);

    const auditRes = await fetch(`${server.url}/api/admin/audit?limit=5`, {
      headers: { cookie },
    });
    assert.equal(auditRes.status, 200);
    const auditPayload = await auditRes.json();
    assert.equal(Array.isArray(auditPayload.entries), true);
    assert.equal(auditPayload.entries[0].action, 'bootstrap-execute');
    assert.equal(['blocked-preflight', 'queued'].includes(auditPayload.entries[0].outcome), true);
    assert.equal(typeof auditPayload.entries[0].sessionTokenHash, 'string');
    assert.equal(auditPayload.entries[0].sessionTokenHash.length > 20, true);
  } finally {
    await server.close();
  }
});

test('job history endpoints require admin unlock before exposing logs and plan payloads', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-job-history-auth-'));
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: dbPath,
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
  });

  try {
    const store = new SqliteStateStore(dbPath);
    const { id } = store.createJob({
      kind: 'install',
      target: 'family-pulse',
      status: 'completed',
      dryRun: false,
      createdAt: new Date().toISOString(),
      currentStep: null,
      planJson: JSON.stringify({ env: { OPENAI_API_KEY: 'sk-test-secret' } }),
    });
    store.appendJobLog(id, 'PLAID_SECRET=plaid-test-secret\n');

    const setupCookie = await setupAdminCookie(server.url, 'history-passphrase');
    const lockRes = await fetch(`${server.url}/api/admin/lock`, {
      method: 'POST',
      headers: { cookie: setupCookie },
    });
    assert.equal(lockRes.status, 200);

    const lockedListRes = await fetch(`${server.url}/api/jobs`);
    const lockedList = await lockedListRes.text();
    assert.equal(lockedListRes.status, 401);
    assert.doesNotMatch(lockedList, /plaid-test-secret|sk-test-secret/i);

    const lockedDetailRes = await fetch(`${server.url}/api/jobs/${id}`);
    const lockedDetail = await lockedDetailRes.text();
    assert.equal(lockedDetailRes.status, 401);
    assert.doesNotMatch(lockedDetail, /plaid-test-secret|sk-test-secret/i);

    const unlockRes = await fetch(`${server.url}/api/admin/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'history-passphrase' }),
    });
    const unlockCookie = (unlockRes.headers.get('set-cookie') || '').split(';')[0];
    assert.match(unlockCookie, /hb_admin_session=/);

    const unlockedDetailRes = await fetch(`${server.url}/api/jobs/${id}`, {
      headers: { cookie: unlockCookie },
    });
    assert.equal(unlockedDetailRes.status, 200);
    const unlockedDetail = await unlockedDetailRes.json();
    assert.match(unlockedDetail.log, /plaid-test-secret/);
    assert.match(unlockedDetail.planJson, /sk-test-secret/);
  } finally {
    await server.close();
  }
});

test('health alert test endpoint posts to configured webhook target', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-alert-test-'));
  const posted = [];
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    notificationsPostJson: async (url, body) => {
      posted.push({ url, body });
    },
  });

  try {
    await fetch(`${server.url}/api/homebase/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostname: 'test',
        domain: 'example.ts.net',
        gitTransport: 'https',
        healthAlertsEnabled: true,
        healthAlertsWebhookUrl: 'https://alerts.example.test/hook',
        tailscaleManagedServiceId: 'svc:test',
      }),
    });

    const res = await fetch(`${server.url}/api/alerts/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = await res.json();
    assert.equal(payload.ok, true);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, 'https://alerts.example.test/hook');
    assert.equal(posted[0].body.event, 'app-health-test');
  } finally {
    await server.close();
  }
});

test('apps health endpoint still responds when webhook delivery fails', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-alert-failure-'));
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: dbPath,
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    notificationsPostJson: async () => {
      throw new Error('webhook offline');
    },
  });

  try {
    const store = new SqliteStateStore(dbPath);
    store.upsertInstallation({
      appId: 'family-help',
      name: 'Family Help',
      purpose: 'Household task intake',
      port: 3002,
      mountPath: '/help/',
      externalUrl: 'https://homebase.tailnet/help/',
      installRoot: '/opt/sovereign-home/apps/family-help',
      serviceName: 'definitely-not-a-real-service',
      ref: 'main',
      status: 'installed',
      plannedAt: '2026-04-18T12:00:00.000Z',
      updatedAt: '2026-04-18T12:00:00.000Z',
    });

    const cfgRes = await fetch(`${server.url}/api/homebase/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostname: 'homebase',
        domain: 'tailnet',
        gitTransport: 'https',
        healthAlertsEnabled: true,
        healthAlertsWebhookUrl: 'https://alerts.example.test/hook',
        tailscaleManagedServiceId: 'svc:test',
      }),
    });
    assert.equal(cfgRes.status, 200);

    const res = await fetch(`${server.url}/api/apps/health`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.byAppId['family-help'].runtimeStatus, 'service-down');
  } finally {
    await server.close();
  }
});

test('apps health onboarding setupUrl follows hostname/domain config updates', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-health-setup-url-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
  });

  try {
    await fetch(`${server.url}/api/apps/family-help/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountPath: '/help/' }),
    });

    const beforeRes = await fetch(`${server.url}/api/apps/health`);
    const before = await beforeRes.json();
    assert.equal(before.byAppId['family-help'].onboarding.setupUrl, 'https://homebase.tailnet/help/setup');

    const updateRes = await fetch(`${server.url}/api/homebase/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostname: 'test',
        domain: 'example.ts.net',
        gitTransport: 'https',
      }),
    });
    assert.equal(updateRes.status, 200);

    const afterRes = await fetch(`${server.url}/api/apps/health`);
    const after = await afterRes.json();
    assert.equal(after.byAppId['family-help'].onboarding.setupUrl, 'https://test.example.ts.net/help/setup');
  } finally {
    await server.close();
  }
});

test('homebase config updates are reflected in existing app launch URLs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-config-launch-url-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
  });

  try {
    await fetch(`${server.url}/api/apps/family-plan/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountPath: '/plan/' }),
    });

    const beforeRes = await fetch(`${server.url}/api/state`);
    const before = await beforeRes.json();
    assert.equal(before.installations['family-plan'].externalUrl, 'https://homebase.tailnet/plan/');

    const updateRes = await fetch(`${server.url}/api/homebase/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostname: 'test',
        domain: 'example.ts.net',
        gitTransport: 'https',
      }),
    });
    assert.equal(updateRes.status, 200);

    const afterRes = await fetch(`${server.url}/api/state`);
    assert.match(afterRes.headers.get('cache-control') || '', /no-store/);
    const after = await afterRes.json();
    assert.equal(after.installations['family-plan'].externalUrl, 'https://test.example.ts.net/plan/');
  } finally {
    await server.close();
  }
});

test('homebase config endpoint rejects invalid updates', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-config-invalid-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
  });

  try {
    const badTransport = await fetch(`${server.url}/api/homebase/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gitTransport: 'ftp' }),
    });
    assert.equal(badTransport.status, 400);

    const missingKey = await fetch(`${server.url}/api/homebase/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gitTransport: 'ssh-key' }),
    });
    assert.equal(missingKey.status, 400);

    const injectedKeyPath = await fetch(`${server.url}/api/homebase/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gitTransport: 'ssh-key',
        gitSshKeyPath: '/tmp/key; touch /tmp/homebase-preflight-pwned',
      }),
    });
    assert.equal(injectedKeyPath.status, 400);
    const injectedKeyPayload = await injectedKeyPath.json();
    assert.match(injectedKeyPayload.error, /only letters, numbers/i);

    const unknownField = await fetch(`${server.url}/api/homebase/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceUser: 'root' }),
    });
    assert.equal(unknownField.status, 400);
  } finally {
    await server.close();
  }
});

test('homebase health endpoint returns status ok', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-health-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    gitTransport: 'https',
  });

  try {
    const res = await fetch(`${server.url}/api/homebase/health`);
    const payload = await res.json();
    assert.equal(payload.status, 'ok');
    assert.equal(payload.homebase.runtimeUser, 'homebase');
  } finally {
    await server.close();
  }
});

test('homebase can auto-start bootstrap on service launch when enabled', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-auto-bootstrap-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    homeBaseAutoBootstrap: true,
    homeBaseAutoBootstrapMode: 'dry-run',
    homeBaseAutoBootstrapDelayMs: 1,
  });

  try {
    let status = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const res = await fetch(`${server.url}/api/homebase/bootstrap-status`);
      status = await res.json();
      if (status.latestBootstrapJob) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(status.latestBootstrapJob.kind, 'bootstrap');
    assert.equal(status.latestBootstrapJob.dryRun, true);
  } finally {
    await server.close();
  }
});

test('bootstrap execute dry-run creates a completed job', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-job-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const adminCookie = await setupAdminCookie(server.url);
    const executeRes = await fetch(`${server.url}/api/bootstrap/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    const execute = await executeRes.json();
    assert.equal(execute.ok, true);

    let job = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const jobRes = await fetch(`${server.url}/api/jobs/${execute.jobId}`, { headers: { cookie: adminCookie } });
      job = await jobRes.json();
      if (job.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(job.status, 'completed');
    assert.match(job.log, /\[dry-run\]/);
  } finally {
    await server.close();
  }
});

test('preflight endpoint returns a structured check list', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-preflight-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const preflightRes = await fetch(`${server.url}/api/preflight`);
    const preflight = await preflightRes.json();
    assert.equal(Array.isArray(preflight.checks), true);
    assert.ok(preflight.checks.some((check) => check.id === 'node'));
    assert.ok(preflight.checks.some((check) => check.id === 'os' && check.severity === 'critical'));
    assert.ok(preflight.checks.some((check) => check.id === 'tailscale' && check.severity === 'warning'));
  } finally {
    await server.close();
  }
});

test('app actions endpoint documents currently supported operations', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-actions-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const res = await fetch(`${server.url}/api/apps/family-plan/actions`);
    const payload = await res.json();
    assert.equal(payload.actions.install, true);
    assert.equal(payload.actions.backup, true);
    assert.equal(payload.actions.update, false);
    assert.equal(payload.actions.restart, false);
    assert.equal(payload.actions.uninstall, false);
  } finally {
    await server.close();
  }
});

test('apps update endpoint returns status by app id when persisted', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-update-status-'));
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const store = new SqliteStateStore(dbPath);
  store.init();
  store.upsertInstallation({
    appId: 'family-help',
    name: 'Family Help',
    purpose: 'help desk',
    port: 3002,
    mountPath: '/help/',
    externalUrl: 'https://homebase.tailnet/help/',
    installRoot: '/tmp/does-not-matter',
    serviceName: 'family-help',
    ref: 'main',
    status: 'installed',
    plannedAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
  });
  store.upsertAppUpdateStatus({
    appId: 'family-help',
    trackedRef: 'main',
    status: 'update-available',
    canUpdate: true,
    aheadCount: 0,
    behindCount: 2,
    localHeadSha: 'aaa111',
    remoteHeadSha: 'bbb222',
    lastCheckedAt: new Date().toISOString(),
    lastError: '',
  });

  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: dbPath,
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const res = await fetch(`${server.url}/api/apps/updates`);
    const payload = await res.json();
    assert.equal(payload.byAppId['family-help'].status, 'update-available');
    assert.equal(payload.byAppId['family-help'].canUpdate, true);
    assert.equal(payload.byAppId['family-help'].behindCount, 2);
  } finally {
    await server.close();
  }
});

test('install execute dry-run creates a completed install job', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-install-job-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const adminCookie = await setupAdminCookie(server.url);
    const executeRes = await fetch(`${server.url}/api/apps/family-help/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    const execute = await executeRes.json();
    assert.equal(execute.ok, true);

    let job = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const jobRes = await fetch(`${server.url}/api/jobs/${execute.jobId}`, { headers: { cookie: adminCookie } });
      job = await jobRes.json();
      if (job.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(job.status, 'completed');
    assert.match(job.log, /family-help/i);
  } finally {
    await server.close();
  }
});

test('app actions marks uninstall available after install record exists', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-actions-uninstall-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    await fetch(`${server.url}/api/apps/family-help/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountPath: '/help/' }),
    });

    const res = await fetch(`${server.url}/api/apps/family-help/actions`);
    const payload = await res.json();
    assert.equal(payload.actions.update, false);
    assert.equal(payload.actions.uninstall, false);
    assert.equal(payload.actions.discardPlan, true);
  } finally {
    await server.close();
  }
});

test('app actions keeps restart unavailable for a saved dry-run', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-actions-restart-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    await fetch(`${server.url}/api/apps/family-help/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountPath: '/help/' }),
    });
    const res = await fetch(`${server.url}/api/apps/family-help/actions`);
    const payload = await res.json();
    assert.equal(payload.actions.restart, false);
  } finally {
    await server.close();
  }
});

test('uninstall execute dry-run creates a completed uninstall job', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-uninstall-job-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const adminCookie = await setupAdminCookie(server.url);
    await fetch(`${server.url}/api/apps/family-help/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountPath: '/help/' }),
    });

    const executeRes = await fetch(`${server.url}/api/apps/family-help/uninstall/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true, keepBackups: true }),
    });
    const execute = await executeRes.json();
    assert.equal(execute.ok, true);
    assert.equal(execute.keepBackups, true);

    let job = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const jobRes = await fetch(`${server.url}/api/jobs/${execute.jobId}`, { headers: { cookie: adminCookie } });
      job = await jobRes.json();
      if (job.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(job.status, 'completed');
    assert.match(job.log, /Keeping backup archives under/);
    assert.match(job.log, /family-help/i);
  } finally {
    await server.close();
  }
});

test('restart execute dry-run creates a completed restart job', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-restart-job-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const adminCookie = await setupAdminCookie(server.url);
    await fetch(`${server.url}/api/apps/family-help/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountPath: '/help/' }),
    });
    const executeRes = await fetch(`${server.url}/api/apps/family-help/restart/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    const execute = await executeRes.json();
    assert.equal(execute.ok, true);

    let job = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const jobRes = await fetch(`${server.url}/api/jobs/${execute.jobId}`, { headers: { cookie: adminCookie } });
      job = await jobRes.json();
      if (job.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(job.kind, 'restart');
    assert.equal(job.status, 'completed');
  } finally {
    await server.close();
  }
});

test('install execute rejects invalid git ref', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-install-invalid-ref-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const executeRes = await fetch(`${server.url}/api/apps/family-help/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true, ref: 'main;rm -rf /' }),
    });
    const payload = await executeRes.json();
    assert.equal(executeRes.status, 400);
    assert.match(payload.error, /Invalid git ref/);
  } finally {
    await server.close();
  }
});

test('job detail route serves static page shell', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-job-page-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const executeRes = await fetch(`${server.url}/api/bootstrap/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    const execute = await executeRes.json();

    const pageRes = await fetch(`${server.url}/jobs/${execute.jobId}`);
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.headers.get('content-type') || '', /text\/html/);
  } finally {
    await server.close();
  }
});

test('static assets are served with expected mime types', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-static-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const cssRes = await fetch(`${server.url}/style.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type') || '', /text\/css/);

    const jsRes = await fetch(`${server.url}/nav.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type') || '', /application\/javascript/);
  } finally {
    await server.close();
  }
});

test('backup plan endpoint returns backup commands', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-backup-plan-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const planRes = await fetch(`${server.url}/api/apps/family-help/backup-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const plan = await planRes.json();
    assert.equal(plan.kind, 'backup');
    assert.match(plan.script, /pg_dump/);
  } finally {
    await server.close();
  }
});

test('backup list and restore plan endpoints work with discovered backups', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-restore-plan-'));
  const backupRoot = path.join(tempDir, 'backups');
  const archiveDir = path.join(backupRoot, 'family-help', '20260403T000000Z');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'backup-generated-at.txt'), '2026-04-03T00:00:00.000Z\n');
  fs.writeFileSync(path.join(archiveDir, '.env.backup'), 'DATABASE_URL=postgresql://x:y@localhost/db\n');
  fs.writeFileSync(path.join(archiveDir, 'database.dump'), 'placeholder');

  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: backupRoot,
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const listRes = await fetch(`${server.url}/api/apps/family-help/backups`);
    const backups = await listRes.json();
    assert.equal(backups.backups.length, 1);

    const restorePlanRes = await fetch(`${server.url}/api/apps/family-help/restore-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backupDir: archiveDir }),
    });
    const restorePlan = await restorePlanRes.json();
    assert.equal(restorePlan.kind, 'restore');
    assert.match(restorePlan.script, /pg_restore/);
  } finally {
    await server.close();
  }
});

test('restore execute dry-run creates a completed restore job', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-restore-job-'));
  const backupRoot = path.join(tempDir, 'backups');
  const archiveDir = path.join(backupRoot, 'family-help', '20260403T000000Z');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'backup-generated-at.txt'), '2026-04-03T00:00:00.000Z\n');
  fs.writeFileSync(path.join(archiveDir, '.env.backup'), 'DATABASE_URL=postgresql://x:y@localhost/db\n');
  fs.writeFileSync(path.join(archiveDir, 'database.dump'), 'placeholder');

  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: backupRoot,
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const adminCookie = await setupAdminCookie(server.url);
    const executeRes = await fetch(`${server.url}/api/apps/family-help/restore/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true, backupDir: archiveDir }),
    });
    const execute = await executeRes.json();
    assert.equal(execute.ok, true);

    let job = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const jobRes = await fetch(`${server.url}/api/jobs/${execute.jobId}`, { headers: { cookie: adminCookie } });
      job = await jobRes.json();
      if (job.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(job.status, 'completed');
    assert.match(job.log, /Restore Family Help/i);
  } finally {
    await server.close();
  }
});

test('network tailscale endpoint returns structured readiness payload', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-network-ts-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  });

  try {
    const res = await fetch(`${server.url}/api/network/tailscale`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(typeof payload.generatedAt, 'string');
    assert.equal(typeof payload.installed?.ok, 'boolean');
    assert.equal(typeof payload.readiness?.state, 'string');
    assert.equal(['not-installed', 'not-authenticated', 'authenticated-unpublished', 'published'].includes(payload.readiness.state), true);
  } finally {
    await server.close();
  }
});

function makeFakeTailscaleRunner({ statusSnapshot, serveStdout, serveExitCode = 0, serveStderr = '' } = {}) {
  return (command) => {
    if (command === 'command -v tailscale') {
      return { command, ok: true, exitCode: 0, stdout: '/usr/bin/tailscale\n', stderr: '' };
    }
    if (command === 'tailscale version') {
      return { command, ok: true, exitCode: 0, stdout: '1.96.4\n', stderr: '' };
    }
    if (command === 'tailscale status --json') {
      return { command, ok: true, exitCode: 0, stdout: JSON.stringify(statusSnapshot || {
        BackendState: 'Running',
        Self: { HostName: 'host-apps-1', DNSName: 'host-apps-1.example.ts.net.' },
        CurrentTailnet: { Name: 'example.tailnet' },
        MagicDNSSuffix: 'example.ts.net',
      }), stderr: '' };
    }
    if (command === 'tailscale serve get-config --all') {
      return { command, ok: serveExitCode === 0, exitCode: serveExitCode, stdout: serveStdout || '{"version":"0.0.1"}', stderr: serveStderr };
    }
    return { command, ok: false, exitCode: 127, stdout: '', stderr: 'unsupported command' };
  };
}

test('network tailscale publish plan endpoint returns executable plan when no conflicts exist', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-network-plan-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    tailscaleRunCommand: makeFakeTailscaleRunner({
      serveStdout: JSON.stringify({
        version: '0.0.1',
        services: {
          'svc:home': {
            endpoints: {
              'tcp:3080': 'http://127.0.0.1:3080',
              'tcp:443': 'https+insecure://localhost:443',
            },
          },
        },
      }),
    }),
  });

  try {
    const res = await fetch(`${server.url}/api/network/tailscale/publish-plan`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.canExecute, true);
    assert.equal(payload.conflicts.length, 0);
    assert.equal(payload.policy.managedServiceId, 'svc:home');
  } finally {
    await server.close();
  }
});

test('network tailscale publish execute dry-run enqueues tailscale-publish job', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-network-exec-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    tailscaleRunCommand: makeFakeTailscaleRunner({
      serveStdout: JSON.stringify({ version: '0.0.1', services: {} }),
    }),
  });

  try {
    const adminCookie = await setupAdminCookie(server.url);
    const executeRes = await fetch(`${server.url}/api/network/tailscale/publish-execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(executeRes.status, 202);
    const execute = await executeRes.json();
    assert.equal(execute.ok, true);

    const jobRes = await fetch(`${server.url}/api/jobs/${execute.jobId}`, { headers: { cookie: adminCookie } });
    assert.equal(jobRes.status, 200);
    const job = await jobRes.json();
    assert.equal(job.kind, 'tailscale-publish');
    assert.equal(job.dryRun, true);
  } finally {
    await server.close();
  }
});

test('network tailscale publish execute refuses non-home endpoint ownership conflicts', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-network-conflict-'));
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: path.join(tempDir, 'state.sqlite3'),
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
    tailscaleRunCommand: makeFakeTailscaleRunner({
      serveStdout: JSON.stringify({
        version: '0.0.1',
        services: {
          'svc:bitcoin': {
            endpoints: {
              'tcp:443': 'https+insecure://localhost:443',
            },
          },
        },
      }),
    }),
  });

  try {
    const executeRes = await fetch(`${server.url}/api/network/tailscale/publish-execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(executeRes.status, 409);
    const payload = await executeRes.json();
    assert.equal(payload.canExecute, false);
    assert.equal(payload.blockedReason, 'endpoint-ownership-conflict');
    assert.equal(Array.isArray(payload.conflicts), true);
    assert.equal(payload.conflicts.length >= 1, true);
  } finally {
    await server.close();
  }
});

test('network tailscale verify endpoint reports stale config when hostname/domain changed after real publish', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-network-verify-stale-'));
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const server = await startServer({
    appName: 'Home Base',
    stateDbPath: dbPath,
    port: 0,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    defaultHostname: 'homebase-new',
    defaultDomain: 'tailnet',
    tailscaleRunCommand: makeFakeTailscaleRunner({
      serveStdout: JSON.stringify({
        version: '0.0.1',
        services: {
          'svc:home': {
            endpoints: {
              'tcp:3080': 'http://127.0.0.1:3080',
              'tcp:443': 'https+insecure://localhost:443',
            },
          },
        },
      }),
    }),
  });

  try {
    const store = new SqliteStateStore(dbPath);
    const createdAt = new Date().toISOString();
    const { id } = store.createJob({
      kind: 'tailscale-publish',
      target: 'svc:home',
      status: 'completed',
      dryRun: false,
      createdAt,
      currentStep: null,
      planJson: JSON.stringify({}),
    });
    store.updateJob(id, {
      startedAt: createdAt,
      finishedAt: createdAt,
      resultJson: JSON.stringify({
        desiredHost: 'homebase-old',
        desiredDomain: 'tailnet',
        homebaseUrl: 'https://homebase-old.tailnet:3080',
        appsBaseUrl: 'https://homebase-old.tailnet',
      }),
    });

    const res = await fetch(`${server.url}/api/network/tailscale/verify`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.staleBecauseConfigChanged, true);
    assert.equal(payload.repairRequired, true);
    assert.match(payload.staleReason, /homebase-new\.tailnet/i);
    assert.match(payload.staleReason, /homebase-old\.tailnet/i);
    assert.equal(typeof payload.recommendedUrls?.homebase, 'string');
    assert.equal(typeof payload.recommendedUrls?.appsBase, 'string');
  } finally {
    await server.close();
  }
});

test('executor-mode Dinner execution fails at the socket boundary without legacy sudo fallback', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-executor-route-'));
  const server = await startServer({ appName: 'Home Base', stateDbPath: path.join(tempDir, 'state.sqlite3'), port: 0, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', baseBackupDir: '/var/lib/sovereign-home/backups', baseConfigDir: '/etc/sovereign-home', defaultHostname: 'homebase', defaultDomain: 'tailnet', homeBaseExecutionMode: 'executor', homeBaseEnablePrivilegedJobs: true, homeBaseExecutorSocket: path.join(tempDir, 'missing.sock') });
  try {
    const cookie = await setupAdminCookie(server.url);
    const response = await fetch(`${server.url}/api/apps/family-dinner/execute`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE' }) });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.code, 'EXECUTOR_UNAVAILABLE');
  } finally { await server.close(); }
});

test('executor-mode Dinner over SSH is refused up front when the executor has no deploy key', async () => {
  const { createExecutorServer } = require('../executor/server');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ssh-'));
  const socketPath = path.join(tempDir, 'e.sock');
  let executed = false;
  const executor = createExecutorServer({ logger: { info() {} }, mutationsEnabled: true, probeDeployKey: () => 'missing', runAction: async () => { executed = true; return {}; } });
  await new Promise((resolve) => executor.listen(socketPath, resolve));
  const server = await startServer({ appName: 'Home Base', stateDbPath: path.join(tempDir, 'state.sqlite3'), port: 0, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', baseBackupDir: '/var/lib/sovereign-home/backups', baseConfigDir: '/etc/sovereign-home', defaultHostname: 'homebase', defaultDomain: 'tailnet', homeBaseExecutionMode: 'executor', homeBaseEnablePrivilegedJobs: true, homeBaseExecutorSocket: socketPath, gitTransport: 'ssh-key', gitSshKeyPath: '/etc/sovereign-home/git/deploy_key' });
  try {
    const cookie = await setupAdminCookie(server.url);
    const response = await fetch(`${server.url}/api/apps/family-dinner/execute`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE' }) });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.code, 'GIT_DEPLOY_KEY_REQUIRED');
    assert.match(payload.error, /install\.sh --repair --git-ssh-key/);
    assert.equal(executed, false);
  } finally {
    await server.close();
    await new Promise((resolve) => executor.close(resolve));
  }
});

test('executor mode routes lifecycle actions to the executor and still refuses unconverted legacy routes', async () => {
  const { createExecutorServer } = require('../executor/server');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-lifecycle-'));
  const socketPath = path.join(tempDir, 'e.sock');
  const received = [];
  const executor = createExecutorServer({ logger: { info() {} }, mutationsEnabled: true, runAction: async (spec) => { received.push(spec); return { completedOperationIds: [] }; } });
  await new Promise((resolve) => executor.listen(socketPath, resolve));
  const backupRoot = path.join(tempDir, 'backups');
  fs.mkdirSync(path.join(backupRoot, 'home-source', '20260924T101010Z'), { recursive: true });
  fs.writeFileSync(path.join(backupRoot, 'home-source', '20260924T101010Z', 'backup-generated-at.txt'), '2026-09-24T10:10:10.000Z\n');
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const store = new SqliteStateStore(dbPath);
  store.init();
  const record = (appId, port) => ({ appId, name: appId, purpose: 'x', port, mountPath: '/x/', externalUrl: 'https://homebase.tailnet/x/', installRoot: '/tmp/x', serviceName: appId, ref: 'main', status: 'installed', plannedAt: '2026-04-03T00:00:00.000Z', updatedAt: '2026-04-03T00:00:00.000Z' });
  store.upsertInstallation(record('home-source', 3008));
  store.upsertInstallation(record('family-help', 3002));
  const server = await startServer({ appName: 'Home Base', stateDbPath: dbPath, port: 0, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', baseBackupDir: backupRoot, baseConfigDir: '/etc/sovereign-home', defaultHostname: 'homebase', defaultDomain: 'tailnet', homeBaseExecutionMode: 'executor', homeBaseEnablePrivilegedJobs: true, homeBaseExecutorSocket: socketPath });
  try {
    const cookie = await setupAdminCookie(server.url);
    const post = async (route, extra = {}) => {
      const response = await fetch(`${server.url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE', ...extra }) });
      return { status: response.status, body: await response.json() };
    };
    for (const route of ['/api/homebase/install-self', '/api/network/tailscale/publish-execute']) {
      const response = await post(route);
      assert.equal(response.status, 409, route);
      assert.equal(response.body.code, 'TYPED_EXECUTION_NOT_SUPPORTED', route);
    }
    for (const action of ['restart', 'backup', 'uninstall']) {
      const response = await post(`/api/apps/family-help/${action}/execute`);
      assert.equal(response.body.code, 'TYPED_EXECUTION_NOT_SUPPORTED', `family-help ${action}: ${JSON.stringify(response.body)}`);
    }
    for (const [action, extra] of [['restart'], ['backup'], ['restore', { backupDir: '20260924T101010Z' }], ['uninstall', { keepBackups: false }]]) {
      const response = await post(`/api/apps/home-source/${action}/execute`, extra);
      assert.equal(response.status, 202, `${action}: ${JSON.stringify(response.body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(received, [
      { action: 'restart', appId: 'home-source' },
      { action: 'backup', appId: 'home-source' },
      { action: 'restore', appId: 'home-source', backupId: '20260924T101010Z' },
      { action: 'uninstall', appId: 'home-source', keepBackups: false },
    ]);
    const missing = await post('/api/apps/home-source/restore/execute', { backupDir: '/etc/shadow' });
    assert.equal(missing.body.code, 'BACKUP_NOT_FOUND');
  } finally {
    await server.close();
    await new Promise((resolve) => executor.close(resolve));
  }
});

test('executor-mode reinstall keeps the catalog port; only a different app on that port is a conflict', async () => {
  const { createExecutorServer } = require('../executor/server');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-port-'));
  const socketPath = path.join(tempDir, 'e.sock');
  const started = [];
  const executor = createExecutorServer({ logger: { info() {} }, mutationsEnabled: true, runAction: async (spec) => { started.push(spec.appId); return { completedOperationIds: [] }; } });
  await new Promise((resolve) => executor.listen(socketPath, resolve));
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const store = new SqliteStateStore(dbPath);
  store.init();
  const record = (appId, port) => ({ appId, name: appId, purpose: 'x', port, mountPath: '/x/', externalUrl: 'https://homebase.tailnet/x/', installRoot: '/tmp/x', serviceName: appId, ref: 'main', status: 'installed', plannedAt: '2026-04-03T00:00:00.000Z', updatedAt: '2026-04-03T00:00:00.000Z' });
  store.upsertInstallation(record('home-source', 3008));
  store.upsertInstallation(record('family-plan', 3000));
  const server = await startServer({ appName: 'Home Base', stateDbPath: dbPath, port: 0, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', baseBackupDir: '/var/lib/sovereign-home/backups', baseConfigDir: '/etc/sovereign-home', defaultHostname: 'homebase', defaultDomain: 'tailnet', homeBaseExecutionMode: 'executor', homeBaseEnablePrivilegedJobs: true, homeBaseExecutorSocket: socketPath });
  try {
    const cookie = await setupAdminCookie(server.url);
    const execute = (appId) => fetch(`${server.url}/api/apps/${appId}/execute`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE' }) });
    const reinstall = await execute('home-source');
    assert.equal(reinstall.status, 202, JSON.stringify(await reinstall.clone().json()));
    const conflict = await execute('family-dinner');
    const payload = await conflict.json();
    assert.equal(conflict.status, 409);
    assert.equal(payload.code, 'PORT_CONFLICT');
    assert.match(payload.error, /family-plan/);
  } finally {
    await server.close();
    await new Promise((resolve) => executor.close(resolve));
  }
});

test('review fixes: update-self and discarding a real install are refused', async () => {
  const { createExecutorServer } = require('../executor/server');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-review-'));
  const socketPath = path.join(tempDir, 'e.sock');
  const executor = createExecutorServer({ logger: { info() {} }, mutationsEnabled: true, runAction: async () => ({ completedOperationIds: [] }) });
  await new Promise((resolve) => executor.listen(socketPath, resolve));
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const store = new SqliteStateStore(dbPath);
  store.init();
  const installRoot = path.join(tempDir, 'present');
  fs.mkdirSync(installRoot);
  store.upsertInstallation({ appId: 'family-plan', name: 'Family Plan', purpose: 'x', port: 3004, mountPath: '/plan/', externalUrl: 'https://homebase.tailnet/plan/', installRoot, serviceName: 'family-plan', ref: 'main', status: 'planned', plannedAt: '2026-04-03T00:00:00.000Z', updatedAt: '2026-04-03T00:00:00.000Z' });
  const server = await startServer({ appName: 'Home Base', stateDbPath: dbPath, port: 0, serviceUser: 'sovereign', baseInstallDir: '/srv/elsewhere', baseBackupDir: path.join(tempDir, 'b'), baseConfigDir: '/etc/sovereign-home', defaultHostname: 'homebase', defaultDomain: 'tailnet', homeBaseExecutionMode: 'executor', homeBaseEnablePrivilegedJobs: true, homeBaseExecutorSocket: socketPath });
  try {
    const cookie = await setupAdminCookie(server.url);
    const post = async (route, body) => {
      const response = await fetch(`${server.url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const updateSelf = await post('/api/homebase/update-self', { dryRun: false, confirm: 'EXECUTE' });
    assert.equal(updateSelf.body.code, 'TYPED_EXECUTION_NOT_SUPPORTED');
    const discard = await post('/api/apps/family-plan/discard-plan', { confirm: 'DISCARD' });
    assert.equal(discard.status, 409);
    assert.equal(discard.body.code, 'INSTALL_PRESENT');
  } finally {
    await server.close();
    await new Promise((resolve) => executor.close(resolve));
  }
});

test('an upgraded host with privileged jobs but no execution mode gets the exact opt-in line', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-upgrade-hint-'));
  const server = await startServer({ appName: 'Home Base', stateDbPath: path.join(tempDir, 'state.sqlite3'), port: 0, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', baseBackupDir: '/var/lib/sovereign-home/backups', baseConfigDir: '/etc/sovereign-home', defaultHostname: 'homebase', defaultDomain: 'tailnet', homeBaseExecutionMode: 'plan-only', homeBaseEnablePrivilegedJobs: false, homeBaseExecutionModeMissing: true });
  try {
    const cookie = await setupAdminCookie(server.url);
    const response = await fetch(`${server.url}/api/apps/family-dinner/execute`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ dryRun: false, confirm: 'EXECUTE' }) });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.code, 'PRIVILEGED_EXECUTION_DISABLED');
    assert.match(payload.error, /add HOME_BASE_EXECUTION_MODE=legacy-sudo/);
  } finally { await server.close(); }
});

test('executor-mode restore resolves the selected archive by name without reading backup directories; dry-runs preview the executor plan', async () => {
  const { createExecutorServer } = require('../executor/server');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-restore-name-'));
  const socketPath = path.join(tempDir, 'e.sock');
  const received = [];
  const executor = createExecutorServer({ logger: { info() {} }, mutationsEnabled: true, runAction: async (spec) => { received.push(spec); return { completedOperationIds: [] }; } });
  await new Promise((resolve) => executor.listen(socketPath, resolve));
  const dbPath = path.join(tempDir, 'state.sqlite3');
  const store = new SqliteStateStore(dbPath);
  store.init();
  store.upsertInstallation({ appId: 'home-source', name: 'Home Source', purpose: 'x', port: 3008, mountPath: '/source/', externalUrl: 'https://homebase.tailnet/source/', installRoot: '/opt/sovereign-home/apps/homeSource', serviceName: 'home-source', ref: 'main', status: 'installed', plannedAt: '2026-04-03T00:00:00.000Z', updatedAt: '2026-04-03T00:00:00.000Z' });
  // Only a database record exists: the archive directory is not readable by (or even present for) the web process.
  const archiveDir = '/var/lib/sovereign-home/backups/home-source/20260924T101010123Z';
  store.recordBackup({ appId: 'home-source', archiveDir, generatedAt: '2026-09-24T10:10:10.123Z', dryRun: false, status: 'completed', includedFiles: [], jobId: null, createdAt: '2026-09-24T10:10:11.000Z' });
  const server = await startServer({ appName: 'Home Base', stateDbPath: dbPath, port: 0, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', baseBackupDir: path.join(tempDir, 'unreadable'), baseConfigDir: '/etc/sovereign-home', defaultHostname: 'homebase', defaultDomain: 'tailnet', homeBaseExecutionMode: 'executor', homeBaseEnablePrivilegedJobs: true, homeBaseExecutorSocket: socketPath });
  try {
    const cookie = await setupAdminCookie(server.url);
    const post = async (body) => {
      const response = await fetch(`${server.url}/api/apps/home-source/restore/execute`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const real = await post({ backupDir: archiveDir, dryRun: false, confirm: 'EXECUTE' });
    assert.equal(real.status, 202, JSON.stringify(real.body));
    const latest = await post({ dryRun: false, confirm: 'EXECUTE' });
    assert.equal(latest.status, 202, 'no selection restores the latest recorded backup');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(received.map((spec) => spec.backupId), ['20260924T101010123Z', '20260924T101010123Z']);
    for (const bad of ['/var/lib/sovereign-home/backups/family-dinner/20260924T101010123Z', '/etc/20260924T101010123Z', '../20260924T101010123Z/x']) {
      const refused = await post({ backupDir: bad, dryRun: false, confirm: 'EXECUTE' });
      assert.equal(refused.body.code, 'BACKUP_NOT_FOUND', bad);
    }
    const preview = await post({ backupDir: archiveDir, dryRun: true });
    assert.equal(preview.status, 202, JSON.stringify(preview.body));
    let job;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      job = await (await fetch(`${server.url}/api/jobs/${preview.body.jobId}`, { headers: { cookie } })).json();
      if (job.status === 'completed' || job.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(job.status, 'completed', job.errorText);
    const plan = JSON.parse(job.planJson);
    assert.equal(plan.preview, true);
    assert.equal(plan.operationPlan.policyProfile, 'app-restore-v1');
    assert.ok(plan.operationPlan.operations.some((operation) => operation.type === 'backup.restore' && operation.archiveName === '20260924T101010123Z'));
    assert.equal(received.length, 2, 'a dry-run never runs anything');
  } finally {
    await server.close();
    await new Promise((resolve) => executor.close(resolve));
  }
});
