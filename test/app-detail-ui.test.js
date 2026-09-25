const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readAppDetail() {
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'app-detail.js'), 'utf8');
}

test('app detail UI exposes backup and restore execution without window.prompt', () => {
  const source = readAppDetail();

  assert.match(source, /data-action="backup"/);
  assert.match(source, /data-action="update-check"/);
  assert.doesNotMatch(source, /window\.prompt/);
  assert.match(source, /\/api\/apps\/\$\{appId\}\/backup\/execute/);
  assert.match(source, /\/api\/apps\/\$\{appId\}\/restart\/execute/);
  assert.match(source, /\/api\/apps\/\$\{appId\}\/uninstall\/execute/);
  assert.match(source, /\/api\/apps\/updates\?refresh=1/);
  assert.match(source, /window\.HB\.confirmInline/);
  assert.match(source, /Restore will overwrite/);
  assert.match(source, /form\.dataset\.submitting/);
  assert.match(source, /submitButton\.disabled = true/);
});

test('app detail exposes operations sections and anchors', () => {
  const source = readAppDetail();

  assert.match(source, /id="health"/);
  assert.match(source, /id="backup"/);
  assert.match(source, /id="restore"/);
  assert.match(source, /id="update"/);
  assert.match(source, /id="uninstall"/);
  assert.match(source, /data-action="restart"/);
  assert.match(source, /Git ref/);
  assert.match(source, /actionLabel} dry-run/);
  assert.match(source, /href="#health"/);
  assert.match(source, /href="#backup"/);
  assert.match(source, /href="#restore"/);
  assert.match(source, /href="#update"/);
  assert.match(source, /href="#uninstall"/);
  assert.match(source, /scrollToCurrentHash/);
});

test('app detail polls backup and restore jobs until the page can repaint', () => {
  const source = readAppDetail();

  assert.match(source, /waitForJobCompletion/);
  assert.match(source, /Intentional fire-and-forget/);
  assert.match(source, /void waitForJobCompletion/);
  assert.match(source, /This page will refresh when it finishes/);
  assert.match(source, /setTimeout\(\(\) => load\(\), 650\)/);
});

test('app detail surfaces backup summary and local-only risk', () => {
  const source = readAppDetail();

  assert.match(source, /Last backup:/);
  assert.match(source, /No backups recorded yet\. Take a first backup/);
  assert.match(source, /window\.HB\.latestBackup/);
  assert.match(source, /window\.HB\.localOnlyBackupNote/);
  assert.match(source, /\/api\/apps\/health/);
  assert.match(source, /Runtime health/);
  assert.match(source, /probeSummary/);
  assert.match(source, /payload\.ref = ref/);
  assert.match(source, /Run update/);
  assert.match(source, /Check now/);
  assert.match(source, /data-update-status/);
  assert.match(source, /fully redeploy this app/);
  assert.match(source, /keepBackups/);
  assert.match(source, /Run uninstall/);
  assert.match(source, /Keep backups/);
  assert.match(source, /Setup ↗/);
  assert.match(source, /Onboarding/);
});
