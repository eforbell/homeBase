const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHomeBaseUpdatePlan } = require('../src/services/homebase-update-planner');

test('homebase update plan generates git pull and restart steps', () => {
  const plan = buildHomeBaseUpdatePlan({
    homeBaseAppDir: '/opt/sovereign-home/homebase',
    homeBaseRuntimeUser: 'homebase',
    port: 3080,
    gitTransport: 'https',
  });

  assert.equal(plan.kind, 'homebase-update');
  assert.equal(plan.update.runtimeUser, 'homebase');
  assert.equal(plan.update.ref, 'main');
  assert.ok(plan.executionSteps.find((s) => s.id === 'git-pull'));
  assert.ok(plan.executionSteps.find((s) => s.id === 'install-deps'));
  assert.ok(plan.executionSteps.find((s) => s.id === 'restart-service'));
  assert.match(plan.script, /git -C \/opt\/sovereign-home\/homebase pull --ff-only/);
  assert.match(plan.script, /npm ci --omit=dev/);
  assert.match(plan.script, /systemctl restart homebase/);
});

test('homebase update plan uses ssh-key git prefix when configured', () => {
  const plan = buildHomeBaseUpdatePlan({
    homeBaseAppDir: '/opt/sovereign-home/homebase',
    homeBaseRuntimeUser: 'homebase',
    port: 3080,
    gitTransport: 'ssh-key',
    gitSshKeyPath: '/opt/sovereign-home/.ssh/id_founder_homebase',
  });

  assert.match(plan.script, /GIT_SSH_COMMAND/);
  assert.match(plan.script, /id_founder_homebase/);
});

test('homebase update plan respects custom ref', () => {
  const plan = buildHomeBaseUpdatePlan(
    { homeBaseAppDir: '/opt/sovereign-home/homebase', gitTransport: 'https' },
    { ref: 'v2.0.0' },
  );

  assert.equal(plan.update.ref, 'v2.0.0');
  assert.match(plan.script, /checkout v2\.0\.0/);
});
