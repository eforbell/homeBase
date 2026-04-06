const { getAppById } = require('../catalog');

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function ensureLeadingSlash(value) {
  return value.startsWith('/') ? value : `/${value}`;
}

function normalizeMountPath(value) {
  let next = value || '/';
  next = ensureLeadingSlash(next);
  if (!next.endsWith('/')) next += '/';
  return next;
}

function allocatePort(preferred, usedPorts) {
  let candidate = preferred;
  while (usedPorts.has(candidate)) candidate += 1;
  return candidate;
}

function quoteEnvValue(value) {
  const stringValue = value == null ? '' : String(value);
  if (/^[A-Za-z0-9_./:@-]*$/.test(stringValue)) return stringValue;
  return JSON.stringify(stringValue);
}

function renderEnv(envMap) {
  return `${Object.entries(envMap)
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
    .join('\n')}\n`;
}

function renderServiceUnit({ description, serviceUser, installRoot, envFile, execStart, extraEnvironment = {} }) {
  const envLines = Object.entries(extraEnvironment).map(([key, value]) => `Environment=${key}=${value}`);
  return [
    '[Unit]',
    `Description=${description}`,
    'After=network.target postgresql.service',
    '',
    '[Service]',
    'Type=simple',
    `User=${serviceUser}`,
    `WorkingDirectory=${installRoot}`,
    `EnvironmentFile=${installRoot}/${envFile}`,
    ...envLines,
    `ExecStart=${execStart}`,
    'Restart=always',
    'RestartSec=5',
    'KillSignal=SIGTERM',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function renderOneshotUnit({ description, serviceUser, installRoot, envFile, execStart, extraEnvironment = {} }) {
  const envLines = Object.entries(extraEnvironment).map(([key, value]) => `Environment=${key}=${value}`);
  return [
    '[Unit]',
    `Description=${description}`,
    'After=network.target postgresql.service',
    '',
    '[Service]',
    'Type=oneshot',
    `User=${serviceUser}`,
    `WorkingDirectory=${installRoot}`,
    `EnvironmentFile=${installRoot}/${envFile}`,
    ...envLines,
    `ExecStart=${execStart}`,
    '',
  ].join('\n');
}

function renderTimerUnit({ description, onCalendar, serviceName }) {
  return [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Timer]',
    `OnCalendar=${onCalendar}`,
    'Persistent=true',
    `Unit=${serviceName}.service`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

function renderNginxSnippet({ mountPath, port, appId, extraProxyHeaders = [] }) {
  const basePath = trimTrailingSlash(mountPath === '/' ? '' : mountPath);
  const lines = [
    `# ${appId}`,
    `location ${mountPath} {`,
    `    proxy_pass http://127.0.0.1:${port}/;`,
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
  ];
  if (basePath) lines.push(`    proxy_set_header X-Forwarded-Prefix ${basePath};`);
  for (const header of extraProxyHeaders) lines.push(`    ${header}`);
  lines.push('}', '');
  return lines.join('\n');
}

function renderFileWriteCommand(targetPath, content) {
  const safe = content.replace(/EOF/g, 'EOX');
  return `sudo tee ${targetPath} > /dev/null <<'EOF'\n${safe}EOF`;
}

function makeStep(id, title, commands) {
  return { id, title, run: commands.filter(Boolean) };
}

function renderWaitForHttpCommand({ url, attempts = 20, sleepSeconds = 1 }) {
  return `for attempt in $(seq 1 ${attempts}); do curl --fail --silent --show-error ${url} && exit 0; sleep ${sleepSeconds}; done; echo "Timed out waiting for ${url}" >&2; exit 1`;
}

function buildDatabaseCommands(app, ctx) {
  if (!app.database.engine.includes('postgres')) return [];

  return [
    `sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = '${ctx.dbUser}'" | grep -q 1 || sudo -u postgres psql -c \"CREATE ROLE ${ctx.dbUser} LOGIN PASSWORD '${ctx.dbPassword}';\"`,
    `sudo -u postgres psql -lqt | cut -d '|' -f 1 | grep -qw ${ctx.dbName} || sudo -u postgres createdb --owner=${ctx.dbUser} ${ctx.dbName}`,
  ];
}

function buildAppBootstrapCommands(app, ctx) {
  const commands = [];

  if (app.runtime.kind === 'node') {
    commands.push(`cd ${ctx.installRoot} && ${app.runtime.installCommand}`);
    if (app.database.bootstrap === 'schema-file' && app.database.schemaCommand) {
      commands.push(`cd ${ctx.installRoot} && ${app.database.schemaCommand}`);
    }
    if (app.database.migrationCommand) {
      commands.push(`cd ${ctx.installRoot} && ${app.database.migrationCommand}`);
    }
    return commands;
  }

  commands.push(`cd ${ctx.installRoot} && python3 -m venv ${app.runtime.pythonVenv || '.venv'}`);
  commands.push(`cd ${ctx.installRoot} && .venv/bin/python -m pip install --upgrade pip`);
  commands.push(`cd ${ctx.installRoot} && ${app.runtime.installCommand}`);
  if (app.database.bootstrap === 'schema-file' && app.database.schemaCommand) {
    commands.push(
      `cd ${ctx.installRoot} && ${app.database.schemaCommand
        .replaceAll('{{dbUser}}', ctx.dbUser)
        .replaceAll('{{dbName}}', ctx.dbName)}`
    );
  }
  if (app.database.migrationCommand) {
    commands.push(`cd ${ctx.installRoot} && ${app.database.migrationCommand}`);
  }
  return commands;
}

function renderStartCommand(app, ctx) {
  return app.runtime.startCommand
    .replaceAll('{{port}}', String(ctx.port))
    .replaceAll('{{installRoot}}', ctx.installRoot);
}

function resolveEnvTemplate(template, ctx) {
  const resolved = {};
  for (const [key, value] of Object.entries(template)) {
    let next = String(value);
    next = next.replaceAll('{{databaseUrl}}', ctx.databaseUrl);
    next = next.replaceAll('{{port}}', String(ctx.port));
    next = next.replaceAll('{{externalUrl}}', ctx.externalUrl);
    next = next.replaceAll('{{publicUrl}}', ctx.publicUrl);
    next = next.replaceAll('{{dbUser}}', ctx.dbUser);
    next = next.replaceAll('{{dbPassword}}', ctx.dbPassword);
    next = next.replaceAll('{{dbName}}', ctx.dbName);
    next = next.replaceAll('{{mountBasePath}}', trimTrailingSlash(ctx.mountPath));
    if (ctx.sidecarPorts) {
      for (const [sidecarName, sidecarPort] of Object.entries(ctx.sidecarPorts)) {
        next = next.replaceAll(`{{sidecar.${sidecarName}.port}}`, String(sidecarPort));
      }
    }
    resolved[key] = next;
  }
  return resolved;
}

function resolveRepositoryUrl(app, config = {}) {
  if (config.gitTransport === 'ssh' && app.repository.sshUrl) {
    return app.repository.sshUrl;
  }
  return app.repository.url;
}

function buildInstallPlan({ appId, state = {}, options = {}, config = {} }) {
  const app = getAppById(appId);
  if (!app) {
    const error = new Error(`Unknown app id: ${appId}`);
    error.code = 'APP_NOT_FOUND';
    throw error;
  }

  const existingInstallation = state.installations && state.installations[appId] ? state.installations[appId] : null;
  const usedPorts = new Set(Object.values(state.installations || {}).map((entry) => entry.port));
  usedPorts.add(config.port || 3080);

  const mountPath = normalizeMountPath(options.mountPath || app.network.preferredMountPath);
  const port = options.port || allocatePort(app.network.preferredPort, usedPorts);
  const serviceUser = options.serviceUser || config.serviceUser || 'sovereign';
  const installRoot = `${(options.baseInstallDir || config.baseInstallDir || '/opt/sovereign-home/apps').replace(/\/$/, '')}/${app.repoKey}`;
  const dbName = options.dbName || app.database.databaseName || app.id.replace(/-/g, '_');
  const dbUser = options.dbUser || app.database.databaseUser || dbName;
  const dbPassword = options.dbPassword || `change-me-${dbUser}`;
  const hostname = options.hostname || config.defaultHostname || 'homebase';
  const domain = options.domain || config.defaultDomain || 'tailnet';
  const publicBase = options.publicBaseUrl || `https://${hostname}.${domain}`;
  const externalUrl = `${trimTrailingSlash(publicBase)}${mountPath}`;
  const publicUrl = externalUrl;
  const databaseUrl = `postgresql://${dbUser}:${dbPassword}@127.0.0.1:5432/${dbName}`;

  const sidecarPorts = {};
  if (Array.isArray(app.sidecars)) {
    let nextPort = port + 1;
    for (const sidecar of app.sidecars) {
      while (usedPorts.has(nextPort)) nextPort += 1;
      sidecarPorts[sidecar.name] = nextPort;
      usedPorts.add(nextPort);
      nextPort += 1;
    }
  }

  const ctx = {
    port,
    mountPath,
    installRoot,
    dbName,
    dbUser,
    dbPassword,
    databaseUrl,
    externalUrl,
    publicUrl,
    serviceUser,
    sidecarPorts,
  };
  const repositoryUrl = resolveRepositoryUrl(app, config);

  const env = resolveEnvTemplate(app.config.env, ctx);
  const files = {};
  files['.env'] = renderEnv(env);
  files[`${app.service.name}.service`] = renderServiceUnit({
    description: app.service.description,
    serviceUser,
    installRoot,
    envFile: app.service.envFile,
    execStart: renderStartCommand(app, ctx),
    extraEnvironment: app.runtime.kind === 'node' ? { NODE_ENV: app.runtime.nodeEnv || 'production' } : { PYTHONUNBUFFERED: '1' },
  });

  if (Array.isArray(app.sidecars)) {
    for (const sidecar of app.sidecars) {
      files[`${sidecar.name}.service`] = renderServiceUnit({
        description: sidecar.description,
        serviceUser,
        installRoot,
        envFile: app.service.envFile,
        execStart: sidecar.execStart,
        extraEnvironment: sidecar.env || {},
      });
    }
  }

  if (Array.isArray(app.timers)) {
    for (const timer of app.timers) {
      files[`${timer.serviceName}.service`] = renderOneshotUnit({
        description: timer.description,
        serviceUser,
        installRoot,
        envFile: app.service.envFile,
        execStart: timer.execStart,
        extraEnvironment: { NODE_ENV: 'production' },
      });
      files[timer.timerName] = renderTimerUnit({
        description: `Run ${timer.description.toLowerCase()}`,
        onCalendar: timer.onCalendar,
        serviceName: timer.serviceName,
      });
    }
  }

  files[`${app.id}.nginx.conf`] = renderNginxSnippet({ mountPath, port, appId: app.id });

  const executionSteps = [
    makeStep('prepare-layout', 'Prepare install directory', [
      `sudo install -d -o ${serviceUser} -g ${serviceUser} ${config.baseInstallDir || '/opt/sovereign-home/apps'}`,
    ]),
    makeStep('git-sync', 'Clone or update application source', [
      `if [ ! -d ${installRoot}/.git ]; then sudo -u ${serviceUser} git clone ${repositoryUrl} ${installRoot}; fi`,
      `sudo -u ${serviceUser} git -C ${installRoot} fetch origin --prune`,
      `sudo -u ${serviceUser} git -C ${installRoot} checkout ${options.ref || app.repository.defaultRef}`,
      `sudo -u ${serviceUser} git -C ${installRoot} pull --ff-only origin ${options.ref || app.repository.defaultRef}`,
    ]),
    makeStep('database-bootstrap', 'Create database role and database', buildDatabaseCommands(app, ctx)),
    makeStep('render-config', 'Render application environment and unit files', [
      renderFileWriteCommand(`${installRoot}/.env`, files['.env']),
      renderFileWriteCommand(`/etc/systemd/system/${app.service.name}.service`, files[`${app.service.name}.service`]),
      renderFileWriteCommand(`/etc/nginx/snippets/${app.id}.conf`, files[`${app.id}.nginx.conf`]),
    ]),
    makeStep('app-bootstrap', 'Install dependencies and run app bootstrap', buildAppBootstrapCommands(app, ctx)),
    makeStep('enable-services', 'Enable and start services', [
      'sudo systemctl daemon-reload',
      `sudo systemctl enable --now ${app.service.name}`,
    ]),
    makeStep('health-check', 'Validate nginx and application health', [
      'sudo nginx -t',
      'sudo systemctl reload nginx',
      renderWaitForHttpCommand({
        url: `http://127.0.0.1:${port}${app.network.health.readinessPath || app.network.health.livenessPath}`,
      }),
    ]),
  ];

  if (Array.isArray(app.sidecars)) {
    for (const sidecar of app.sidecars) {
      executionSteps[3].run.push(renderFileWriteCommand(`/etc/systemd/system/${sidecar.name}.service`, files[`${sidecar.name}.service`]));
      executionSteps[5].run.push(`sudo systemctl enable --now ${sidecar.name}`);
    }
  }
  if (Array.isArray(app.timers)) {
    for (const timer of app.timers) {
      executionSteps[3].run.push(renderFileWriteCommand(`/etc/systemd/system/${timer.serviceName}.service`, files[`${timer.serviceName}.service`]));
      executionSteps[3].run.push(renderFileWriteCommand(`/etc/systemd/system/${timer.timerName}`, files[timer.timerName]));
      executionSteps[5].run.push(`sudo systemctl enable --now ${timer.timerName}`);
    }
  }

  const commands = executionSteps.flatMap((step) => step.run);

  const script = `#!/usr/bin/env bash\nset -euo pipefail\n\n# Install ${app.name}\n\n${commands.join('\n')}\n`;

  return {
    kind: 'install',
    generatedAt: new Date().toISOString(),
    app: {
      id: app.id,
      name: app.name,
      repoUrl: repositoryUrl,
      ref: options.ref || app.repository.defaultRef,
    },
    install: {
      serviceUser,
      installRoot,
      port,
      mountPath,
      externalUrl,
      publicBase,
      dbName,
      dbUser,
      health: app.network.health,
    },
    notes: app.updateNotes || [],
    existingInstallation,
    files,
    executionSteps,
    commands,
    script,
    stateRecord: {
      appId: app.id,
      name: app.name,
      port,
      mountPath,
      externalUrl,
      installRoot,
      serviceName: app.service.name,
      ref: options.ref || app.repository.defaultRef,
      status: 'planned',
      plannedAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  allocatePort,
  buildInstallPlan,
  normalizeMountPath,
  renderEnv,
};
