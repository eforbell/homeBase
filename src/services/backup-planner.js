const { getAppById } = require('../catalog');

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function renderRunAsServiceUserCommand({ serviceUser, command }) {
  return `sudo -u ${serviceUser} -H bash -lc ${shellSingleQuote(command)}`;
}

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
  const serviceUser = config.serviceUser || 'sovereign';
  const generatedAt = new Date().toISOString();
  const archiveName = generatedAt.replaceAll(':', '').replaceAll('-', '').replace('.000', '').replace('.','');
  const archiveDir = `${backupRoot}/${archiveName}`;
  const commands = [
    `sudo install -d -m 0750 -o ${serviceUser} -g ${serviceUser} ${backupRoot}`,
    `sudo install -d -m 0750 -o ${serviceUser} -g ${serviceUser} ${archiveDir}`,
    renderRunAsServiceUserCommand({
      serviceUser,
      command: `cp ${installRoot}/.env ${archiveDir}/.env.backup`,
    }),
  ];

  if (app.runtime.kind === 'python' && app.id === 'bitcoin-accounting') {
    commands.push(renderRunAsServiceUserCommand({
      serviceUser,
      command: `cd ${installRoot} && set -a && . ./.env && set +a && if [ "$DB_BACKEND" = "postgres" ]; then PGPASSWORD="$PGPASSWORD" pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Fc -f ${archiveDir}/database.dump; fi`,
    }));
    commands.push(renderRunAsServiceUserCommand({
      serviceUser,
      command: `cd ${installRoot} && set -a && . ./.env && set +a && if [ "$DB_BACKEND" = "sqlite" ] && [ -n "$SQLITE_DB_PATH" ]; then cp "$SQLITE_DB_PATH" ${archiveDir}/sqlite-ledger.db; fi`,
    }));
  } else {
    commands.push(renderRunAsServiceUserCommand({
      serviceUser,
      command: `cd ${installRoot} && set -a && . ./.env && set +a && pg_dump "$DATABASE_URL" -Fc -f ${archiveDir}/database.dump`,
    }));
  }

  for (const relativePath of app.storage?.paths || []) {
    commands.push(renderRunAsServiceUserCommand({
      serviceUser,
      command: `if [ -e ${installRoot}/${relativePath} ]; then tar -C ${installRoot} -czf ${archiveDir}/${relativePath.replaceAll('/', '_')}.tgz ${relativePath}; fi`,
    }));
  }

  commands.push(renderRunAsServiceUserCommand({
    serviceUser,
    command: `printf "%s\\n" "${generatedAt}" > ${archiveDir}/backup-generated-at.txt`,
  }));

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
      archiveDir,
      expectedFiles: [
        '.env.backup',
        'database.dump',
        'backup-generated-at.txt',
        ...(app.storage?.paths || []).map((relativePath) => `${relativePath.replaceAll('/', '_')}.tgz`),
      ],
      storagePaths: app.storage?.paths || [],
    },
    commands,
    script: `#!/usr/bin/env bash\nset -euo pipefail\n\n${commands.join('\n')}\n`,
  };
}

module.exports = {
  buildBackupPlan,
};
