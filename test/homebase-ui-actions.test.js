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

test('failed bootstrap jobs expose rerun actions on dashboard and job detail', () => {
  const dashboard = readPublicScript('dashboard.js');
  const jobDetail = readPublicScript('job-detail.js');

  assert.match(dashboard, /data-action="rerun-bootstrap"/);
  assert.match(dashboard, /latest\.status === 'failed'/);
  assert.match(jobDetail, /data-action="rerun-bootstrap"/);
  assert.match(jobDetail, /job\.kind === 'bootstrap' && job\.status === 'failed'/);
});
