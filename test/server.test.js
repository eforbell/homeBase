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
    const res = await fetch(`${server.url}/api/homebase/install-self`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true, port: 3180 }),
    });
    const payload = await res.json();
    assert.equal(payload.ok, true);
    const jobRes = await fetch(`${server.url}/api/jobs/${payload.jobId}`);
    const job = await jobRes.json();
    assert.equal(job.kind, 'homebase-runtime');
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
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.paths.stateDbExists, 'boolean');
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
    assert.equal(updated.hostnameIsPlaceholder, false);

    const afterRes = await fetch(`${server.url}/api/homebase/config`);
    const after = await afterRes.json();
    assert.equal(after.hostname, 'erebor');
    assert.equal(after.gitTransport, 'ssh-key');
    assert.equal(after.healthAlertsEnabled, true);
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
    const executeRes = await fetch(`${server.url}/api/bootstrap/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    const execute = await executeRes.json();
    assert.equal(execute.ok, true);

    let job = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const jobRes = await fetch(`${server.url}/api/jobs/${execute.jobId}`);
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
    const executeRes = await fetch(`${server.url}/api/apps/family-help/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    const execute = await executeRes.json();
    assert.equal(execute.ok, true);

    let job = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const jobRes = await fetch(`${server.url}/api/jobs/${execute.jobId}`);
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
    assert.equal(payload.actions.uninstall, true);
  } finally {
    await server.close();
  }
});

test('app actions marks restart available after install record exists', async () => {
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
    assert.equal(payload.actions.restart, true);
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
      const jobRes = await fetch(`${server.url}/api/jobs/${execute.jobId}`);
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
      const jobRes = await fetch(`${server.url}/api/jobs/${execute.jobId}`);
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
    const executeRes = await fetch(`${server.url}/api/apps/family-help/restore/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true, backupDir: archiveDir }),
    });
    const execute = await executeRes.json();
    assert.equal(execute.ok, true);

    let job = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const jobRes = await fetch(`${server.url}/api/jobs/${execute.jobId}`);
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
