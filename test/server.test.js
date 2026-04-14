const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

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
    assert.equal(catalog.apps.length, 6);

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

test('home page exposes setup links for onboarding-aware installed apps', async () => {
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
    const html = await res.text();
    assert.match(html, /Set up household/);
    assert.match(html, /https:\/\/homebase\.tailnet\/help\/setup/);
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

test('job detail page renders successfully', async () => {
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
    const html = await pageRes.text();
    assert.match(html, /Job #/);
    assert.match(html, /Back to Home Base/);
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
