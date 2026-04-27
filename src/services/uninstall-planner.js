const { getAppById } = require('../catalog');
const { getBackupRoot } = require('./backup-inventory');

function makeStep(id, title, commands) {
  return { id, title, run: commands.filter(Boolean) };
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function systemctlDisableNowCommand(unitName) {
  return `if sudo systemctl list-unit-files --full -all | grep -Fq ${shellSingleQuote(unitName)}; then sudo systemctl disable --now ${unitName} || sudo systemctl stop ${unitName} || true; fi`;
}

function systemctlRemoveUnitCommand(fileName) {
  return `sudo rm -f /etc/systemd/system/${fileName}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildUninstallPlan({ appId, state = {}, config = {}, options = {} }) {
  const app = getAppById(appId);
  if (!app) {
    const error = new Error(`Unknown app id: ${appId}`);
    error.code = 'APP_NOT_FOUND';
    throw error;
  }

  const installation = state.installations && state.installations[appId];
  if (!installation) {
    const error = new Error(`App ${appId} is not currently installed.`);
    error.code = 'APP_NOT_INSTALLED';
    throw error;
  }

  const keepBackups = options.keepBackups !== false;
  const installRoot = installation.installRoot;
  const backupRoot = getBackupRoot(app.id, config);
  const unitNames = unique([
    app.service?.name,
    ...(app.sidecars || []).map((sidecar) => sidecar.name),
    ...(app.timers || []).map((timer) => timer.timerName),
  ]);
  const unitFiles = unique([
    `${app.service?.name}.service`,
    ...(app.sidecars || []).map((sidecar) => `${sidecar.name}.service`),
    ...(app.timers || []).flatMap((timer) => [`${timer.serviceName}.service`, timer.timerName]),
  ]);
  const nginxSnippetFiles = unique([
    `${app.id}.conf`,
    ...(app.sidecars || [])
      .filter((sidecar) => sidecar.nginx)
      .map((sidecar) => `${sidecar.name}.conf`),
  ]);

  const dbName = app.database?.databaseName || app.id.replace(/-/g, '_');
  const dbUser = app.database?.databaseUser || dbName;

  const executionSteps = [
    makeStep('stop-services', `Stop ${app.name} services`, unitNames.map((unit) => systemctlDisableNowCommand(unit))),
    makeStep('remove-runtime-artifacts', `Remove ${app.name} systemd and nginx artifacts`, [
      ...unitFiles.map((fileName) => systemctlRemoveUnitCommand(fileName)),
      'sudo systemctl daemon-reload',
      ...nginxSnippetFiles.map((fileName) => `sudo rm -f /etc/nginx/snippets/${fileName}`),
      'if command -v nginx >/dev/null 2>&1; then sudo nginx -t && sudo systemctl reload nginx; fi',
    ]),
    app.database?.engine && app.database.engine.includes('postgres')
      ? makeStep('drop-database', `Drop ${app.name} database`, [
          `sudo -u postgres psql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();" || true`,
          `sudo -u postgres dropdb --if-exists ${dbName}`,
          `sudo -u postgres psql -d postgres -c "DROP ROLE IF EXISTS ${dbUser};"`,
        ])
      : null,
    makeStep('remove-install-root', `Remove ${app.name} install directory`, [
      `sudo rm -rf ${installRoot}`,
    ]),
    keepBackups
      ? makeStep('preserve-backups', `Preserve ${app.name} backups`, [
          `echo Keeping backup archives under ${backupRoot}`,
        ])
      : makeStep('remove-backups', `Remove ${app.name} backups`, [
          `sudo rm -rf ${backupRoot}`,
        ]),
  ].filter(Boolean);

  const commands = executionSteps.flatMap((step) => step.run);

  return {
    kind: 'uninstall',
    generatedAt: new Date().toISOString(),
    app: {
      id: app.id,
      name: app.name,
    },
    uninstall: {
      installRoot,
      backupRoot,
      keepBackups,
      serviceName: app.service?.name || installation.serviceName,
      unitNames,
      unitFiles,
      database: app.database?.engine && app.database.engine.includes('postgres')
        ? { engine: app.database.engine, name: dbName, user: dbUser }
        : null,
    },
    executionSteps,
    commands,
    script: `#!/usr/bin/env bash\nset -euo pipefail\n\n# Uninstall ${app.name}\n\n${commands.join('\n')}\n`,
  };
}

module.exports = {
  buildUninstallPlan,
};
