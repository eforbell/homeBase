const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getAppById } = require('../catalog');

const DEFAULT_SOVEREIGN_FONT_SANS_CSS_URL = 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap';
const DEFAULT_SOVEREIGN_FONT_MONO_CSS_URL = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap';

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

function dirnameOrFallback(value, fallback) {
  const dir = path.dirname(String(value || ''));
  return dir && dir !== '.' ? dir : fallback;
}

function resolveSovereignFontContext({ config = {}, baseInstallDir, publicBase }) {
  const sharedRoot = config.homeBaseSharedRoot || dirnameOrFallback(baseInstallDir, '/opt/sovereign-home');
  const assetsRoot = config.homeBaseAssetsRoot || path.join(sharedRoot, 'assets');
  const fontDir = path.join(assetsRoot, 'fonts');
  const sansFile = path.join(fontDir, 'source-sans-3.css');
  const monoFile = path.join(fontDir, 'jetbrains-mono.css');
  const localAvailable = fs.existsSync(sansFile) && fs.existsSync(monoFile);

  const mountPath = normalizeMountPath(config.sovereignFontMountPath || '/_sovereign/fonts/');
  const localBaseUrl = `${trimTrailingSlash(publicBase)}${mountPath}`;

  const googleSansUrl = config.sovereignFontGoogleSansCssUrl || DEFAULT_SOVEREIGN_FONT_SANS_CSS_URL;
  const googleMonoUrl = config.sovereignFontGoogleMonoCssUrl || DEFAULT_SOVEREIGN_FONT_MONO_CSS_URL;

  return {
    source: localAvailable ? 'local' : 'google',
    sansCssUrl: googleSansUrl,
    monoCssUrl: googleMonoUrl,
    localSansCssUrl: `${localBaseUrl}source-sans-3.css`,
    localMonoCssUrl: `${localBaseUrl}jetbrains-mono.css`,
  };
}

function appendMountPathSuffix(mountPath, suffix) {
  const base = trimTrailingSlash(normalizeMountPath(mountPath));
  const cleanedSuffix = String(suffix || '').replace(/^\/+/, '');
  return normalizeMountPath(`${base}/${cleanedSuffix}`);
}

function isValidGitRef(value) {
  const ref = String(value || '').trim();
  if (!ref) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  if (ref.startsWith('/') || ref.endsWith('/')) return false;
  if (ref.startsWith('.') || ref.endsWith('.')) return false;
  if (ref.includes('..')) return false;
  if (ref.includes('//')) return false;
  if (ref.includes('@{')) return false;
  if (ref.endsWith('.lock')) return false;
  return true;
}

