const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readPublicScript(fileName) {
  return fs.readFileSync(path.join(__dirname, '..', 'public', fileName), 'utf8');
}

test('settings UI exposes a guarded bootstrap rerun action', () => {
  const source = readPublicScript('settings.js');

  assert.match(source, /data-action="bootstrap-host"/);
  assert.match(source, /\/api\/bootstrap\/execute/);
  assert.match(source, /Type EXECUTE to re-run host bootstrap for real/);
});

test('failed jobs expose rerun actions for supported job types on job detail', () => {
  const jobDetail = readPublicScript('job-detail.js');

  assert.match(jobDetail, /data-action="rerun-job"/);
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
  assert.match(apps, /Last backup:/);
  assert.match(apps, /No backups yet/);
  assert.match(apps, /Local-only backup path/);
  assert.match(apps, /scheduleRefresh/);
  assert.match(apps, /visibilitychange/);
});

test('dashboard surfaces local-only backup posture warning', () => {
  const dashboard = readPublicScript('dashboard.js');

  assert.match(dashboard, /Backup posture/);
  assert.match(dashboard, /Backups are currently local-only/);
});
