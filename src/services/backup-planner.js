const { getAppById } = require('../catalog');

function buildBackupPlan({ appId, state = {}, config = {} }) {
  const app = getAppById(appId);
  if (!app) {
    const error = new Error(`Unknown app id: ${appId}`);
    error.code = 'APP_NOT_FOUND';
    throw error;
  }

  const installation = state.installations && state.installations[appId];
  const installRoot = installation?.installRoot || `${(config.baseInstallDir || '/opt/sovereign-home/apps').replace(/\/$/, '')}/${app.repoKey}`;
  const backupRoot = `${(config.baseBackupDir || '/var/lib/sovereign-home/backups').replace(/\/$/, '')}/${app.id}`;
  const generatedAt = new Date().toISOString();

  const timestampExpr = '$(date -u +%Y%m%dT%H%M%SZ)';
  const archiveDir = `${backupRoot}/${timestampExpr}`;
  const commands = [
    `sudo install -d -m 0750 ${backupRoot}`,
    `ARCHIVE_DIR=${archiveDir}`,
    'sudo mkdir -p "$ARCHIVE_DIR"',
    `sudo cp ${installRoot}/.env "$ARCHIVE_DIR/.env.backup"`,
  ];

  if (app.runtime.kind === 'python' && app.id === 'bitcoin-accounting') {
    commands.push(`cd ${installRoot} && set -a && . ./.env && set +a && if [ "$DB_BACKEND" = "postgres" ]; then PGPASSWORD="$PGPASSWORD" pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Fc -f "$ARCHIVE_DIR/database.dump"; fi`);
    commands.push(`cd ${installRoot} && set -a && . ./.env && set +a && if [ "$DB_BACKEND" = "sqlite" ] && [ -n "$SQLITE_DB_PATH" ]; then sudo cp "$SQLITE_DB_PATH" "$ARCHIVE_DIR/sqlite-ledger.db"; fi`);
  } else {
    commands.push(`cd ${installRoot} && set -a && . ./.env && set +a && pg_dump "$DATABASE_URL" -Fc -f "$ARCHIVE_DIR/database.dump"`);
  }

  for (const relativePath of app.storage?.paths || []) {
    commands.push(`if [ -e ${installRoot}/${relativePath} ]; then sudo tar -C ${installRoot} -czf "$ARCHIVE_DIR/${relativePath.replaceAll('/', '_')}.tgz" ${relativePath}; fi`);
  }

  commands.push(`sudo sh -c 'printf "%s\\n" "${generatedAt}" > "$ARCHIVE_DIR/backup-generated-at.txt"'`);

  return {
    kind: 'backup',
    generatedAt,
    app: {
      id: app.id,
      name: app.name,
    },
    backup: {
      installRoot,
      backupRoot,
      storagePaths: app.storage?.paths || [],
    },
    commands,
    script: `#!/usr/bin/env bash\nset -euo pipefail\n\n${commands.join('\n')}\n`,
  };
}

module.exports = {
  buildBackupPlan,
};
