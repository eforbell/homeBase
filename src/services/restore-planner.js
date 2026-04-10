const fs = require('fs');
const path = require('path');
const { getAppById } = require('../catalog');
const { listBackupsFromDisk } = require('./backup-inventory');

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function renderRunAsServiceUserCommand({ serviceUser, command }) {
  return `sudo -u ${serviceUser} -H bash -lc ${shellSingleQuote(command)}`;
}

function renderWaitForHttpCommand({ url, attempts = 20, sleepSeconds = 1 }) {
  return `for attempt in $(seq 1 ${attempts}); do curl --fail --silent --show-error ${url} && exit 0; sleep ${sleepSeconds}; done; echo "Timed out waiting for ${url}" >&2; exit 1`;
}

function buildRestorePlan({ appId, backupDir, state = {}, config = {} }) {
  const app = getAppById(appId);
  if (!app) {
    const error = new Error(`Unknown app id: ${appId}`);
    error.code = 'APP_NOT_FOUND';
    throw error;
  }

  const installation = state.installations && state.installations[appId];
  const installRoot = installation?.installRoot || `${(config.baseInstallDir || '/opt/sovereign-home/apps').replace(/\/$/, '')}/${app.repoKey}`;

  const backups = listBackupsFromDisk({ appId, config }).backups;
  const selectedBackup = backupDir
    ? backups.find((item) => item.archiveDir === backupDir || item.name === backupDir)
    : backups[0];

  if (!selectedBackup) {
    const error = new Error(`No backup found for ${appId}`);
    error.code = 'BACKUP_NOT_FOUND';
    throw error;
  }

  const archiveDir = selectedBackup.archiveDir;
  const serviceUser = config.serviceUser || 'sovereign';
  const commands = [
    `sudo test -d ${archiveDir}`,
    renderRunAsServiceUserCommand({
      serviceUser,
      command: `if [ -f ${archiveDir}/.env.backup ]; then cp ${archiveDir}/.env.backup ${installRoot}/.env; fi`,
    }),
  ];

  if (app.runtime.kind === 'python' && app.id === 'bitcoin-accounting') {
    commands.push(renderRunAsServiceUserCommand({
      serviceUser,
      command: `cd ${installRoot} && set -a && . ./.env && set +a && if [ -f ${archiveDir}/database.dump ] && [ "$DB_BACKEND" = "postgres" ]; then PGPASSWORD="$PGPASSWORD" pg_restore --clean --if-exists -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" ${archiveDir}/database.dump; fi`,
    }));
    commands.push(renderRunAsServiceUserCommand({
      serviceUser,
      command: `cd ${installRoot} && set -a && . ./.env && set +a && if [ -f ${archiveDir}/sqlite-ledger.db ] && [ "$DB_BACKEND" = "sqlite" ] && [ -n "$SQLITE_DB_PATH" ]; then cp ${archiveDir}/sqlite-ledger.db "$SQLITE_DB_PATH"; fi`,
    }));
  } else {
    commands.push(renderRunAsServiceUserCommand({
      serviceUser,
      command: `cd ${installRoot} && set -a && . ./.env && set +a && if [ -f ${archiveDir}/database.dump ]; then pg_restore --clean --if-exists -d "$DATABASE_URL" ${archiveDir}/database.dump; fi`,
    }));
  }

  for (const relativePath of app.storage?.paths || []) {
    const tarName = `${relativePath.replaceAll('/', '_')}.tgz`;
    commands.push(renderRunAsServiceUserCommand({
      serviceUser,
      command: `if [ -f ${archiveDir}/${tarName} ]; then rm -rf ${installRoot}/${relativePath} && tar -C ${installRoot} -xzf ${archiveDir}/${tarName}; fi`,
    }));
  }

  if (installation?.serviceName) {
    commands.push(`sudo systemctl restart ${installation.serviceName}`);
  }
  commands.push(renderWaitForHttpCommand({
    url: `http://127.0.0.1:${installation?.port || app.network.preferredPort}${app.network.health.readinessPath || app.network.health.livenessPath}`,
  }));

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
