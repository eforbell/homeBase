const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readAppDetail() {
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'app-detail.js'), 'utf8');
}

test('app detail UI exposes dry-run guarded real backup execution', () => {
  const source = readAppDetail();

  assert.match(source, /data-action="backup"/);
  assert.match(source, /Type EXECUTE to run backup for real/);
  assert.match(source, /\/api\/apps\/\$\{appId\}\/backup\/execute/);
});

test('app detail exposes operations sections and anchors', () => {
  const source = readAppDetail();

  assert.match(source, /id="backup"/);
  assert.match(source, /id="restore"/);
  assert.match(source, /id="deploy"/);
  assert.match(source, /href="#backup"/);
  assert.match(source, /href="#restore"/);
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
});
