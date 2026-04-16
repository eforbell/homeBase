const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('app detail UI exposes dry-run guarded real backup execution', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-detail.js'), 'utf8');

  assert.match(source, /form class="hb-form-grid" data-action="backup"/);
  assert.match(source, /Type EXECUTE to run backup for real/);
  assert.match(source, /\/api\/apps\/\$\{appId\}\/backup\/execute/);
});
