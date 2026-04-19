const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readPublicScript(fileName) {
  return fs.readFileSync(path.join(__dirname, '..', 'public', fileName), 'utf8');
}

test('settings UI exposes bootstrap and update-self actions without window.prompt', () => {
  const source = readPublicScript('settings.js');

  assert.match(source, /data-action="bootstrap-host"/);
  assert.match(source, /data-action="test-alerts"/);
  assert.match(source, /\/api\/alerts\/test/);
  assert.match(source, /\/api\/bootstrap\/execute/);
  assert.doesNotMatch(source, /window\.prompt/);
  assert.match(source, /payload\.confirm = 'EXECUTE'/);
});

test('failed jobs expose rerun actions for supported job types on job detail', () => {
  const jobDetail = readPublicScript('job-detail.js');

  assert.match(jobDetail, /data-action="rerun-job"/);
  assert.match(jobDetail, /data-job-id/);
  assert.match(jobDetail, /window\.HB\.getJson\(`\/api\/jobs\/\$\{encodeURIComponent\(currentJobId\)\}`\)/);
  assert.doesNotMatch(jobDetail, /__job/);
  assert.match(jobDetail, /body\.dryRun === false/);
  assert.doesNotMatch(jobDetail, /window\.prompt/);
  assert.match(jobDetail, /window\.HB\.confirmInline/);
  assert.match(jobDetail, /Re-run bootstrap/);
  assert.match(jobDetail, /Re-run install/);
  assert.match(jobDetail, /Re-run backup/);
  assert.match(jobDetail, /Re-run restore/);
  assert.match(jobDetail, /This failed job type does not support one-click rerun yet/);
});

test('installed app cards expose operations and backup posture', () => {
  const apps = readPublicScript('apps.js');

  assert.match(apps, /Details/);
  assert.match(apps, /Backup…/);
  assert.match(apps, /Restore…/);
  assert.match(apps, /\/api\/apps\/health/);
  assert.match(apps, /runtimeStatusPill/);
  assert.match(apps, /window\.HB\.backupSummary/);
  assert.match(apps, /window\.HB\.localOnlyBackupNote/);
  assert.match(apps, /View health details/);
  assert.match(apps, /Setup ↗/);
  assert.match(apps, /scheduleRefresh/);
  assert.match(apps, /visibilitychange/);
});

test('dashboard surfaces local-only backup posture warning', () => {
  const dashboard = readPublicScript('dashboard.js');

  assert.match(dashboard, /Backup posture/);
  assert.match(dashboard, /Backups are currently local-only/);
  assert.match(dashboard, /Health warnings/);
  assert.match(dashboard, /renderAppHealthWarnings/);
  assert.match(dashboard, /renderHostWarnings/);
  assert.match(dashboard, /needs-setup/);
  assert.match(dashboard, /\/api\/apps\/health/);
  assert.match(dashboard, /Inspect app health/);
});

test('shared API exposes backup summary helpers', () => {
  const api = readPublicScript('api.js');

  assert.match(api, /function latestBackup\(backups\)/);
  assert.match(api, /function backupSummary\(backups\)/);
  assert.match(api, /function localOnlyBackupNote\(config\)/);
  assert.match(api, /function runtimeStatusMeta\(status\)/);
  assert.match(api, /function runtimeStatusPill\(status\)/);
  assert.match(api, /Needs setup/);
  assert.match(api, /No backups yet/);
  assert.match(api, /latestBackup,/);
  assert.match(api, /backupSummary,/);
  assert.match(api, /localOnlyBackupNote,/);
  assert.match(api, /runtimeStatusMeta,/);
  assert.match(api, /runtimeStatusPill,/);
});
