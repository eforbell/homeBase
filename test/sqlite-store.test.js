const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SqliteStateStore } = require('../src/state/sqlite-store');

test('sqlite state store persists installations and jobs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-base-sqlite-'));
  const store = new SqliteStateStore(path.join(tempDir, 'state.sqlite3'));
  store.init();

  store.addBootstrapPlan({
    generatedAt: '2026-04-03T00:00:00.000Z',
    serviceUser: 'sovereign',
  });

  store.upsertInstallation({
    appId: 'family-help',
    name: 'Family Help',
    purpose: 'help desk',
    port: 3002,
    mountPath: '/help/',
    externalUrl: 'https://homebase.tailnet/help/',
    installRoot: '/opt/sovereign-home/apps/familyHelp',
    serviceName: 'family-help',
    ref: 'main',
    status: 'planned',
    plannedAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
  });

  const { id } = store.createJob({
    kind: 'bootstrap',
    target: 'local-host',
    status: 'queued',
    dryRun: true,
    createdAt: '2026-04-03T00:00:00.000Z',
    currentStep: 'verify-os',
    planJson: '{}',
  });
  store.appendJobLog(id, 'hello\n');
  store.updateJob(id, {
    status: 'completed',
    finishedAt: '2026-04-03T00:01:00.000Z',
    resultJson: '{"ok":true}',
  });

  const state = store.loadState();
  assert.equal(state.bootstrapPlans.length, 1);
  assert.equal(state.installations['family-help'].serviceName, 'family-help');
  assert.equal(state.jobs[0].status, 'completed');

  const job = store.getJob(id);
  assert.match(job.log, /hello/);
});
