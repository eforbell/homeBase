const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHomeBaseRuntimePlan } = require('../src/services/homebase-runtime-planner');

test('homebase runtime plan renders service install scaffolding', () => {
  const plan = buildHomeBaseRuntimePlan({
    port: 3080,
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    gitTransport: 'https',
  });

  assert.equal(plan.kind, 'homebase-runtime');
  assert.equal(plan.runtime.user, 'homebase');
  assert.match(plan.files['homebase.service'], /Description=Home Base Control Plane/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_STATE_DB=\/var\/lib\/sovereign-home\/homebase\/home-base\.sqlite3/);
  assert.match(plan.script, /systemctl enable --now homebase/);
});
