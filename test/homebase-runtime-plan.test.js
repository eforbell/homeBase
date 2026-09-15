const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHomeBaseRuntimePlan } = require('../src/services/homebase-runtime-planner');

test('homebase runtime plan renders hardened plan-only service scaffolding', () => {
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
  assert.equal(plan.runtime.enablePrivilegedJobs, false);
  assert.equal(plan.runtime.executionMode, 'plan-only');
  assert.match(plan.files['homebase.service'], /Description=Home Base Control Plane/);
  assert.match(plan.files['homebase.service'], /NoNewPrivileges=true/);
  assert.match(plan.files['homebase.service'], /ProtectSystem=strict/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_STATE_DB=\/var\/lib\/sovereign-home\/homebase\/home-base\.sqlite3/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_BIND_HOST=127\.0\.0\.1/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_EXECUTION_MODE=plan-only/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_ENABLE_PRIVILEGED_JOBS=0/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_AUTO_BOOTSTRAP=0/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_AUTO_BOOTSTRAP_MODE=execute/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_REPOSITORY_URL=https:\/\/github\.com\/eforbell\/homeBase\.git/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_REPOSITORY_SSH_URL=git@github\.com:eforbell\/homeBase\.git/);
  assert.equal(plan.runtime.autoBootstrap, false);
  assert.doesNotMatch(plan.script, /usermod -aG sovereign homebase/);
  assert.match(plan.script, /install -d -m 0755 -o root -g root \/opt\/sovereign-home\/homebase/);
  assert.match(plan.script, /install -d -m 0700 -o homebase -g homebase \/var\/lib\/sovereign-home\/homebase/);
  assert.match(plan.script, /chown -R root:root \/opt\/sovereign-home\/homebase/);
  assert.match(plan.script, /chmod 0640 \/etc\/sovereign-home\/homebase\.env/);
  assert.doesNotMatch(plan.script, /NOPASSWD:ALL/);
  assert.match(plan.script, /Refusing to continue while legacy broad sudoers exists/);
  assert.match(plan.script, /systemctl enable homebase/);
  assert.match(plan.script, /Stop the shell-run instance/);
});

test('homebase runtime plan persists ssh-key git settings for service self-update', () => {
  const plan = buildHomeBaseRuntimePlan({
    port: 3080,
    baseInstallDir: '/opt/sovereign-home/apps',
    baseBackupDir: '/var/lib/sovereign-home/backups',
    baseConfigDir: '/etc/sovereign-home',
    gitTransport: 'ssh-key',
    gitSshKeyPath: '/opt/sovereign-home/.ssh/id_founder_homebase',
    gitSshKnownHostsPath: '/opt/sovereign-home/.ssh/known_hosts',
  });

  assert.match(plan.files['homebase.env'], /HOME_BASE_GIT_TRANSPORT=ssh-key/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_GIT_SSH_KEY_PATH=\/opt\/sovereign-home\/\.ssh\/id_founder_homebase/);
  assert.match(plan.files['homebase.env'], /HOME_BASE_GIT_SSH_KNOWN_HOSTS_PATH=\/opt\/sovereign-home\/\.ssh\/known_hosts/);
});

test('homebase runtime plan refuses to generate legacy broad sudoers wiring', () => {
  assert.throws(() => buildHomeBaseRuntimePlan({
    port: 3080,
    homeBaseExecutionMode: 'legacy-sudo',
    homeBaseEnablePrivilegedJobs: true,
  }, {
    enablePrivilegedJobs: true,
  }), /no longer generates privileged sudoers/i);
});

test('homebase runtime plan refuses auto-bootstrap in the installed service', () => {
  assert.throws(() => buildHomeBaseRuntimePlan({ port: 3080 }, {
    autoBootstrap: true,
  }), /auto-bootstrap is unavailable/i);
});
