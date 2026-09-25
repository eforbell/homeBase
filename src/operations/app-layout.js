const path = require('path');
const { OperationPlanError } = require('./validate');
const { templatePlaceholders } = require('./env');
const { catalogPorts } = require('../catalog');

// Everything the executor needs to know about an app's on-host shape, derived only from the
// root-owned catalog. Catalog values are trusted, but still validated here so a malformed entry
// fails closed instead of reaching a root operation.

const { APPS_ROOT, MIRROR_ROOT } = require('./paths');
// Postgres names that must never be managed as an app's role or database.
const RESERVED_DB = /^(postgres|template[01]|pg_.*)$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const DB_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const REPO_KEY = /^[A-Za-z][A-Za-z0-9]{0,62}$/;
const STORAGE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SCHEDULE_VALUE = /^[A-Za-z0-9_*:,./ -]{1,64}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENV_VALUE = /^[A-Za-z0-9_./:@-]{0,256}$/;
const VENV_TOOL = /^[a-z][a-z0-9._-]{0,62}$/;
// Arguments to venv tools: plain tokens (module:attr, flags, hosts, relative paths); never absolute paths.
const VENV_ARG = /^[A-Za-z0-9_.:=,@+-][A-Za-z0-9_.:=,@+/-]{0,127}$/;
const RELATIVE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,127}$/;
// In-checkout storage may be a dot-directory (helm's .secrets) but never something the install owns.
const CHECKOUT_STORAGE_SEGMENT = /^\.?[a-z0-9][a-z0-9_-]{0,62}$/;
const CHECKOUT_RESERVED = new Set(['.git', '.venv', '.env', 'node_modules']);
const PYTHON_PACKAGES = ['python3', 'python3-venv'];

function unsupported(app, message) { throw new OperationPlanError('POLICY_DENIED', `${app?.id || 'app'}: ${message}`); }

// Catalog commands become fixed argv. Only these shapes are accepted:
//   node <relative/script.js> [--flag ...]      npm run <script>      (node runtime)
//   .venv/bin/<tool> [token ...]                                       (python runtime)
// {{port}} is the only placeholder, resolved to the catalog port. Anything else (shell syntax, other
// binaries, absolute paths) is refused.
function commandArgv(app, command, { checkout, port } = {}) {
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
  if (parts[0].startsWith('.venv/bin/') && app.runtime?.kind === 'python' && checkout) {
    const tool = parts[0].slice('.venv/bin/'.length);
    if (!VENV_TOOL.test(tool)) unsupported(app, `unsupported venv tool in "${command}"`);
    const args = parts.slice(1).map((arg) => arg.replaceAll('{{port}}', String(port)));
    if (args.some((arg) => !VENV_ARG.test(arg) || arg.includes('..'))) unsupported(app, `unsupported arguments in "${command}"`);
    return [`${checkout}/.venv/bin/${tool}`, ...args];
  }
  return unsupported(app, `command "${command}" is not a supported node, npm, or venv invocation`);
}

// Typed replacement for the legacy runtime.installCommand shell string: pip installs a pinned
// requirements file and/or the checkout itself (editable), always into <checkout>/.venv.
function pythonInstall(app) {
  const spec = app.runtime.python || {};
  if (app.runtime.pythonVenv && app.runtime.pythonVenv !== '.venv') unsupported(app, 'the python venv must be .venv');
  const requirements = spec.requirements == null ? null : String(spec.requirements);
  if (requirements && (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}\.(lock|txt)$/.test(requirements))) unsupported(app, 'runtime.python.requirements must be a file name in the checkout root');
  if (!requirements && spec.editable !== true) unsupported(app, 'runtime.python needs requirements, editable, or both');
  return { requirements, editable: spec.editable === true, editableNoDeps: spec.editableNoDeps === true };
}

