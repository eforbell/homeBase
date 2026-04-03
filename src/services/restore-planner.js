const fs = require('fs');
const path = require('path');
const { getAppById } = require('../catalog');
const { listBackups } = require('./backup-inventory');

function buildRestorePlan({ appId, backupDir, state = {}, config = {} }) {
  const app = getAppById(appId);
  if (!app) {
    const error = new Error(`Unknown app id: ${appId}`);
    error.code = 'APP_NOT_FOUND';
    throw error;
  }

  const installation = state.installations && state.installations[appId];
  const installRoot = installation?.installRoot || `${(config.baseInstallDir || '/opt/sovereign-home/apps').replace(/\/$/, '')}/${app.repoKey}`;

  const backups = listBackups({ appId, config }).backups;
  const selectedBackup = backupDir
    ? backups.find((item) => item.archiveDir === backupDir || item.name === backupDir)
    : backups[0];

  if (!selectedBackup) {
    const error = new Error(`No backup found for ${appId}`);
    error.code = 'BACKUP_NOT_FOUND';
    throw error;
  }

  const archiveDir = selectedBackup.archiveDir;
  const commands = [
    `sudo test -d ${archiveDir}`,
    `if [ -f ${archiveDir}/.env.backup ]; then sudo cp ${archiveDir}/.env.backup ${installRoot}/.env; fi`,
  ];

  if (app.runtime.kind === 'python' && app.id === 'bitcoin-accounting') {
    commands.push(`cd ${installRoot} && set -a && . ./.env && set +a && if [ -f ${archiveDir}/database.dump ] && [ "$DB_BACKEND" = "postgres" ]; then PGPASSWORD="$PGPASSWORD" pg_restore --clean --if-exists -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" ${archiveDir}/database.dump; fi`);
    commands.push(`cd ${installRoot} && set -a && . ./.env && set +a && if [ -f ${archiveDir}/sqlite-ledger.db ] && [ "$DB_BACKEND" = "sqlite" ] && [ -n "$SQLITE_DB_PATH" ]; then sudo cp ${archiveDir}/sqlite-ledger.db "$SQLITE_DB_PATH"; fi`);
  } else {
    commands.push(`cd ${installRoot} && set -a && . ./.env && set +a && if [ -f ${archiveDir}/database.dump ]; then pg_restore --clean --if-exists -d "$DATABASE_URL" ${archiveDir}/database.dump; fi`);
  }

  for (const relativePath of app.storage?.paths || []) {
    const tarName = `${relativePath.replaceAll('/', '_')}.tgz`;
    commands.push(`if [ -f ${archiveDir}/${tarName} ]; then sudo rm -rf ${installRoot}/${relativePath} && sudo tar -C ${installRoot} -xzf ${archiveDir}/${tarName}; fi`);
  }

  if (installation?.serviceName) {
    commands.push(`sudo systemctl restart ${installation.serviceName}`);
  }
  commands.push(`curl --fail --silent --show-error http://127.0.0.1:${installation?.port || app.network.preferredPort}${app.network.health.livenessPath}`);

  return {
    kind: 'restore',
    generatedAt: new Date().toISOString(),
    app: { id: app.id, name: app.name },
    restore: {
      archiveDir,
      installRoot,
      generatedAt: selectedBackup.generatedAt,
      serviceName: installation?.serviceName || app.service.name,
    },
    commands,
    script: `#!/usr/bin/env bash\nset -euo pipefail\n\n${commands.join('\n')}\n`,
  };
}

module.exports = {
  buildRestorePlan,
};
