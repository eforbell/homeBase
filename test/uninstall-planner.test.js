const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUninstallPlan } = require('../src/services/uninstall-planner');

test('uninstall plan removes managed runtime artifacts and preserves backups by default', () => {
  const plan = buildUninstallPlan({
    appId: 'family-help',
    state: {
      installations: {
        'family-help': {
          appId: 'family-help',
          installRoot: '/opt/sovereign-home/apps/familyHelp',
          serviceName: 'family-help',
        },
      },
    },
    config: {
      baseBackupDir: '/var/lib/sovereign-home/backups',
    },
  });

  assert.equal(plan.kind, 'uninstall');
  assert.equal(plan.uninstall.keepBackups, true);
  assert.equal(plan.uninstall.installRoot, '/opt/sovereign-home/apps/familyHelp');
  assert.match(plan.script, /systemctl disable --now family-help/);
  assert.match(plan.script, /family-help-reminders\.timer/);
  assert.match(plan.script, /rm -f \/etc\/nginx\/snippets\/family-help\.conf/);
  assert.match(plan.script, /dropdb --if-exists familyhelp/);
  assert.match(plan.script, /DROP ROLE IF EXISTS familyhelp/);
  assert.match(plan.script, /rm -rf \/opt\/sovereign-home\/apps\/familyHelp/);
  assert.match(plan.script, /Keeping backup archives under \/var\/lib\/sovereign-home\/backups\/family-help/);
  assert.doesNotMatch(plan.script, /rm -rf \/var\/lib\/sovereign-home\/backups\/family-help/);
});

test('uninstall plan can remove backups when keepBackups is disabled', () => {
  const plan = buildUninstallPlan({
    appId: 'bug-base',
    state: {
      installations: {
        'bug-base': {
          appId: 'bug-base',
          installRoot: '/opt/sovereign-home/apps/bugBase',
          serviceName: 'bug-base',
        },
      },
    },
    config: {
      baseBackupDir: '/var/lib/sovereign-home/backups',
    },
    options: {
      keepBackups: false,
    },
  });

  assert.equal(plan.uninstall.keepBackups, false);
  assert.match(plan.script, /bug-base-mcp\.service/);
  assert.match(plan.script, /rm -f \/etc\/nginx\/snippets\/bug-base-mcp\.conf/);
  assert.match(plan.script, /rm -rf \/var\/lib\/sovereign-home\/backups\/bug-base/);
});
