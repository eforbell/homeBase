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
    assert.equal(catalog.apps.length, 5);

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