function runtimeLayout(app) {
  if (app.runtime?.kind === 'node') {
    if (app.runtime.installCommand !== 'npm ci --omit=dev') unsupported(app, 'only "npm ci --omit=dev" installs are supported');
    return { kind: 'node', nodeEnv: app.runtime.nodeEnv || 'production' };
  }
  if (app.runtime?.kind === 'python') return { kind: 'python', python: pythonInstall(app) };
  return unsupported(app, `runtime ${app.runtime?.kind} is not supported by the executor yet`);
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

function storageLayout(app, checkout) {
  const storage = app.storage || {};
  const subpaths = [...new Set(storage.paths || [])];
  if (!storage.absoluteRoot) {
    if (!subpaths.length) return null;
    // Inside the checkout: created and backed up as sovereign, removed with the checkout on uninstall.
    if (subpaths.some((subpath) => !CHECKOUT_STORAGE_SEGMENT.test(subpath) || CHECKOUT_RESERVED.has(subpath))) unsupported(app, 'in-checkout storage paths must be single simple names');
    return { root: checkout, subpaths, inCheckout: true };
  }
  const root = String(storage.absoluteRoot).replace(/\/+$/, '');
  // Exactly /var/lib/sovereign-home/<app id>/<leaf>: the <app id> parent is created root-owned, so no
  // sovereign-owned directory ever sits above a root-created one, and apps cannot claim each other's
  // roots or Home Base's own siblings (homebase, backups, git-mirrors, sovereign).
  const match = /^\/var\/lib\/sovereign-home\/([a-z][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9_-]{0,62})$/.exec(root);
  if (!match || match[1] !== app.id) unsupported(app, `storage root ${storage.absoluteRoot} must be /var/lib/sovereign-home/${app.id}/<name>`);
  if (subpaths.some((subpath) => !STORAGE_SEGMENT.test(subpath))) unsupported(app, 'storage sub-paths must be single simple names');
  return { root, subpaths, inCheckout: false };
}

// A sidecar published through nginx gets its own location under the app's mount path.
function sidecarNginx(app, sidecar) {
  if (!sidecar.nginx) return null;
  const { mountPathSuffix, upstreamPath = '/', ...rest } = sidecar.nginx;
  if (Object.keys(rest).length) unsupported(app, `sidecar ${sidecar.name} nginx supports only mountPathSuffix and upstreamPath`);
  if (!/^[a-z0-9-]+\/$/.test(mountPathSuffix || '')) unsupported(app, `sidecar ${sidecar.name} mountPathSuffix must look like name/`);
  if (!/^\/([a-z0-9-]+\/)*$/.test(upstreamPath)) unsupported(app, `sidecar ${sidecar.name} upstreamPath must look like /name/`);
  if (sidecar.port == null) unsupported(app, `sidecar ${sidecar.name} publishes through nginx and needs a reserved catalog port`);
  return { mountPath: `${app.network.preferredMountPath}${mountPathSuffix}`, upstreamPath };
}

function validPort(port) { return Number.isInteger(port) && port >= 1024 && port <= 65535; }

function appLayout(app, { catalogApps = require('../catalog').catalog } = {}) {
  if (!app || !NAME.test(app.id)) throw new OperationPlanError('POLICY_DENIED', 'Unknown or malformed catalog app.');
  if (!REPO_KEY.test(app.repoKey || '')) unsupported(app, 'catalog entry has no usable repoKey');
  const runtime = runtimeLayout(app);
  const checkout = path.posix.join(APPS_ROOT, app.repoKey);
  // Units live in systemd's global namespace; every unit an app writes is namespaced under its id so a
  // catalog entry can never replace a system unit (e.g. ssh.service) or another app's unit.
  const owned = (name) => NAME.test(name || '') && (name === app.id || name.startsWith(`${app.id}-`));
  const otherApps = catalogApps.filter((other) => other.id !== app.id);
  if (!owned(app.service?.name)) unsupported(app, 'service name must be the app id or start with it');
  if (app.service.envFile && app.service.envFile !== '.env') unsupported(app, 'only .env env files are supported');
  const port = app.network?.preferredPort;
  if (!validPort(port)) unsupported(app, 'preferred port is invalid');
  if (!/^\/[a-z0-9-]+\/$/.test(app.network.preferredMountPath || '')) unsupported(app, 'mount path must look like /name/');
  if (!/^\/[A-Za-z0-9/_-]*$/.test(app.network.health?.readinessPath || '')) unsupported(app, 'readiness path is invalid');
  const clientMaxBodySize = app.network.clientMaxBodySize == null ? null : String(app.network.clientMaxBodySize);
  if (clientMaxBodySize != null && !/^[1-9][0-9]{0,3}[mM]$/.test(clientMaxBodySize)) unsupported(app, 'clientMaxBodySize must look like 55M');
  if (app.network.upstreamPath || (app.network.extraProxyHeaders || []).length) unsupported(app, 'custom nginx upstream paths and headers are not supported yet');
  if (app.network.preserveMountPath != null && typeof app.network.preserveMountPath !== 'boolean') unsupported(app, 'preserveMountPath must be true or false');

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
  if (database && app.database.urlEnvKey && !/^[A-Z][A-Z0-9_]{0,40}DATABASE_URL$/.test(app.database.urlEnvKey)) unsupported(app, 'database URL keys must end in DATABASE_URL');
  if (database && !['migrations', 'schema-file', undefined].includes(app.database.bootstrap)) unsupported(app, `database bootstrap ${app.database.bootstrap} is not supported`);
  if (database && app.database.bootstrap === 'schema-file') {
    const file = String(app.database.schemaFile || '');
    if (!RELATIVE_FILE.test(file) || !file.endsWith('.sql') || file.includes('..')) unsupported(app, 'schema-file bootstrap needs database.schemaFile, a .sql path in the checkout');
    database.schemaFile = file;
  }

  // Ports: sidecar ports are reserved in the catalog (never allocated), and no two catalog apps share one.
  const ports = catalogPorts(app);
  if (ports.some((value) => !validPort(value))) unsupported(app, 'sidecar ports must be integers from 1024 to 65535');
  if (new Set(ports).size !== ports.length) unsupported(app, 'the app and its sidecars need distinct ports');
  if (otherApps.some((other) => catalogPorts(other).some((value) => ports.includes(value)))) unsupported(app, 'a port is shared with another catalog app');
  const sidecarNames = new Set((app.sidecars || []).map((sidecar) => sidecar.name));
  for (const name of templatePlaceholders(app.config?.env).filter((placeholder) => placeholder.startsWith('sidecar.'))) {
    const match = /^sidecar\.(.+)\.port$/.exec(name);
    const sidecar = match && sidecarNames.has(match[1]) ? app.sidecars.find((entry) => entry.name === match[1]) : null;
    if (!sidecar || sidecar.port == null) unsupported(app, `env placeholder {{${name}}} needs a sidecar with a reserved catalog port`);
  }

  const sidecars = (app.sidecars || []).map((sidecar) => {
    if (!owned(sidecar.name) || sidecar.name === app.service.name) unsupported(app, `sidecar name ${sidecar.name} must be unique and start with the app id`);
    return {
      name: sidecar.name,
      unit: `${sidecar.name}.service`,
      description: String(sidecar.description || sidecar.name),
      argv: commandArgv(app, sidecar.execStart, { checkout, port }),
      environment: simpleEnvironment(app, sidecar.env),
      port: sidecar.port ?? null,
      nginx: sidecarNginx(app, sidecar),
    };
  });
  const timers = (app.timers || []).map((timer) => {
    if (!owned(timer.serviceName) || timer.timerName !== `${timer.serviceName}.timer`) unsupported(app, 'timer names must start with the app id and be <service>.timer');
    return { serviceName: timer.serviceName, serviceUnit: `${timer.serviceName}.service`, timerUnit: timer.timerName, description: String(timer.description || timer.serviceName), argv: commandArgv(app, timer.execStart, { checkout, port }), schedule: schedule(app, timer), persistent: timer.persistent !== false };
  });
  const packages = [...new Set([...(app.systemPackages || []), ...(runtime.kind === 'python' ? PYTHON_PACKAGES : [])])];
  if (packages.some((pkg) => !/^[a-z0-9][a-z0-9+.-]{0,62}$/.test(pkg))) unsupported(app, 'system package names are malformed');

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
    runtime,
    port,
    mountPath: app.network.preferredMountPath,
    preserveMountPath: app.network.preserveMountPath === true,
    clientMaxBodySize,
    readinessPath: app.network.health.readinessPath,
    service: { name: app.service.name, unit: `${app.service.name}.service`, description: String(app.service.description || app.name), argv: commandArgv(app, app.runtime.startCommand, { checkout, port }) },
    sidecars,
    timers,
    database,
    migrationArgv: app.database?.migrationCommand ? commandArgv(app, app.database.migrationCommand, { checkout, port }) : null,
    storage: storageLayout(app, checkout),
    packages,
    nginxSnippet: `/etc/nginx/sovereign-home.d/${app.id}.conf`,
    unitNames,
  };
}

module.exports = { APPS_ROOT, MIRROR_ROOT, appLayout, commandArgv };
