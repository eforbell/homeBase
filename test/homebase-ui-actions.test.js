const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readPublicScript(fileName) {
  return readPublicFile(fileName);
}

function readPublicFile(fileName) {
  return fs.readFileSync(path.join(__dirname, '..', 'public', fileName), 'utf8');
}

test('control-plane UI keeps operational actions available after the settings split', () => {
  const source = readPublicScript('settings.js');
  const nav = readPublicScript('nav.js');

  assert.match(source, /data-action="bootstrap-host"/);
  assert.match(source, /data-action="test-alerts"/);
  assert.match(source, /\/api\/alerts\/test/);
  assert.match(source, /\/api\/admin\/status/);
  assert.match(source, /\/api\/admin\/setup/);
  assert.match(source, /\/api\/admin\/unlock/);
  assert.match(source, /\/api\/admin\/lock/);
  assert.match(source, /\/api\/admin\/rotate/);
  assert.match(source, /\/api\/admin\/audit/);
  assert.match(source, /Rotate admin passphrase/);
  assert.match(source, /Recent destructive action audit/);
  assert.match(source, /Admin execution lock/);
  assert.match(source, /Home Base configuration/);
  assert.match(source, /Current Serve summary/);
  assert.match(source, /Tailscale readiness/);
  assert.match(source, /Managed publish plan/);
  assert.match(source, /Verification & repair/);
  assert.match(source, /Repair recommended/);
  assert.match(source, /\/api\/network\/tailscale/);
  assert.match(source, /\/api\/network\/tailscale\/publish-plan/);
  assert.match(source, /\/api\/network\/tailscale\/publish-execute/);
  assert.match(source, /\/api\/network\/tailscale\/verify/);
  assert.match(source, /readiness\.label/);
  assert.match(source, /\/api\/bootstrap\/execute/);
  assert.match(source, /Update Home Base/);
  assert.match(source, /Run Home Base update/);
  assert.match(source, /class="hb-table-wrap"/);
  assert.match(source, /waitForJobCompletion/);
  assert.match(source, /form\?\.dataset\.submitting/);
  assert.match(source, /button\.disabled = true/);
  assert.match(source, /This page will refresh when it finishes/);
  assert.doesNotMatch(source, /window\.prompt/);
  assert.match(source, /payload\.confirm = 'EXECUTE'/);

  assert.match(nav, /\/status/);
  assert.match(nav, /\/network/);
  assert.match(nav, /\/admin/);
  assert.match(nav, /\/config/);
  assert.match(nav, /hb-more-sheet/);
  assert.match(nav, /hb-more-nav-btn/);
  assert.match(nav, /Base/);
});

test('control-plane responsive styles contain table overflow, mobile-safe grids, and more-sheet support', () => {
  const style = readPublicFile('style.css');

  assert.match(style, /\.hb-table-wrap \{/);
  assert.match(style, /overflow-x: auto/);
  assert.match(style, /-webkit-overflow-scrolling: touch/);
  assert.match(style, /\.hb-card \{[\s\S]*min-width: 0;/);
  assert.match(style, /\.hb-stack > \*, \.hb-grid > \*, \.hb-form-grid > \*, \.hb-label \{ min-width: 0; \}/);
  assert.match(style, /\.hb-input, \.hb-select \{[\s\S]*width: 100%;/);
  assert.match(style, /\.hb-more-sheet \{/);
  assert.match(style, /\.hb-nav-link--more/);
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

  assert.match(apps, /title="View details"/);
  assert.match(apps, /title="Backup"/);
  assert.match(apps, /title="Restore"/);
  assert.match(apps, /title="Uninstall"/);
  assert.match(apps, /#uninstall/);
  assert.match(apps, /Git ref/);
  assert.match(apps, /\/api\/apps\/health/);
  assert.match(apps, /\/api\/apps\/updates/);
  assert.match(apps, /runtimeStatusPill/);
  assert.match(apps, /Update: available/);
  assert.match(apps, /Update: up to date/);
  assert.match(apps, /helper-failing/);
  assert.match(apps, /window\.HB\.backupSummary/);
  assert.match(apps, /window\.HB\.localOnlyBackupNote/);
  assert.match(apps, /Inspect →/);
  assert.match(apps, /Setup ↗/);
  assert.match(apps, /payload\.ref = ref/);
  assert.match(apps, /activeJobs/);
  assert.match(apps, /activeInstallJobsByTarget/);
  assert.match(apps, /byTarget\.has\(job\.target\)/);
  assert.match(apps, /Installing now/);
  assert.match(apps, /View install job/);
  assert.match(apps, /!installingByAppId\.has\(app\.id\)/);
  assert.match(apps, /data-available-install/);
  assert.match(apps, /availableWasOpen/);
  assert.match(apps, /shouldOpenAvailable/);
  assert.match(apps, /isInstallFormInteractionActive/);
  assert.match(apps, /form\[data-action="install"\]/);
  assert.match(apps, /waitForJobCompletion/);
  assert.match(apps, /form\.dataset\.submitting/);
  assert.match(apps, /This page will refresh when it finishes/);
  assert.match(apps, /scheduleRefresh/);
  assert.match(apps, /visibilitychange/);
  assert.match(apps, /data-action="update-all"/);
  assert.match(apps, /Update all \(/);
  assert.match(apps, /trackedRef/);
  assert.match(apps, /\/api\/apps\/\$\{encodeURIComponent\(entry\.appId\)\}\/execute/);
  assert.match(apps, /Run update jobs for/);
  assert.match(apps, /confirm: 'EXECUTE'/);
});

test('planned app detail offers real install or metadata-only discard', () => {
  const detail = readPublicScript('app-detail.js');

  assert.match(detail, /Saved dry-run/);
  assert.match(detail, /Run real install/);
  assert.match(detail, /Discard saved plan/);
  assert.match(detail, /discard-plan/);
  assert.match(detail, /Backup inventory is unavailable/);
});

test('dashboard surfaces local-only backup posture warning', () => {
  const dashboard = readPublicScript('dashboard.js');

  assert.match(dashboard, /Backup posture/);
  assert.match(dashboard, /Backups are currently local-only/);
  assert.match(dashboard, /Health warnings/);
  assert.match(dashboard, /renderAppHealthWarnings/);
  assert.match(dashboard, /renderHostWarnings/);
  assert.match(dashboard, /needs-setup/);
  assert.match(dashboard, /helper-failing/);
  assert.match(dashboard, /\/api\/apps\/health/);
  assert.match(dashboard, /Inspect →/);
  assert.match(dashboard, /Update in Config before wider deployment/);
});

test('shared API exposes backup summary helpers', () => {
  const api = readPublicScript('api.js');

  assert.match(api, /function latestBackup\(backups\)/);
  assert.match(api, /function backupSummary\(backups\)/);
  assert.match(api, /function localOnlyBackupNote\(config\)/);
  assert.match(api, /function runtimeStatusMeta\(status\)/);
  assert.match(api, /function runtimeStatusPill\(status\)/);
  assert.match(api, /Helper failing/);
  assert.match(api, /Needs setup/);
  assert.match(api, /No backups yet/);
  assert.match(api, /latestBackup,/);
  assert.match(api, /backupSummary,/);
  assert.match(api, /localOnlyBackupNote,/);
  assert.match(api, /runtimeStatusMeta,/);
  assert.match(api, /runtimeStatusPill,/);
});

test('app detail page surfaces helper unit health rows', () => {
  const appDetail = readPublicScript('app-detail.js');

  assert.match(appDetail, /Helper units/);
  assert.match(appDetail, /helperUnits/);
  assert.match(appDetail, /helper-failing/);
});
