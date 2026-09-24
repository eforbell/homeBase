const path = require('path');
const { OperationPlanError } = require('./validate');
const { templatePlaceholders } = require('./env');

// Everything the executor needs to know about an app's on-host shape, derived only from the
// root-owned catalog. Catalog values are trusted, but still validated here so a malformed entry
// fails closed instead of reaching a root operation.

const APPS_ROOT = '/opt/sovereign-home/apps';
const MIRROR_ROOT = '/var/lib/sovereign-home/git-mirrors';
// Postgres names that must never be managed as an app's role or database.
const RESERVED_DB = /^(postgres|template[01]|pg_.*)$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const DB_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const REPO_KEY = /^[A-Za-z][A-Za-z0-9]{0,62}$/;
const STORAGE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SCHEDULE_VALUE = /^[A-Za-z0-9*:,./ -]{1,64}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENV_VALUE = /^[A-Za-z0-9_./:@-]{0,256}$/;

function unsupported(app, message) { throw new OperationPlanError('POLICY_DENIED', `${app?.id || 'app'}: ${message}`); }

// Catalog commands become fixed argv. Only two shapes are accepted today:
//   node <relative/script.js> [--flag ...]      npm run <script>
// Anything else (shell syntax, other binaries, .venv tools) is refused until explicitly supported.
function commandArgv(app, command) {
  const parts = String(command || '').trim().split(/\s+/);
  if (parts[0] === 'node' && parts.length >= 2) {
    const [, script, ...flags] = parts;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*\.js$/.test(script) || script.includes('..')) unsupported(app, `unsupported script path in "${command}"`);
    if (flags.some((flag) => !/^--?[a-z0-9][a-z0-9-]*$/.test(flag))) unsupported(app, `unsupported arguments in "${command}"`);
    return ['/usr/bin/node', script, ...flags];
  }
  if (parts[0] === 'npm' && parts[1] === 'run' && parts.length === 3 && /^[a-z0-9][a-z0-9:_-]*$/.test(parts[2])) {
    return ['/usr/bin/npm', 'run', parts[2]];
  }
  return unsupported(app, `command "${command}" is not a supported node or npm invocation`);
}

function simpleEnvironment(app, env = {}) {
  const entries = Object.entries(env || {});
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key) || !ENV_VALUE.test(String(value))) unsupported(app, `unit environment ${key} is not a simple value`);
  }
  return entries.map(([key, value]) => [key, String(value)]);
}

function schedule(app, timer) {
  const fields = {};
  for (const key of ['onCalendar', 'onBootSec', 'onUnitActiveSec', 'randomizedDelaySec']) {
    if (timer[key] == null) continue;
    if (!SCHEDULE_VALUE.test(String(timer[key]))) unsupported(app, `timer ${timer.timerName} has an unsupported ${key}`);
    fields[key] = String(timer[key]);
  }
  if (!fields.onCalendar && !fields.onBootSec && !fields.onUnitActiveSec) unsupported(app, `timer ${timer.timerName} has no schedule`);
  return fields;
}

function storageLayout(app) {
  const storage = app.storage || {};
  if (!storage.absoluteRoot) {
    if ((storage.paths || []).length) unsupported(app, 'storage paths inside the install root are not supported yet');
    return null;
  }
  const root = String(storage.absoluteRoot).replace(/\/+$/, '');
  // Exactly /var/lib/sovereign-home/<app id>/<leaf>: the <app id> parent is created root-owned, so no
  // sovereign-owned directory ever sits above a root-created one, and apps cannot claim each other's
  // roots or Home Base's own siblings (homebase, backups, git-mirrors, sovereign).
  const match = /^\/var\/lib\/sovereign-home\/([a-z][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9_-]{0,62})$/.exec(root);
  if (!match || match[1] !== app.id) unsupported(app, `storage root ${storage.absoluteRoot} must be /var/lib/sovereign-home/${app.id}/<name>`);
  const subpaths = [...new Set(storage.paths || [])];
  if (subpaths.some((subpath) => !STORAGE_SEGMENT.test(subpath))) unsupported(app, 'storage sub-paths must be single simple names');
  return { root, subpaths };
}

