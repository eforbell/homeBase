const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBackupPlan } = require('../src/services/backup-planner');

test('backup plan uses Helm database URL env key and includes token storage', () => {
  const plan = buildBackupPlan({
    appId: 'helm',
    state: {
      installations: {
        helm: {
          installRoot: '/opt/sovereign-home/apps/helm',
        },
      },
    },
    config: {
      serviceUser: 'sovereign',
      baseBackupDir: '/var/lib/sovereign-home/backups',
    },
  });

  assert.match(plan.script, /pg_dump "\$HELM_DATABASE_URL" -Fc/);
  assert.match(plan.script, /tar -C \/opt\/sovereign-home\/apps\/helm -czf .*\/\.secrets\.tgz \.secrets/);
  assert.deepEqual(plan.backup.storagePaths, ['.secrets']);
  assert.ok(plan.backup.expectedFiles.includes('.secrets.tgz'));
});
