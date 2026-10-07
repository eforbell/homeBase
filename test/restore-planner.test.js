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

test('restore plan uses Helm database URL env key and preserves it across env restore', () => {
  const { backupRoot, archiveDir } = makeBackupDir('helm');
  const plan = buildRestorePlan({
    appId: 'helm',
    backupDir: archiveDir,
    state: baseState('helm', '/opt/sovereign-home/apps/helm', 'helm-web', 3011),
    config: {
      baseBackupDir: backupRoot,
      serviceUser: 'sovereign',
    },
  });

  assert.match(plan.script, /HELM_DATABASE_URL/);
  assert.match(plan.script, /pg_restore --clean --if-exists -d "\$HELM_DATABASE_URL"/);
  assert.match(plan.script, /curl --fail --silent --show-error http:\/\/127\.0\.0\.1:3011\/health/);
});

test('restore plan re-applies catalog storage env keys so old backups keep pointing at the archived root', () => {
  const { backupRoot, archiveDir } = makeBackupDir('family-pulse');
  const plan = buildRestorePlan({
    appId: 'family-pulse',
    backupDir: archiveDir,
    state: baseState('family-pulse', '/opt/sovereign-home/apps/familyPulse', 'family-pulse', 3003),
    config: { baseBackupDir: backupRoot, serviceUser: 'sovereign' },
  });
  assert.match(plan.script, /FP_TRANSACTION_FILES_DIR=\/var\/lib\/sovereign-home\/family-pulse\/data\/transaction-files/);
  const help = makeBackupDir('family-help');
  const other = buildRestorePlan({
    appId: 'family-help',
    backupDir: help.archiveDir,
    state: baseState('family-help', '/opt/sovereign-home/apps/familyHelp', 'family-help', 3002),
    config: { baseBackupDir: help.backupRoot, serviceUser: 'sovereign' },
  });
  assert.doesNotMatch(other.script, /FP_TRANSACTION_FILES_DIR/);
});
