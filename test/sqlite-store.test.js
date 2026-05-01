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
  assert.equal(store.getLatestJobByKind('bootstrap').id, id);
  assert.equal(store.getLatestJobByKind('install'), null);

  store.recordBackup({
    appId: 'family-help',
    archiveDir: '/var/lib/sovereign-home/backups/family-help/20260410T000000Z',
    generatedAt: '2026-04-10T00:00:00.000Z',
    dryRun: false,
    status: 'completed',
    includedFiles: ['.env.backup', 'database.dump'],
    jobId: id,
    createdAt: '2026-04-10T00:00:00.000Z',
  });

  const backups = store.listBackups('family-help');
  assert.equal(backups.length, 1);
  assert.equal(backups[0].includedFiles[0], '.env.backup');

  store.upsertAppUpdateStatus({
    appId: 'family-help',
    trackedRef: 'main',
    status: 'update-available',
    canUpdate: true,
    aheadCount: 0,
    behindCount: 3,
    localHeadSha: 'abc123',
    remoteHeadSha: 'def456',
    lastCheckedAt: '2026-04-12T00:00:00.000Z',
    lastError: '',
  });
  const updateStatuses = store.listAppUpdateStatuses();
  assert.equal(updateStatuses.length, 1);
  assert.equal(updateStatuses[0].appId, 'family-help');
  assert.equal(updateStatuses[0].canUpdate, true);

  const withUpdateStatus = store.loadState();
  assert.equal(withUpdateStatus.installations['family-help'].updateStatus.status, 'update-available');
  assert.equal(withUpdateStatus.installations['family-help'].updateStatus.behindCount, 3);

  store.deleteBackups('family-help');
  store.deleteInstallation('family-help');

  const afterDelete = store.loadState();
  assert.equal(afterDelete.installations['family-help'], undefined);
  assert.equal(store.listBackups('family-help').length, 0);
  assert.equal(store.listAppUpdateStatuses().length, 0);
});
