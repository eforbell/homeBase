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

test('legacy backup and restore archive external storage from storage.absoluteRoot, not the checkout', () => {
  const { buildBackupPlan } = require('../src/services/backup-planner');
  const { buildRestorePlan } = require('../src/services/restore-planner');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const config = { baseInstallDir: '/opt/sovereign-home/apps', baseBackupDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hb-legacy-bk-')), serviceUser: 'sovereign' };
  const backup = buildBackupPlan({ appId: 'home-source', state: {}, config });
  const documents = backup.commands.find((command) => command.includes('documents.tgz'));
  assert.match(documents, /tar -C \/var\/lib\/sovereign-home\/home-source\/data -czf .*documents\.tgz documents/);
  assert.doesNotMatch(documents, /apps\/homeSource\/documents/);
  const archiveDir = path.join(config.baseBackupDir, 'home-source', '20260924T000000Z');
  fs.mkdirSync(archiveDir, { recursive: true });
  const restore = buildRestorePlan({ appId: 'home-source', backupDir: archiveDir, state: {}, config });
  assert.ok(restore.commands.some((command) => command.includes('rm -rf /var/lib/sovereign-home/home-source/data/documents && tar -C /var/lib/sovereign-home/home-source/data -xzf')));
  const inRoot = buildBackupPlan({ appId: 'family-help', state: {}, config });
  assert.ok(inRoot.commands.some((command) => command.includes('tar -C /opt/sovereign-home/apps/familyHelp -czf')), 'in-root storage apps are unchanged');
});