function appLayout(app, { catalogApps = require('../catalog').catalog } = {}) {
  if (!app || !NAME.test(app.id)) throw new OperationPlanError('POLICY_DENIED', 'Unknown or malformed catalog app.');
  if (!REPO_KEY.test(app.repoKey || '')) unsupported(app, 'catalog entry has no usable repoKey');
  if (app.runtime?.kind !== 'node') unsupported(app, `runtime ${app.runtime?.kind} is not supported by the executor yet`);
  if (app.runtime.installCommand !== 'npm ci --omit=dev') unsupported(app, 'only "npm ci --omit=dev" installs are supported');
  // Units live in systemd's global namespace; every unit an app writes is namespaced under its id so a
  // catalog entry can never replace a system unit (e.g. ssh.service) or another app's unit.
  const owned = (name) => NAME.test(name || '') && (name === app.id || name.startsWith(`${app.id}-`));
  const otherApps = catalogApps.filter((other) => other.id !== app.id);
  if (!owned(app.service?.name)) unsupported(app, 'service name must be the app id or start with it');
  // Sidecar ports are allocated deterministically only once they are reserved in the catalog.
  if (templatePlaceholders(app.config?.env).some((name) => name.startsWith('sidecar.'))) unsupported(app, 'env references sidecar ports, which the executor does not allocate yet');
  if (app.service.envFile && app.service.envFile !== '.env') unsupported(app, 'only .env env files are supported');
  const port = app.network?.preferredPort;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) unsupported(app, 'preferred port is invalid');
  if (!/^\/[a-z0-9-]+\/$/.test(app.network.preferredMountPath || '')) unsupported(app, 'mount path must look like /name/');
  if (!/^\/[A-Za-z0-9/_-]*$/.test(app.network.health?.readinessPath || '')) unsupported(app, 'readiness path is invalid');
  const clientMaxBodySize = app.network.clientMaxBodySize == null ? null : String(app.network.clientMaxBodySize);
  if (clientMaxBodySize != null && !/^[1-9][0-9]{0,3}[mM]$/.test(clientMaxBodySize)) unsupported(app, 'clientMaxBodySize must look like 55M');
  if (app.network.preserveMountPath || app.network.upstreamPath || (app.network.extraProxyHeaders || []).length) unsupported(app, 'custom nginx proxying is not supported yet');

  const database = app.database?.engine === 'postgres' ? {
    name: app.database.databaseName,
    user: app.database.databaseUser,
  } : null;
  if (app.database && !database) unsupported(app, `database engine ${app.database.engine} is not supported yet`);
  if (database && (!DB_IDENTIFIER.test(database.name || '') || !DB_IDENTIFIER.test(database.user || ''))) unsupported(app, 'database names must be simple identifiers');
  if (database && (RESERVED_DB.test(database.name) || RESERVED_DB.test(database.user))) unsupported(app, 'database names are reserved by PostgreSQL');
  if (database && otherApps.some((other) => other.database && [other.database.databaseName, other.database.databaseUser].some((value) => value === database.name || value === database.user))) {
    unsupported(app, 'database name or role is shared with another catalog app');
  }
  if (database && app.database.urlEnvKey && app.database.urlEnvKey !== 'DATABASE_URL') unsupported(app, 'custom database URL keys are not supported yet');

  const sidecars = (app.sidecars || []).map((sidecar) => {
    if (!owned(sidecar.name) || sidecar.name === app.service.name) unsupported(app, `sidecar name ${sidecar.name} must be unique and start with the app id`);
    if (sidecar.nginx) unsupported(app, `sidecar ${sidecar.name} publishes through nginx, which is not supported yet`);
    return { name: sidecar.name, unit: `${sidecar.name}.service`, description: String(sidecar.description || sidecar.name), argv: commandArgv(app, sidecar.execStart), environment: simpleEnvironment(app, sidecar.env) };
  });
  const timers = (app.timers || []).map((timer) => {
    if (!owned(timer.serviceName) || timer.timerName !== `${timer.serviceName}.timer`) unsupported(app, 'timer names must start with the app id and be <service>.timer');
    return { serviceName: timer.serviceName, serviceUnit: `${timer.serviceName}.service`, timerUnit: timer.timerName, description: String(timer.description || timer.serviceName), argv: commandArgv(app, timer.execStart), schedule: schedule(app, timer), persistent: timer.persistent !== false };
  });
  const packages = [...new Set(app.systemPackages || [])];
  if (packages.some((pkg) => !/^[a-z0-9][a-z0-9+.-]{0,62}$/.test(pkg))) unsupported(app, 'system package names are malformed');

  const checkout = path.posix.join(APPS_ROOT, app.repoKey);
  const unitNames = [`${app.service.name}.service`, ...sidecars.map((sidecar) => sidecar.unit), ...timers.flatMap((timer) => [timer.serviceUnit, timer.timerUnit])];
  if (new Set(unitNames).size !== unitNames.length) unsupported(app, 'unit names must be unique');
  return {
    app,
    checkout,
    envPath: path.posix.join(checkout, '.env'),
    mirror: path.posix.join(MIRROR_ROOT, `${app.repoKey}.git`),
    repositories: {
      https: app.repository.url,
      ssh: app.repository.sshUrl ? `ssh://${String(app.repository.sshUrl).replace(':', '/')}` : null,
    },
    port,
    mountPath: app.network.preferredMountPath,
    clientMaxBodySize,
    readinessPath: app.network.health.readinessPath,
    service: { name: app.service.name, unit: `${app.service.name}.service`, description: String(app.service.description || app.name), argv: commandArgv(app, app.runtime.startCommand) },
    sidecars,
    timers,
    database,
    migrationArgv: app.database?.migrationCommand ? commandArgv(app, app.database.migrationCommand) : null,
    storage: storageLayout(app),
    packages,
    nginxSnippet: `/etc/nginx/sovereign-home.d/${app.id}.conf`,
    unitNames,
  };
}

module.exports = { APPS_ROOT, MIRROR_ROOT, appLayout, commandArgv };