function resolveGitRef(options, app) {
  const requested = options && options.ref != null ? String(options.ref).trim() : '';
  const ref = requested || app.repository.defaultRef;
  if (!isValidGitRef(ref)) {
    const error = new Error('Invalid git ref. Use a branch/tag name with letters, numbers, dot, underscore, slash, or dash.');
    error.code = 'INVALID_GIT_REF';
    throw error;
  }
  return ref;
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

function renderServiceUnit({ description, serviceUser, installRoot, envFile, execStart, extraEnvironment = {}, umask = null }) {
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
    ...(umask ? [`UMask=${umask}`] : []),
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

function renderOneshotUnit({ description, serviceUser, installRoot, envFile, execStart, extraEnvironment = {}, umask = null }) {
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
    ...(umask ? [`UMask=${umask}`] : []),
    `ExecStart=${execStart}`,
    '',
  ].join('\n');
}

function renderTimerUnit({
  description,
  onCalendar,
  onBootSec,
  onUnitActiveSec,
  randomizedDelaySec,
  serviceName,
  persistent = true,
}) {
  const scheduleLines = [
    ...(onCalendar ? [`OnCalendar=${onCalendar}`] : []),
    ...(onBootSec ? [`OnBootSec=${onBootSec}`] : []),
    ...(onUnitActiveSec ? [`OnUnitActiveSec=${onUnitActiveSec}`] : []),
  ];
  if (scheduleLines.length === 0) {
    throw new Error(`Timer ${serviceName} requires a calendar or monotonic schedule`);
  }
  return [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Timer]',
    ...scheduleLines,
    ...(randomizedDelaySec ? [`RandomizedDelaySec=${randomizedDelaySec}`] : []),
    `Persistent=${persistent === false ? 'false' : 'true'}`,
    `Unit=${serviceName}.service`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

function renderNginxSnippet({
  mountPath,
  port,
  appId,
  extraProxyHeaders = [],
  preserveMountPath = false,
  upstreamPath = '/',
}) {
  const basePath = trimTrailingSlash(mountPath === '/' ? '' : mountPath);
  const normalizedUpstreamPath = normalizeMountPath(upstreamPath || '/');
  const lines = [`# ${appId}`];
  if (basePath) {
    lines.push(`location = ${basePath} {`, `    return 301 ${mountPath};`, '}');
  }
  lines.push(
    `location ${mountPath} {`,
    `    proxy_pass http://127.0.0.1:${port}${preserveMountPath ? '' : normalizedUpstreamPath};`,
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
  );
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

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function renderWaitForHttpCommand({ url, attempts = 20, sleepSeconds = 1 }) {
  return `for attempt in $(seq 1 ${attempts}); do curl --fail --silent --show-error ${url} && exit 0; sleep ${sleepSeconds}; done; echo "Timed out waiting for ${url}" >&2; exit 1`;
}

function renderRunAsServiceUserCommand({ serviceUser, command }) {
  return `sudo -u ${serviceUser} -H bash -lc ${shellSingleQuote(command)}`;
}

function buildDatabaseCommands(app, ctx) {
  if (!app.database.engine.includes('postgres')) return [];
  if (ctx.skipDbBootstrap) return [];

  return [
    `sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = '${ctx.dbUser}'" | grep -q 1 || sudo -u postgres psql -c \"CREATE ROLE ${ctx.dbUser} LOGIN PASSWORD '${ctx.dbPassword}';\"`,
    `sudo -u postgres psql -c "ALTER ROLE ${ctx.dbUser} PASSWORD '${ctx.dbPassword}';"`,
    `sudo -u postgres psql -lqt | cut -d '|' -f 1 | grep -qw ${ctx.dbName} || sudo -u postgres createdb --owner=${ctx.dbUser} ${ctx.dbName}`,
  ];
}

function buildSystemPackageCommands(app) {
  const packages = Array.isArray(app.systemPackages)
    ? app.systemPackages
      .map((pkg) => String(pkg || '').trim())
      .filter(Boolean)
    : [];
  if (!packages.length) return [];
  return [
    'sudo apt-get update',
    `sudo apt-get install -y ${packages.join(' ')}`,
  ];
}

function buildAppBootstrapCommands(app, ctx) {
  const commands = [];

  if (app.runtime.kind === 'node') {
    commands.push(renderRunAsServiceUserCommand({
      serviceUser: ctx.serviceUser,
      command: `cd ${ctx.installRoot} && ${app.runtime.installCommand}`,
    }));
    if (app.database.bootstrap === 'schema-file' && app.database.schemaCommand) {
      const resolvedCmd = app.database.schemaCommand
        .replaceAll('{{dbUser}}', ctx.dbUser)
        .replaceAll('{{dbName}}', ctx.dbName);
      const isPostgres = app.database.engine && app.database.engine.includes('postgres');
      commands.push(isPostgres
        ? `sudo -u postgres bash -lc ${shellSingleQuote(`cd ${ctx.installRoot} && ${resolvedCmd}`)}`
        : renderRunAsServiceUserCommand({ serviceUser: ctx.serviceUser, command: `cd ${ctx.installRoot} && ${resolvedCmd}` })
      );
    }
    if (app.database.migrationCommand) {
      commands.push(renderRunAsServiceUserCommand({
        serviceUser: ctx.serviceUser,
        command: `cd ${ctx.installRoot} && ${app.database.migrationCommand}`,
      }));
    }
    return commands;
  }

  commands.push(renderRunAsServiceUserCommand({
    serviceUser: ctx.serviceUser,
    command: `cd ${ctx.installRoot} && python3 -m venv ${app.runtime.pythonVenv || '.venv'}`,
  }));
  commands.push(renderRunAsServiceUserCommand({
    serviceUser: ctx.serviceUser,
    command: `cd ${ctx.installRoot} && .venv/bin/python -m pip install --upgrade pip`,
  }));
  commands.push(renderRunAsServiceUserCommand({
    serviceUser: ctx.serviceUser,
    command: `cd ${ctx.installRoot} && ${app.runtime.installCommand}`,
  }));
  if (app.database.bootstrap === 'schema-file' && app.database.schemaCommand) {
    const resolvedCmd = app.database.schemaCommand
      .replaceAll('{{dbUser}}', ctx.dbUser)
      .replaceAll('{{dbName}}', ctx.dbName);
    const isPostgres = app.database.engine && app.database.engine.includes('postgres');
    commands.push(isPostgres
      ? `sudo -u postgres bash -lc ${shellSingleQuote(`cd ${ctx.installRoot} && ${resolvedCmd}`)}`
      : renderRunAsServiceUserCommand({ serviceUser: ctx.serviceUser, command: `cd ${ctx.installRoot} && ${resolvedCmd}` })
    );
  }
  if (app.database.migrationCommand) {
    commands.push(renderRunAsServiceUserCommand({
      serviceUser: ctx.serviceUser,
      command: `cd ${ctx.installRoot} && ${app.database.migrationCommand}`,
    }));
  }
  return commands;
}

function renderCommandTemplate(command, ctx) {
  const resolved = String(command || '')
    .replaceAll('{{port}}', String(ctx.port))
    .replaceAll('{{installRoot}}', ctx.installRoot);
  const spaceIdx = resolved.indexOf(' ');
  const exe = spaceIdx === -1 ? resolved : resolved.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : resolved.slice(spaceIdx);
  if (exe.startsWith('.')) {
    return `${ctx.installRoot}/${exe}${rest}`;
  }
  return resolved;
}

function renderStartCommand(app, ctx) {
  return renderCommandTemplate(app.runtime.startCommand, ctx);
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
    next = next.replaceAll('{{secret1}}', ctx.secret1);
    next = next.replaceAll('{{secret2}}', ctx.secret2);
    next = next.replaceAll('{{secret3}}', ctx.secret3);
    next = next.replaceAll('{{householdTimezone}}', ctx.householdTimezone);
    next = next.replaceAll('{{sovereignFontSource}}', ctx.sovereignFontSource);
    next = next.replaceAll('{{sovereignFontSansCssUrl}}', ctx.sovereignFontSansCssUrl);
    next = next.replaceAll('{{sovereignFontMonoCssUrl}}', ctx.sovereignFontMonoCssUrl);
    next = next.replaceAll('{{sovereignFontSansCssUrlLocal}}', ctx.sovereignFontSansCssUrlLocal);
    next = next.replaceAll('{{sovereignFontMonoCssUrlLocal}}', ctx.sovereignFontMonoCssUrlLocal);
    if (ctx.sidecarPorts) {
      for (const [sidecarName, sidecarPort] of Object.entries(ctx.sidecarPorts)) {
        next = next.replaceAll(`{{sidecar.${sidecarName}.port}}`, String(sidecarPort));
      }
    }
    resolved[key] = next;
  }
  return resolved;
}

function parseDotEnv(content) {
  const env = {};
  const lines = String(content || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function parseDatabaseUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const dbName = parsed.pathname ? parsed.pathname.replace(/^\//, '') : '';
    return {
      databaseUrl: String(value),
      dbUser: parsed.username ? decodeURIComponent(parsed.username) : '',
      dbPassword: parsed.password ? decodeURIComponent(parsed.password) : '',
      dbName,
    };
  } catch (_error) {
    return null;
  }
}

function getDatabaseUrlEnvKey(app = {}) {
  return app.database?.urlEnvKey || 'DATABASE_URL';
}

function resolveExistingDbContext(existing = {}, defaults = {}, app = {}) {
  const next = { ...defaults };
  const databaseUrlEnvKey = getDatabaseUrlEnvKey(app);
  const existingDatabaseUrl = existing[databaseUrlEnvKey] || existing.DATABASE_URL;

  if (existingDatabaseUrl) {
    const parsed = parseDatabaseUrl(existingDatabaseUrl);
    if (parsed) {
      if (parsed.dbUser) next.dbUser = parsed.dbUser;
      if (parsed.dbPassword) next.dbPassword = parsed.dbPassword;
      if (parsed.dbName) next.dbName = parsed.dbName;
      next.databaseUrl = parsed.databaseUrl;
    }
  }

  if (existing.PGUSER) next.dbUser = existing.PGUSER;
  if (existing.PGPASSWORD) next.dbPassword = existing.PGPASSWORD;
  if (existing.PGDATABASE) next.dbName = existing.PGDATABASE;

  if (existing.DB_BACKEND) next.dbBackend = existing.DB_BACKEND;
  if (existing.SQLITE_DB_PATH) next.sqliteDbPath = existing.SQLITE_DB_PATH;

  if (!next.databaseUrl && next.dbUser && next.dbPassword && next.dbName) {
    next.databaseUrl = `postgresql://${next.dbUser}:${next.dbPassword}@127.0.0.1:5432/${next.dbName}`;
  }

  return next;
}

function hasExistingDbConfig(existing = {}, app = {}) {
  const databaseUrlEnvKey = getDatabaseUrlEnvKey(app);
  return Boolean(
    existing[databaseUrlEnvKey]
      || (databaseUrlEnvKey !== 'DATABASE_URL' && existing.DATABASE_URL)
      || existing.PGUSER
      || existing.PGPASSWORD
      || existing.PGDATABASE
      || existing.SQLITE_DB_PATH
  );
}

function shouldPreserveExistingEnvValue(key, templateValue, preserveExistingKeys = []) {
  const template = String(templateValue == null ? '' : templateValue);
  if (preserveExistingKeys.includes(key)) return true;
  if (template === '') return true;
  if (template.includes('{{secret')) return true;
  if (['DATABASE_URL', 'DB_BACKEND', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'SQLITE_DB_PATH'].includes(key)) return true;
  if (key === 'DATABASE_URL' && template.includes('{{databaseUrl}}')) return true;
  if (/(SECRET|TOKEN|PASSWORD|PASSPHRASE|API_KEY|CLIENT_SECRET|CLIENT_ID|AUTH_)/i.test(key)) return true;
  return false;
}

function mergeExistingEnvValues({ template, resolved, existing, preserveExistingKeys = [] }) {
  const next = { ...resolved };
  for (const [key, templateValue] of Object.entries(template || {})) {
    const existingValue = existing[key];
    if (!existingValue) continue;
    if (!shouldPreserveExistingEnvValue(key, templateValue, preserveExistingKeys)) continue;
    next[key] = existingValue;
  }
  for (const [key, existingValue] of Object.entries(existing || {})) {
    if (!existingValue) continue;
    if (key in next) continue;
    if (!shouldPreserveExistingEnvValue(key, '', preserveExistingKeys)) continue;
    next[key] = existingValue;
  }
  return next;
}

function resolveRepositoryUrl(app, config = {}) {
  if ((config.gitTransport === 'ssh' || config.gitTransport === 'ssh-key') && app.repository.sshUrl) {
    return app.repository.sshUrl;
  }
  return app.repository.url;
}

function renderGitRunPrefix({ serviceUser, app, config = {} }) {
  const base = `sudo -u ${serviceUser}`;
  if (config.gitTransport === 'ssh') {
    return `sudo --preserve-env=SSH_AUTH_SOCK -u ${serviceUser}`;
  }
  if (config.gitTransport === 'ssh-key') {
    if (!config.gitSshKeyPath) {
      const error = new Error('HOME_BASE_GIT_SSH_KEY_PATH is required when HOME_BASE_GIT_TRANSPORT=ssh-key');
      error.code = 'GIT_SSH_KEY_PATH_REQUIRED';
      throw error;
    }
    const sshParts = [
      'ssh',
      '-i', config.gitSshKeyPath,
      '-o', 'IdentitiesOnly=yes',
      '-o', `StrictHostKeyChecking=${config.gitSshStrictHostKeyChecking || 'accept-new'}`,
    ];
    if (config.gitSshKnownHostsPath) {
      sshParts.push('-o', `UserKnownHostsFile=${config.gitSshKnownHostsPath}`);
    }
    return `${base} env GIT_SSH_COMMAND=${shellSingleQuote(sshParts.join(' '))}`;
  }
  return base;
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
  const existingEnvPath = `${installRoot}/.env`;
  let existingEnv = null;
  try {
    if (fs.existsSync(existingEnvPath)) {
      existingEnv = parseDotEnv(fs.readFileSync(existingEnvPath, 'utf8'));
    }
  } catch (_error) {
    existingEnv = null;
  }

  const defaultDbName = options.dbName || app.database.databaseName || app.id.replace(/-/g, '_');
  const defaultDbUser = options.dbUser || app.database.databaseUser || defaultDbName;
  const defaultDbPassword = options.dbPassword || crypto.randomBytes(24).toString('base64url');
  const defaultDatabaseUrl = `postgresql://${defaultDbUser}:${defaultDbPassword}@127.0.0.1:5432/${defaultDbName}`;
  const existingDbContext = existingEnv && hasExistingDbConfig(existingEnv, app)
    ? resolveExistingDbContext(existingEnv, {
        dbName: defaultDbName,
        dbUser: defaultDbUser,
        dbPassword: defaultDbPassword,
        databaseUrl: defaultDatabaseUrl,
        dbBackend: existingEnv.DB_BACKEND || null,
        sqliteDbPath: existingEnv.SQLITE_DB_PATH || null,
      }, app)
    : null;
  const dbName = existingDbContext?.dbName || defaultDbName;
  const dbUser = existingDbContext?.dbUser || defaultDbUser;
  const dbPassword = existingDbContext?.dbPassword || defaultDbPassword;
  const secret1 = crypto.randomBytes(32).toString('hex');
  const secret2 = crypto.randomBytes(32).toString('hex');
  const secret3 = crypto.randomBytes(32).toString('hex');
  const householdTimezone = options.householdTimezone || config.householdTimezone || 'America/New_York';
  const hostname = options.hostname || config.defaultHostname || 'homebase';
  const domain = options.domain || config.defaultDomain || 'tailnet';
  const publicBase = options.publicBaseUrl || `https://${hostname}.${domain}`;
  const externalUrl = `${trimTrailingSlash(publicBase)}${mountPath}`;
  const publicUrl = externalUrl;
  const databaseUrl = existingDbContext?.databaseUrl || `postgresql://${dbUser}:${dbPassword}@127.0.0.1:5432/${dbName}`;
  const sovereignFonts = resolveSovereignFontContext({
    config,
    baseInstallDir: options.baseInstallDir || config.baseInstallDir || '/opt/sovereign-home/apps',
    publicBase,
  });

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
    secret1,
    secret2,
    secret3,
    householdTimezone,
    sovereignFontSource: sovereignFonts.source,
    sovereignFontSansCssUrl: sovereignFonts.sansCssUrl,
    sovereignFontMonoCssUrl: sovereignFonts.monoCssUrl,
    sovereignFontSansCssUrlLocal: sovereignFonts.localSansCssUrl,
    sovereignFontMonoCssUrlLocal: sovereignFonts.localMonoCssUrl,
    dbBackend: existingDbContext?.dbBackend || null,
    sqliteDbPath: existingDbContext?.sqliteDbPath || null,
    skipDbBootstrap: Boolean(existingDbContext),
  };
  const repositoryUrl = resolveRepositoryUrl(app, config);
  const gitRef = resolveGitRef(options, app);
  const gitRunPrefix = renderGitRunPrefix({ serviceUser, app, config });

  const env = resolveEnvTemplate(app.config.env, ctx);
  let mergedEnv = env;
  if (existingEnv) {
    mergedEnv = mergeExistingEnvValues({
      template: app.config.env,
      resolved: env,
      existing: existingEnv,
      preserveExistingKeys: app.config.preserveExistingKeys || [],
    });
  }
  const files = {};
  files['.env'] = renderEnv(mergedEnv);
  const runtimeEnv = app.runtime.kind === 'node' ? { NODE_ENV: app.runtime.nodeEnv || 'production' } : { PYTHONUNBUFFERED: '1' };
  files[`${app.service.name}.service`] = renderServiceUnit({
    description: app.service.description,
    serviceUser,
    installRoot,
    envFile: app.service.envFile,
    execStart: renderStartCommand(app, ctx),
    extraEnvironment: { TZ: householdTimezone, ...runtimeEnv },
    umask: app.service.umask,
  });

  if (Array.isArray(app.sidecars)) {
    for (const sidecar of app.sidecars) {
      files[`${sidecar.name}.service`] = renderServiceUnit({
        description: sidecar.description,
        serviceUser,
        installRoot,
        envFile: app.service.envFile,
        execStart: renderCommandTemplate(sidecar.execStart, ctx),
        extraEnvironment: { TZ: householdTimezone, ...(sidecar.env || {}) },
        umask: sidecar.umask || app.service.umask,
      });

      if (sidecar.nginx) {
        const sidecarMountPath = sidecar.nginx.mountPath
          ? normalizeMountPath(sidecar.nginx.mountPath)
          : appendMountPathSuffix(mountPath, sidecar.nginx.mountPathSuffix || sidecar.name);
        files[`${sidecar.name}.nginx.conf`] = renderNginxSnippet({
          mountPath: sidecarMountPath,
          port: sidecarPorts[sidecar.name],
          appId: sidecar.name,
          preserveMountPath: sidecar.nginx.preserveMountPath === true,
          upstreamPath: sidecar.nginx.upstreamPath || '/',
          extraProxyHeaders: sidecar.nginx.extraProxyHeaders || [],
        });
      }
    }
  }

  if (Array.isArray(app.timers)) {
    for (const timer of app.timers) {
      files[`${timer.serviceName}.service`] = renderOneshotUnit({
        description: timer.description,
        serviceUser,
        installRoot,
        envFile: app.service.envFile,
        execStart: renderCommandTemplate(timer.execStart, ctx),
        extraEnvironment: { TZ: householdTimezone, ...(app.runtime.kind === 'node' ? { NODE_ENV: app.runtime.nodeEnv || 'production' } : { PYTHONUNBUFFERED: '1' }) },
        umask: timer.umask || app.service.umask,
      });
      files[timer.timerName] = renderTimerUnit({
        description: `Run ${timer.description.toLowerCase()}`,
        onCalendar: timer.onCalendar,
        onBootSec: timer.onBootSec,
        onUnitActiveSec: timer.onUnitActiveSec,
        randomizedDelaySec: timer.randomizedDelaySec,
        serviceName: timer.serviceName,
        persistent: timer.persistent,
      });
    }
  }

  files[`${app.id}.nginx.conf`] = renderNginxSnippet({
    mountPath,
    port,
    appId: app.id,
    preserveMountPath: app.network.preserveMountPath === true,
  });

  const executionSteps = [
    makeStep('prepare-layout', 'Prepare install directory', [
      `sudo install -d -o ${serviceUser} -g ${serviceUser} ${config.baseInstallDir || '/opt/sovereign-home/apps'}`,
    ]),
    makeStep('git-sync', 'Clone or update application source', [
      `if [ ! -d ${installRoot}/.git ]; then ${gitRunPrefix} git clone ${repositoryUrl} ${installRoot}; fi`,
      `${gitRunPrefix} git -C ${installRoot} fetch origin --prune`,
      `${gitRunPrefix} git -C ${installRoot} checkout ${gitRef}`,
      `${gitRunPrefix} git -C ${installRoot} pull --ff-only origin ${gitRef}`,
    ]),
    makeStep('system-packages', 'Install app-specific system packages', buildSystemPackageCommands(app)),
    makeStep('database-bootstrap', 'Create database role and database', buildDatabaseCommands(app, ctx)),
    makeStep('render-config', 'Render application environment and unit files', [
      renderFileWriteCommand(`${installRoot}/.env`, files['.env']),
      renderFileWriteCommand(`/etc/systemd/system/${app.service.name}.service`, files[`${app.service.name}.service`]),
      renderFileWriteCommand(`/etc/nginx/snippets/${app.id}.conf`, files[`${app.id}.nginx.conf`]),
    ]),
    makeStep('app-bootstrap', 'Install dependencies and run app bootstrap', buildAppBootstrapCommands(app, ctx)),
    makeStep('enable-services', 'Enable and start services', [
      'sudo systemctl daemon-reload',
      `sudo systemctl enable ${app.service.name}`,
      `sudo systemctl restart ${app.service.name}`,
    ]),
    makeStep('health-check', 'Validate nginx and application health', [
      'sudo nginx -t',
      'sudo systemctl reload nginx',
      renderWaitForHttpCommand({
        url: `http://127.0.0.1:${port}${app.network.health.readinessPath || app.network.health.livenessPath}`,
      }),
    ]),
  ];

  const renderConfigStep = executionSteps.find((step) => step.id === 'render-config');
  const enableServicesStep = executionSteps.find((step) => step.id === 'enable-services');

  if (Array.isArray(app.sidecars)) {
    for (const sidecar of app.sidecars) {
      renderConfigStep.run.push(renderFileWriteCommand(`/etc/systemd/system/${sidecar.name}.service`, files[`${sidecar.name}.service`]));
      if (files[`${sidecar.name}.nginx.conf`]) {
        renderConfigStep.run.push(renderFileWriteCommand(`/etc/nginx/snippets/${sidecar.name}.conf`, files[`${sidecar.name}.nginx.conf`]));
      }
      enableServicesStep.run.push(`sudo systemctl enable ${sidecar.name}`);
      enableServicesStep.run.push(`sudo systemctl restart ${sidecar.name}`);
    }
  }
  if (Array.isArray(app.timers)) {
    for (const timer of app.timers) {
      renderConfigStep.run.push(renderFileWriteCommand(`/etc/systemd/system/${timer.serviceName}.service`, files[`${timer.serviceName}.service`]));
      renderConfigStep.run.push(renderFileWriteCommand(`/etc/systemd/system/${timer.timerName}`, files[timer.timerName]));
      enableServicesStep.run.push(`sudo systemctl enable ${timer.timerName}`);
      enableServicesStep.run.push(`sudo systemctl restart ${timer.timerName}`);
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
      ref: gitRef,
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
      ref: gitRef,
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
