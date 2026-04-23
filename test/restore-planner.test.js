const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRestorePlan } = require('../src/services/restore-planner');

function baseState(appId, installRoot, serviceName, port) {
  return {
    installations: {
      [appId]: {
        appId,
        installRoot,
        serviceName,
        port,
      },
    },
  };
}

function makeBackupDir(appId) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `home-base-restore-planner-${appId}-`));
  const backupRoot = path.join(tempDir, 'backups');
  const archiveDir = path.join(backupRoot, appId, '20260423T000000Z');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, '.env.backup'), 'placeholder=1\n');
  fs.writeFileSync(path.join(archiveDir, 'database.dump'), 'placeholder');
  return { tempDir, backupRoot, archiveDir };
}

test('restore plan preserves current DATABASE_URL-style credentials before applying .env.backup', () => {
  const { backupRoot, archiveDir } = makeBackupDir('family-help');
  const plan = buildRestorePlan({
    appId: 'family-help',
    backupDir: archiveDir,
    state: baseState('family-help', '/opt/sovereign-home/apps/familyHelp', 'family-help', 3002),
    config: {
      baseBackupDir: backupRoot,
      serviceUser: 'sovereign',
    },
  });

  assert.match(plan.script, /DATABASE_URL\|DB_BACKEND\|PGHOST\|PGPORT\|PGUSER\|PGPASSWORD\|PGDATABASE\|SQLITE_DB_PATH/);
  assert.match(plan.script, /\.env\.backup/);
  assert.match(plan.script, /sed -i\.bak/);
  assert.match(plan.script, /tee -a/);
  assert.match(plan.script, /pg_restore --clean --if-exists -d "\$DATABASE_URL"/);
});

test('restore plan preserves split PG env credentials for postgres-or-sqlite apps', () => {
  const { backupRoot, archiveDir } = makeBackupDir('bitcoin-accounting');
  const plan = buildRestorePlan({
    appId: 'bitcoin-accounting',
    backupDir: archiveDir,
    state: baseState('bitcoin-accounting', '/opt/sovereign-home/apps/bitcoinAccounting', 'bitcoin-accounting-web', 3010),
    config: {
      baseBackupDir: backupRoot,
      serviceUser: 'sovereign',
    },
  });

  assert.match(plan.script, /PGPASSWORD="\$PGPASSWORD" pg_restore --clean --if-exists -h "\$PGHOST" -p "\$PGPORT" -U "\$PGUSER" -d "\$PGDATABASE"/);
  assert.match(plan.script, /SQLITE_DB_PATH/);
  assert.match(plan.script, /DB_BACKEND/);
});
