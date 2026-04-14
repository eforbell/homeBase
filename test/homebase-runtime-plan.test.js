const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHomeBaseRuntimePlan } = require('../src/services/homebase-runtime-planner');

test('homebase runtime plan renders service install scaffolding', () => {
  const plan = buildHomeBaseRuntimePlan({
    port: 3080,
    serviceUser: 'sovereign',
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    gitTransport: 'https',
  });

  assert.equal(plan.kind, 'homebase-runtime');
  assert.equal(plan.runtime.user, 'homebase');
  assert.equal(plan.runtime.enablePrivilegedJobs, true);
  assert.match(plan.files['homebase.service'], /Description=Home Base Control Plane/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_STATE_DB=\/var\/lib\/sovereign-home\/homebase\/home-base\.sqlite3/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_ENABLE_PRIVILEGED_JOBS=1/);
  assert.match(plan.script, /usermod -aG sovereign homebase/);
  assert.match(plan.script, /homebase ALL=\(ALL\) NOPASSWD:ALL/);
  assert.match(plan.script, /visudo -cf \/etc\/sudoers\.d\/homebase/);
  assert.match(plan.script, /systemctl enable homebase/);
  assert.match(plan.script, /Stop the shell-run instance/);
});

test('homebase runtime plan can skip privileged job sudoers wiring', () => {
  const plan = buildHomeBaseRuntimePlan({
    port: 3080,
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    gitTransport: 'https',
  }, {
    enablePrivilegedJobs: false,
  });

  assert.equal(plan.runtime.enablePrivilegedJobs, false);
  assert.doesNotMatch(plan.script, /NOPASSWD:ALL/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_ENABLE_PRIVILEGED_JOBS=0/);
});
