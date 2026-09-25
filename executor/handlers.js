const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { ProtocolError } = require('./protocol');
const { runApproved } = require('./spawn');
const { catalog } = require('../src/catalog');
const { gitTransportForRepository, BOOTSTRAP_PACKAGES } = require('../src/operations/policy');
const { MIRROR_ROOT } = require('../src/operations/app-layout');
const { hostSupport } = require('../src/operations/host-support');
const { parseDotEnv, renderEnv, renderAppEnv, hasExistingDbConfig, resolveExistingDbContext } = require('../src/operations/env');

// Fixed host directories. App-specific ones (app-install, app-storage-root, app-storage) come from
// the plan target's catalog layout; see directoryFor().
const DIRECTORY_PATHS = Object.freeze({
  'sovereign-root': '/opt/sovereign-home',
  'app-root': '/opt/sovereign-home/apps',
  'backup-root': '/var/lib/sovereign-home/backups',
  'config-root': '/etc/sovereign-home',
  'nginx-snippets': '/etc/nginx/snippets',
  'nginx-apps': '/etc/nginx/sovereign-home.d',
  'sovereign-home': '/var/lib/sovereign-home/sovereign',
});
// /opt/sovereign-home also holds the root executor's own code (/opt/sovereign-home/homebase). The owner
// of a directory can rename its entries, so it must stay root-owned; only apps/ belongs to sovereign.
const ROOT_OWNED_DIRECTORIES = new Set(['sovereign-root', 'config-root', 'nginx-snippets', 'nginx-apps']);
const DIRECTORY_MODES = Object.freeze({ 'sovereign-home': 0o700, 'app-storage-root': 0o750, 'app-storage': 0o750 });
// HOME for git/npm children: sovereign-writable (npm cache) without owning any root-controlled path.
const SOVEREIGN_HOME = DIRECTORY_PATHS['sovereign-home'];

// Operator-provisioned by `install.sh --git-ssh-key`; root-owned and only ever read by root's ssh.
const GIT_DEPLOY_KEY_PATH = '/etc/sovereign-home/git/deploy_key';
const GIT_KNOWN_HOSTS_PATH = '/etc/sovereign-home/git/known_hosts';
// System-scope git config for sovereign's git: the only scope git's upload-pack honours for safe.directory,
// which sovereign needs to read the deliberately root-owned mirrors. Root-owned, world-readable, and
// derived from the catalog so every app's mirror is listed.
const SOVEREIGN_GITCONFIG_PATH = '/etc/sovereign-home/sovereign.gitconfig';
const SOVEREIGN_GITCONFIG = `[safe]\n${catalog.filter((app) => /^[A-Za-z][A-Za-z0-9]*$/.test(app.repoKey || '')).map((app) => `\tdirectory = ${MIRROR_ROOT}/${app.repoKey}.git\n`).join('')}`;
// Pinned from https://api.github.com/meta; verified against GitHub's published SHA256 fingerprints.
const GITHUB_KNOWN_HOSTS = [
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
].join('\n');

const NGINX_GATEWAY_SITE = '/etc/nginx/sites-available/sovereign-home';
const NGINX_GATEWAY_LINK = '/etc/nginx/sites-enabled/sovereign-home';
const NGINX_DEFAULT_LINK = '/etc/nginx/sites-enabled/default';
const NGINX_GATEWAY_CONTENT = [
  '# Managed by Home Base. Tailscale forwards :443 here; apps mount from sovereign-home.d.',
  'server {',
  '    listen 80 default_server;',
  '    listen [::]:80 default_server;',
  '    listen 443 ssl default_server;',
  '    listen [::]:443 ssl default_server;',
  '    server_name _;',
  '    include snippets/snakeoil.conf;',
  '    include /etc/nginx/sovereign-home.d/*.conf;',
  '}',
  '',
].join('\n');

const ROOT_ENV = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' });
const APT_ENV = Object.freeze({ ...ROOT_ENV, DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' });
const APT_DPKG_OPTIONS = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];

function deny(message) { throw new ProtocolError('POLICY_DENIED', message); }

function lookupSystemUser(name, fsImpl = fs) {
  try {
    const row = fsImpl.readFileSync('/etc/passwd', 'utf8').split('\n').find((line) => line.startsWith(`${name}:`));
    if (!row) return null;
    const fields = row.split(':');
    const uid = Number.parseInt(fields[2], 10);
    const gid = Number.parseInt(fields[3], 10);
    return Number.isInteger(uid) && Number.isInteger(gid) ? { uid, gid } : null;
  } catch { return null; }
}

function lstatOrNull(fsImpl, target) {
  try { return fsImpl.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Temporarily assume an unprivileged identity for synchronous filesystem work inside a directory that
// identity controls, so the kernel (not path checks racing a hostile owner) enforces what root touches.
// Only synchronous calls are safe inside `fn`: glibc applies set*id to every thread, so async libuv work
// in flight would also run under the borrowed identity.
function runAsUser(user, fn, processImpl = process) {
  const originalGroups = processImpl.getgroups();
  const originalGid = processImpl.getegid();
  try {
    processImpl.setgroups([user.gid]);
    processImpl.setegid(user.gid);
    processImpl.seteuid(user.uid);
    return fn();
  } finally {
    // Restore unconditionally so a failed switch can never leave the executor half-dropped.
    processImpl.seteuid(0);
    processImpl.setegid(originalGid);
    processImpl.setgroups(originalGroups);
  }
}

// Reads a small regular file inside a sovereign-controlled directory. O_NOFOLLOW refuses a planted
// symlink, O_NONBLOCK keeps a planted FIFO from blocking the executor, and the size cap bounds memory.
// Returns null when the path is missing, a symlink, or not a regular file.
function readSmallFileNoFollow(fsImpl, target, limit = 64 * 1024) {
  let fd;
  try {
    fd = fsImpl.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
  try {
    if (!fsImpl.fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    for (let read = -1; read !== 0 && bytes <= limit;) {
      read = fsImpl.readSync(fd, buffer, bytes, limit + 1 - bytes, bytes);
      bytes += read;
    }
    if (bytes > limit) deny(`${target} is larger than ${limit} bytes.`);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally { fsImpl.closeSync(fd); }
}

function writeFileAtomic(fsImpl, destination, content, mode) {
  const parent = path.dirname(destination);
  if (!fsImpl.existsSync(parent) || fsImpl.realpathSync(parent) !== parent) deny('Managed file parent is missing or a symlink.');
  const existing = lstatOrNull(fsImpl, destination);
  if (existing && !existing.isFile()) deny('Managed file destination is not a regular file.');
  const temp = `${destination}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fsImpl.openSync(temp, 'wx', mode);
  try {
    try {
      fsImpl.writeSync(fd, content);
      fsImpl.fchmodSync(fd, mode);
      fsImpl.fsyncSync(fd);
    } finally { fsImpl.closeSync(fd); }
    fsImpl.renameSync(temp, destination);
  } catch (error) {
    try { fsImpl.unlinkSync(temp); } catch {}
    throw error;
  }
}

function assertDatabasePassword(password) {
  if (typeof password !== 'string' || !password) throw new ProtocolError('SECRET_BINDING_MISSING', 'The database password is missing.');
  // Printable, whitespace-free ASCII keeps the password safe for psql's line-oriented stdin and .env lines.
  if (!/^[\x21-\x7e]{8,256}$/.test(password)) deny('The database password must be 8-256 printable non-space ASCII characters.');
  return password;
}

function requireLayout(layout) {
  if (!layout) deny('This operation needs an app-install plan target.');
  return layout;
}

const FONT_ASSETS_DIR = '/opt/sovereign-home/assets/fonts';
const GOOGLE_FONT_SANS_CSS_URL = 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap';
const GOOGLE_FONT_MONO_CSS_URL = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap';

// Render context equivalent to the legacy planner's for the same inputs (see test/env-parity.test.js).
// Secrets are fresh candidates only: the shared reinstall contract keeps any existing secret values.
function buildEnvContext({ layout, site, databaseUrl, dbPassword, fsImpl = fs, randomHex = () => crypto.randomBytes(32).toString('hex') }) {
  const publicBase = `https://${site.hostname}.${site.domain}`;
  const localFonts = fsImpl.existsSync(`${FONT_ASSETS_DIR}/source-sans-3.css`) && fsImpl.existsSync(`${FONT_ASSETS_DIR}/jetbrains-mono.css`);
  // Sidecar ports are reserved in the catalog (app-layout.js); legacy's port + 1 allocation lands on the same values.
  const sidecarPorts = Object.fromEntries(layout.sidecars.filter((sidecar) => sidecar.port != null).map((sidecar) => [sidecar.name, sidecar.port]));
  return {
    port: layout.port,
    mountPath: layout.mountPath,
    externalUrl: `${publicBase}${layout.mountPath}`,
    publicUrl: `${publicBase}${layout.mountPath}`,
    databaseUrl,
    dbPassword,
    dbUser: layout.database?.user,
    dbName: layout.database?.name,
    secret1: randomHex(),
    secret2: randomHex(),
    secret3: randomHex(),
    householdTimezone: site.householdTimezone,
    sidecarPorts,
    sovereignFontSource: localFonts ? 'local' : 'google',
    sovereignFontSansCssUrl: GOOGLE_FONT_SANS_CSS_URL,
    sovereignFontMonoCssUrl: GOOGLE_FONT_MONO_CSS_URL,
    sovereignFontSansCssUrlLocal: `${publicBase}/_sovereign/fonts/source-sans-3.css`,
    sovereignFontMonoCssUrlLocal: `${publicBase}/_sovereign/fonts/jetbrains-mono.css`,
  };
}

// The shared reinstall contract (src/operations/env.js), rendered strictly. NODE_ENV is written into
// .env because the app reads it after dotenv loads; interpreter-level settings (TZ, PYTHONUNBUFFERED)
// must exist before the process starts, so those live in the unit instead (renderServiceUnit).
function renderAppEnvFile({ layout, password = null, site, existingContent = '', fsImpl = fs }) {
  const { app } = layout;
  const existing = existingContent ? parseDotEnv(existingContent) : null;
  const dbPassword = layout.database ? assertDatabasePassword(password) : undefined;
  const databaseUrl = layout.database
    ? `postgresql://${layout.database.user}:${encodeURIComponent(dbPassword)}@127.0.0.1:5432/${layout.database.name}`
    : undefined;
  const ctx = buildEnvContext({ layout, site, databaseUrl, dbPassword, fsImpl });
  let env;
  try {
    ({ env } = renderAppEnv({ app, ctx, existing, strict: true }));
  } catch (error) {
    if (error.code === 'ENV_TEMPLATE_UNRESOLVED') deny(error.message);
    throw error;
  }
  return renderEnv(layout.runtime.kind === 'node' ? { ...env, NODE_ENV: layout.runtime.nodeEnv } : env);
}

// The database password this install must use. Existing database wiring is kept verbatim by the
// reinstall contract, so the role password has to come from it; otherwise updates would rotate
// credentials under a running service. Read as sovereign (the .env sits in a sovereign-owned
// directory). Returns null when there is no existing wiring; refuses wiring that points elsewhere.
function readExistingDatabasePassword({ layout, fsImpl = fs, lookupUser = (name) => lookupSystemUser(name, fsImpl), asUser = runAsUser } = {}) {
  if (!layout?.database) return null;
  const sovereign = lookupUser('sovereign');
  if (!sovereign) return null;
  const content = asUser(sovereign, () => readSmallFileNoFollow(fsImpl, layout.envPath));
  if (!content) return null;
  const existing = parseDotEnv(content);
  if (!hasExistingDbConfig(existing, layout.app)) return null;
  const db = resolveExistingDbContext(existing, {}, layout.app);
  if (db.dbUser !== layout.database.user || db.dbName !== layout.database.name) {
    deny(`The existing ${layout.app.name} DATABASE_URL targets ${db.dbUser || '?'}@${db.dbName || '?'}; the executor manages ${layout.database.user}@${layout.database.name}. Fix the .env or move the data before reinstalling.`);
  }
  return assertDatabasePassword(db.dbPassword);
}

// systemd expands %-specifiers and treats newlines as syntax; catalog text is reduced to safe text.
function unitText(value) {
  // Backslashes are dropped too: a trailing one would join the next unit line.
  return String(value).replace(/[^\x20-\x7e]|\\/g, '').replaceAll('%', '%%').slice(0, 120);
}

const TIMEZONE = /^[A-Za-z_]+\/[A-Za-z_/-]+$/;

// No EnvironmentFile=: systemd would read the sovereign-owned .env as root before dropping to User=,
// letting a planted symlink expose root-only files. Apps load .env themselves (see the runbook).
// Environment= carries only fixed values: the household TZ (validated), PYTHONUNBUFFERED for Python
// apps, and the catalog's simple sidecar values.
function renderServiceUnit({ layout, description, argv, timezone, environment = [], oneshot = false }) {
  if (!TIMEZONE.test(timezone || '') || timezone.length > 64) deny('Service units need a valid household timezone.');
  const runtimeEnvironment = [['TZ', timezone], ...(layout.runtime.kind === 'python' ? [['PYTHONUNBUFFERED', '1']] : [])];
  return [
    '[Unit]',
    `Description=${unitText(description)}`,
    `After=network.target${layout.database ? ' postgresql.service' : ''}`,
    '',
    '[Service]',
    `Type=${oneshot ? 'oneshot' : 'simple'}`,
    'User=sovereign',
    `WorkingDirectory=${layout.checkout}`,
    ...[...runtimeEnvironment, ...environment].map(([key, value]) => `Environment=${key}=${value}`),
    `ExecStart=${argv.join(' ')}`,
    ...(oneshot ? [] : ['Restart=on-failure', 'RestartSec=5']),
    'UMask=0077',
    'NoNewPrivileges=yes',
    ...(oneshot ? [] : ['', '[Install]', 'WantedBy=multi-user.target']),
    '',
  ].join('\n');
}

function renderTimerUnit({ timer }) {
  const { onCalendar, onBootSec, onUnitActiveSec, randomizedDelaySec } = timer.schedule;
  return [
    '[Unit]',
    `Description=${unitText(timer.description)}`,
    '',
    '[Timer]',
    ...(onCalendar ? [`OnCalendar=${onCalendar}`] : []),
    ...(onBootSec ? [`OnBootSec=${onBootSec}`] : []),
    ...(onUnitActiveSec ? [`OnUnitActiveSec=${onUnitActiveSec}`] : []),
    ...(randomizedDelaySec ? [`RandomizedDelaySec=${randomizedDelaySec}`] : []),
    `Persistent=${timer.persistent ? 'true' : 'false'}`,
    `Unit=${timer.serviceUnit}`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

function nginxLocation({ mountPath, upstream, clientMaxBodySize = null }) {
  const base = mountPath.replace(/\/$/, '');
  return [
    `location = ${base} {`,
    `    return 301 ${mountPath};`,
    '}',
    `location ${mountPath} {`,
    ...(clientMaxBodySize ? [`    client_max_body_size ${clientMaxBodySize};`] : []),
    `    proxy_pass ${upstream};`,
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    `    proxy_set_header X-Forwarded-Prefix ${base};`,
    '}',
  ];
}

// preserveMountPath passes /mount/... through unchanged (proxy_pass without a URI); otherwise nginx
// strips the mount path. Published sidecars get their own, longer (so more specific) location.
function renderNginxSnippet({ layout }) {
  return [
    `# ${layout.app.id}`,
    ...nginxLocation({ mountPath: layout.mountPath, upstream: `http://127.0.0.1:${layout.port}${layout.preserveMountPath ? '' : '/'}`, clientMaxBodySize: layout.clientMaxBodySize }),
    ...layout.sidecars.filter((sidecar) => sidecar.nginx).flatMap((sidecar) => [
      `# ${sidecar.name}`,
      ...nginxLocation({ mountPath: sidecar.nginx.mountPath, upstream: `http://127.0.0.1:${sidecar.port}${sidecar.nginx.upstreamPath}` }),
    ]),
    '',
  ].join('\n');
}

function renderManagedFile(operation, { secretBindings = {}, layout } = {}) {
  requireLayout(layout);
  const unitPath = (unit) => `/etc/systemd/system/${unit}`;
  switch (operation.template) {
    case 'app-env-v1':
      return {
        path: layout.envPath, mode: 0o640, owner: 'sovereign',
        render: ({ existingContent, fsImpl }) => renderAppEnvFile({ layout, password: layout.database ? secretBindings.databasePassword : null, site: operation.site, existingContent, fsImpl }),
      };
    case 'app-service-v1':
      if (operation.unit !== layout.service.unit) break;
      return { path: unitPath(operation.unit), mode: 0o644, owner: 'root', content: renderServiceUnit({ layout, description: layout.service.description, argv: layout.service.argv, timezone: operation.timezone }) };
    case 'app-sidecar-service-v1': {
      const sidecar = layout.sidecars.find((entry) => entry.unit === operation.unit);
      if (!sidecar) break;
      return { path: unitPath(sidecar.unit), mode: 0o644, owner: 'root', content: renderServiceUnit({ layout, description: sidecar.description, argv: sidecar.argv, timezone: operation.timezone, environment: sidecar.environment }) };
    }
    case 'app-timer-service-v1': {
      const timer = layout.timers.find((entry) => entry.serviceUnit === operation.unit);
      if (!timer) break;
      return { path: unitPath(timer.serviceUnit), mode: 0o644, owner: 'root', content: renderServiceUnit({ layout, description: timer.description, argv: timer.argv, timezone: operation.timezone, oneshot: true }) };
    }
    case 'app-timer-v1': {
      const timer = layout.timers.find((entry) => entry.timerUnit === operation.unit);
      if (!timer) break;
      return { path: unitPath(timer.timerUnit), mode: 0o644, owner: 'root', content: renderTimerUnit({ timer }) };
    }
    case 'app-nginx-v1':
      return { path: layout.nginxSnippet, mode: 0o644, owner: 'root', content: renderNginxSnippet({ layout }) };
    default:
      break;
  }
  return deny('Managed file template is not allowed for this app.');
}

function deployKeyStatus(fsImpl = fs) {
  try {
    const stat = lstatOrNull(fsImpl, GIT_DEPLOY_KEY_PATH);
    if (!stat) return 'missing';
    return stat.isFile() && stat.uid === 0 && (stat.mode & 0o077) === 0 ? 'present' : 'insecure';
  } catch { return 'missing'; }
}

// Network fetches run as root into a root-owned bare mirror, so the deploy key never leaves root and no
// sovereign-controlled hook, config, or process can observe it. Hooks and fsmonitor are disabled even
// though nothing but root can write the mirror.
const ROOT_GIT_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

function rootGitEnvironment(transport, fsImpl) {
  const env = { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C', GIT_TERMINAL_PROMPT: '0' };
  if (transport !== 'ssh') return env;
  const keyStat = lstatOrNull(fsImpl, GIT_DEPLOY_KEY_PATH);
  if (!keyStat || !keyStat.isFile()) deny(`SSH git transport requires a deploy key at ${GIT_DEPLOY_KEY_PATH}; provision it with install.sh --git-ssh-key.`);
  if (keyStat.uid !== 0 || (keyStat.mode & 0o077) !== 0) deny(`${GIT_DEPLOY_KEY_PATH} must be owned by root with mode 0600.`);
  const knownHosts = fsImpl.existsSync(GIT_KNOWN_HOSTS_PATH) ? fsImpl.readFileSync(GIT_KNOWN_HOSTS_PATH, 'utf8') : null;
  if (knownHosts !== `${GITHUB_KNOWN_HOSTS}\n`) writeFileAtomic(fsImpl, GIT_KNOWN_HOSTS_PATH, `${GITHUB_KNOWN_HOSTS}\n`, 0o644);
  env.GIT_SSH_COMMAND = `/usr/bin/ssh -F /dev/null -i ${GIT_DEPLOY_KEY_PATH} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${GIT_KNOWN_HOSTS_PATH} -o GlobalKnownHostsFile=/dev/null`;
  return env;
}

function directoryFor(operation, layout) {
  if (Object.hasOwn(DIRECTORY_PATHS, operation.purpose)) return DIRECTORY_PATHS[operation.purpose];
  if (operation.purpose === 'app-install') return requireLayout(layout).checkout;
  if (operation.purpose === 'app-storage-root' || operation.purpose === 'app-storage') {
    const storage = requireLayout(layout).storage;
    if (!storage) deny('This app declares no storage.');
    // In-checkout storage sits under sovereign-owned directories; only app-checkout-storage (as sovereign) may create it.
    if (storage.inCheckout) deny('This app keeps its storage in the checkout.');
    if (operation.purpose === 'app-storage-root') return storage.root;
    if (!storage.subpaths.includes(operation.subpath)) deny('Storage subpath is not declared by this app.');
    return `${storage.root}/${operation.subpath}`;
  }
  return deny('Unknown managed directory purpose.');
}

function createBaseHandlers({ platform = process.platform, fsImpl = fs, run = runApproved, lookupUser = (name) => lookupSystemUser(name, fsImpl), asUser = runAsUser } = {}) {
  const rootIdentity = { uid: 0, gid: 0 };
  // dpkg-query exits non-zero when any name is unknown but still reports the known ones on stdout.
  const missingPackages = async (packages, timeoutMs) => {
    let stdout = '';
    try {
      stdout = (await run({ binary: '/usr/bin/dpkg-query', args: ['-W', '-f=${Package} ${db:Status-Abbrev}\n', ...packages], ...rootIdentity, timeoutMs, env: ROOT_ENV })).stdout;
    } catch (error) {
      if (error.code !== 'OPERATION_FAILED') throw error;
      stdout = error.output?.stdout || '';
    }
    const installed = new Set(String(stdout).split('\n').map((line) => line.trim().split(/\s+/)).filter(([, status]) => status === 'ii').map(([name]) => name));
    // NodeSource's nodejs ships npm itself; apt's npm package would conflict with it.
    if (installed.has('nodejs') && fsImpl.existsSync('/usr/bin/npm')) installed.add('npm');
    return packages.filter((pkg) => !installed.has(pkg));
  };
  return {
    'host.assert-debian-family': async () => {
      if (platform !== 'linux') deny('Executor requires a Linux Debian-family host.');
      const host = hostSupport(fsImpl.readFileSync('/etc/os-release', 'utf8'));
      if (!host.supported) deny(`Executor requires Ubuntu 22.04+, Debian 12+, or a derivative of them; found ${host.name}.`);
      return `supported host: ${host.name} (${host.base} base)`;
    },
    'package.ensure': async (operation, { layout } = {}) => {
      const allowed = new Set([...BOOTSTRAP_PACKAGES, ...(layout?.packages || [])]);
      if (!operation.packages.every((pkg) => allowed.has(pkg))) deny('Package is not in the compiled policy allowlist.');
      // Only missing packages go to apt. Reinstalling present ones is at best a no-op and at worst
      // breaks the host: NodeSource's nodejs bundles npm (apt's npm then conflicts), and a PGDG host
      // would pull a newer PostgreSQL meta-version.
      const missing = await missingPackages(operation.packages, operation.timeoutMs);
      if (!missing.length) return `all ${operation.packages.length} approved packages already installed`;
      if (operation.updateCache) await run({ binary: '/usr/bin/apt-get', args: ['update'], ...rootIdentity, timeoutMs: operation.timeoutMs, env: APT_ENV });
      await run({ binary: '/usr/bin/apt-get', args: ['install', '--yes', '--no-install-recommends', ...APT_DPKG_OPTIONS, ...missing], ...rootIdentity, timeoutMs: operation.timeoutMs, env: APT_ENV });
      return `installed ${missing.join(', ')} (${operation.packages.length - missing.length} already present)`;
    },
    'identity.ensure-user': async (operation) => {
      if (operation.user !== 'sovereign') deny('Only the sovereign identity may be created.');
      const user = lookupUser('sovereign');
      if (user) return 'sovereign identity already exists';
      await run({ binary: '/usr/sbin/useradd', args: ['--system', '--home-dir', SOVEREIGN_HOME, '--shell', '/usr/sbin/nologin', 'sovereign'], ...rootIdentity, timeoutMs: operation.timeoutMs, env: ROOT_ENV });
      return 'created sovereign identity';
    },
    'git.sync': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const sovereign = lookupUser('sovereign');
      if (!sovereign) deny('The sovereign identity must exist before Git synchronization.');
      const transport = gitTransportForRepository(layout, operation.repository);
      if (!transport || !/^(main|[a-f0-9]{40})$/.test(operation.ref)) deny('Git operation does not match this app.');
      const { checkout: destination, mirror } = layout;
      const label = layout.app.name;

      // 1. Root refreshes the mirror from the network (credentials, if any, stay with root).
      const rootEnv = rootGitEnvironment(transport, fsImpl);
      const rootGit = (args) => run({ binary: '/usr/bin/git', args: [...ROOT_GIT_CONFIG, ...args], ...rootIdentity, timeoutMs: operation.timeoutMs, env: rootEnv });
      const mirrorParent = path.dirname(mirror);
      if (!fsImpl.existsSync(mirrorParent)) fsImpl.mkdirSync(mirrorParent, { recursive: true, mode: 0o755 });
      if (!lstatOrNull(fsImpl, mirror)) {
        await rootGit(['clone', '--mirror', operation.repository, mirror]);
      } else {
        await rootGit(['-C', mirror, 'remote', 'set-url', 'origin', operation.repository]);
        await rootGit(['-C', mirror, 'fetch', '--prune', 'origin']);
      }

      // 2. Sovereign updates the checkout from the local mirror only; it never touches the network or a key.
      const env = { PATH: '/usr/bin:/bin', HOME: SOVEREIGN_HOME, LANG: 'C', GIT_TERMINAL_PROMPT: '0' };
      // The mirror is root-owned by design (sovereign must not be able to plant config that root's fetch
      // would read), so sovereign's git gets a safe.directory exception through a managed system config.
      const currentConfig = fsImpl.existsSync(SOVEREIGN_GITCONFIG_PATH) ? fsImpl.readFileSync(SOVEREIGN_GITCONFIG_PATH, 'utf8') : null;
      if (currentConfig !== SOVEREIGN_GITCONFIG) writeFileAtomic(fsImpl, SOVEREIGN_GITCONFIG_PATH, SOVEREIGN_GITCONFIG, 0o644);
      env.GIT_CONFIG_SYSTEM = SOVEREIGN_GITCONFIG_PATH;
      const git = (args) => run({ binary: '/usr/bin/git', args, uid: sovereign.uid, gid: sovereign.gid, timeoutMs: operation.timeoutMs, env });
      const existingCheckout = lstatOrNull(fsImpl, path.join(destination, '.git'));
      if (!existingCheckout) {
        // ensure-install-root creates the destination first; git clones into an existing directory only when it is empty.
        if (fsImpl.existsSync(destination) && fsImpl.readdirSync(destination).length) deny(`${label} install directory is not empty and is not a Git checkout.`);
        await git(['clone', '--origin', 'origin', '--no-checkout', mirror, destination]);
      } else {
        if (!existingCheckout.isDirectory()) deny(`${label} checkout metadata is not a directory.`);
        // Untracked files (runtime caches, operator notes) never block: a fast-forward cannot overwrite
        // them, and git refuses on its own if an incoming commit adds the same path.
        const status = await git(['-C', destination, 'status', '--porcelain', '--untracked-files=no']);
        if (String(status.stdout || '').trim()) deny(`${label} checkout is dirty; refusing to overwrite operator changes.`);
        await git(['-C', destination, 'remote', 'set-url', 'origin', mirror]);
        await git(['-C', destination, 'fetch', 'origin']);
      }
      if (operation.ref === 'main') {
        // First install has no local branch yet; later runs fast-forward and refuse divergent history.
        if (!existingCheckout) await git(['-C', destination, 'checkout', '-B', 'main', 'origin/main']);
        else await git(['-C', destination, 'merge', '--ff-only', 'origin/main']);
      } else {
        await git(['-C', destination, 'checkout', '--detach', operation.ref]);
      }
      return `synchronized ${label} repository over ${transport}`;
    },
    'runtime.run-app-task': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const sovereign = lookupUser('sovereign');
      if (!sovereign) deny('The sovereign identity must exist before running app tasks.');
      // libuv chdirs before dropping to sovereign, and sovereign owns the parent directory: refuse a
      // checkout that is not a real sovereign-owned directory right before each spawn.
      const assertCheckout = () => {
        const checkoutStat = lstatOrNull(fsImpl, layout.checkout);
        if (!checkoutStat || checkoutStat.isSymbolicLink() || !checkoutStat.isDirectory() || checkoutStat.uid !== sovereign.uid) deny(`${layout.app.name} checkout is not a sovereign-owned directory.`);
      };
      assertCheckout();
      const env = { PATH: '/usr/bin:/bin', HOME: SOVEREIGN_HOME, LANG: 'C', ...(layout.runtime.kind === 'node' ? { NODE_ENV: layout.runtime.nodeEnv } : {}) };
      // Every argv is fixed by the catalog layout; the plan only names the task.
      const runApp = ([binary, ...args], extra = {}) => assertCheckout() ?? run({ binary, args, uid: sovereign.uid, gid: sovereign.gid, cwd: layout.checkout, timeoutMs: operation.timeoutMs, env, ...extra });
      const venvPython = `${layout.checkout}/.venv/bin/python`;
      const outputs = [];
      const collect = (result) => { const text = String(result.stdout || '').trim(); if (text) outputs.push(text); };

      if (operation.task === 'ensure-venv') {
        if (layout.runtime.kind !== 'python') deny('Only Python apps have a virtualenv.');
        const current = String((await runApp(['/usr/bin/python3', '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'])).stdout || '').trim();
        if (!/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(current)) deny('Could not read the system Python version.');
        const { minVersion } = layout.runtime.python;
        const [major, minor] = current.split('.').map(Number);
        const [needMajor, needMinor] = String(minVersion || '0.0').split('.').map(Number);
        if (major < needMajor || (major === needMajor && minor < needMinor)) deny(`${layout.app.name} needs Python ${minVersion} or newer; this host has ${current}.`);
        const existing = asUser(sovereign, () => ({
          config: readSmallFileNoFollow(fsImpl, `${layout.checkout}/.venv/pyvenv.cfg`, 4096),
          python: Boolean(lstatOrNull(fsImpl, venvPython)),
        }));
        const version = existing.config ? (/^version(?:_info)?\s*=\s*([0-9]+\.[0-9]+\.[0-9]+)/m.exec(existing.config) || [])[1] : null;
        if (version === current && existing.python) return `virtualenv ready (Python ${current})`;
        // A venv is bound to the interpreter that built it: rebuild it rather than repair it in place.
        await runApp(['/usr/bin/python3', '-m', 'venv', ...(existing.config ? ['--clear'] : []), '.venv']);
        return existing.config ? `rebuilt virtualenv for Python ${current} (was ${version || 'unknown'})` : `created virtualenv (Python ${current})`;
      }
      if (operation.task === 'install-dependencies') {
        if (layout.runtime.kind === 'node') collect(await runApp(['/usr/bin/npm', 'ci', '--omit=dev']));
        else {
          const { requirements, editable, editableNoDeps } = layout.runtime.python;
          const pip = [venvPython, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--progress-bar', 'off', '--timeout', '30', '--retries', '2'];
          if (requirements) collect(await runApp([...pip, '-r', requirements]));
          if (editable) collect(await runApp([...pip, ...(editableNoDeps ? ['--no-deps'] : []), '-e', '.']));
        }
      } else if (operation.task === 'migrate') {
        if (!layout.migrationArgv) deny('This app declares no migrations.');
        collect(await runApp(layout.migrationArgv));
      } else if (operation.task === 'bootstrap-schema') {
        if (!layout.database?.schemaFile) deny('This app declares no schema file.');
        // As the app role (so it owns its tables), only while the database is empty (the schema file is
        // not idempotent), and all-or-nothing.
        const password = readExistingDatabasePassword({ layout, fsImpl, lookupUser, asUser });
        if (!password) deny(`${layout.app.name} has no database wiring in its .env.`);
        const pgEnv = { ...env, PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: layout.database.user, PGDATABASE: layout.database.name, PGPASSWORD: password };
        // -X: never read sovereign's ~/.psqlrc.
        const psql = (args) => runApp(['/usr/bin/psql', '-X', '--no-password', '-v', 'ON_ERROR_STOP=1', ...args], { env: pgEnv, secrets: [password] });
        const count = String((await psql(['-tA', '-c', "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')"])).stdout || '').trim();
        if (!/^[0-9]{1,9}$/.test(count)) deny('Could not count the objects in the app database.');
        if (count !== '0') return `database already has ${count} objects; schema file not re-run`;
        await psql(['-1', '-q', '-f', layout.database.schemaFile]);
        return `created tables from ${layout.database.schemaFile}`;
      } else {
        deny('Unsupported app task.');
      }
      // Keep success output well under the protocol's 64 KiB event line limit.
      const output = outputs.join('\n');
      return output ? output.slice(-8 * 1024) : `completed ${operation.task}`;
    },
    'postgres.ensure-role': async (operation, { secretBindings = {}, layout } = {}) => {
      requireLayout(layout);
      const postgres = lookupUser('postgres');
      if (!postgres || !layout.database || operation.role !== layout.database.user || operation.passwordSecretRef !== 'databasePassword') deny('PostgreSQL role operation does not match this app.');
      const password = assertDatabasePassword(secretBindings.databasePassword);
      const role = layout.database.user; // validated simple identifier (app-layout.js)
      // Sent on stdin only. assertDatabasePassword admits no whitespace or control characters, and
      // doubling quotes is sufficient under standard_conforming_strings (the default since PostgreSQL 9.1).
      const literal = `'${password.replaceAll("'", "''")}'`;
      const stdin = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" LOGIN; END IF; END $$;\nSET standard_conforming_strings = on;\nALTER ROLE "${role}" WITH LOGIN PASSWORD ${literal};\n`;
      await run({ binary: '/usr/bin/psql', args: ['-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], uid: postgres.uid, gid: postgres.gid, stdin, timeoutMs: operation.timeoutMs, secrets: [password, password.replaceAll("'", "''")], env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/postgresql', LANG: 'C' } });
      return `ensured database role ${role}`;
    },
    'postgres.ensure-database': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const postgres = lookupUser('postgres');
      if (!postgres || !layout.database || operation.database !== layout.database.name || operation.owner !== layout.database.user) deny('PostgreSQL database operation does not match this app.');
      const { name, user } = layout.database; // validated simple identifiers (app-layout.js)
      const sql = `SELECT 'CREATE DATABASE "${name}" OWNER "${user}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${name}')\\gexec\nALTER DATABASE "${name}" OWNER TO "${user}";\n`;
      await run({ binary: '/usr/bin/psql', args: ['-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], uid: postgres.uid, gid: postgres.gid, stdin: sql, timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/postgresql', LANG: 'C' } });
      return `ensured database ${name}`;
    },
    'systemd.daemon-reload': async (operation) => {
      await run({ binary: '/usr/bin/systemctl', args: ['daemon-reload'], ...rootIdentity, timeoutMs: operation.timeoutMs, env: ROOT_ENV });
      return 'reloaded systemd unit definitions';
    },
    'systemd.ensure-service': async (operation, { layout } = {}) => {
      const allowed = new Set(['postgresql.service', 'nginx.service', ...(layout?.unitNames || [])]);
      if (!allowed.has(operation.unit) || !['enable', 'restart', 'enable-and-restart', 'stop', 'disable-now'].includes(operation.action)) deny('Systemd unit or action is not allowed.');
      if (operation.action === 'disable-now' && !lstatOrNull(fsImpl, `/etc/systemd/system/${operation.unit}`)) return `${operation.unit} is not installed`;
      const args = {
        enable: ['enable', operation.unit],
        restart: ['restart', operation.unit],
        'enable-and-restart': ['enable', '--now', operation.unit],
        stop: ['stop', operation.unit],
        'disable-now': ['disable', '--now', operation.unit],
      }[operation.action];
      await run({ binary: '/usr/bin/systemctl', args, ...rootIdentity, timeoutMs: operation.timeoutMs, env: ROOT_ENV });
      // `enable --now` does not restart an already-running unit; the plan's contract is a fresh start.
      if (operation.action === 'enable-and-restart') await run({ binary: '/usr/bin/systemctl', args: ['restart', operation.unit], ...rootIdentity, timeoutMs: operation.timeoutMs, env: ROOT_ENV });
      return `${operation.action} ${operation.unit}`;
    },
    'nginx.ensure-gateway': async () => {
      writeFileAtomic(fsImpl, NGINX_GATEWAY_SITE, NGINX_GATEWAY_CONTENT, 0o644);
      const link = lstatOrNull(fsImpl, NGINX_GATEWAY_LINK);
      if (!link) fsImpl.symlinkSync(NGINX_GATEWAY_SITE, NGINX_GATEWAY_LINK);
      else if (!link.isSymbolicLink() || fsImpl.readlinkSync(NGINX_GATEWAY_LINK) !== NGINX_GATEWAY_SITE) deny(`${NGINX_GATEWAY_LINK} exists and is not the managed gateway link.`);
      const defaultSite = lstatOrNull(fsImpl, NGINX_DEFAULT_LINK);
      if (defaultSite && !defaultSite.isSymbolicLink()) deny(`${NGINX_DEFAULT_LINK} is a regular file; disable it manually so the managed gateway can own the default server.`);
      if (defaultSite) fsImpl.unlinkSync(NGINX_DEFAULT_LINK);
      return 'installed managed nginx gateway site';
    },
    'nginx.validate-and-reload': async (operation) => {
      await run({ binary: '/usr/sbin/nginx', args: ['-t'], ...rootIdentity, timeoutMs: operation.timeoutMs, env: ROOT_ENV });
      await run({ binary: '/usr/bin/systemctl', args: ['reload', 'nginx.service'], ...rootIdentity, timeoutMs: operation.timeoutMs, env: ROOT_ENV });
      return 'validated and reloaded nginx';
    },
    'filesystem.ensure-directory': async (operation, { layout } = {}) => {
      if (operation.purpose === 'app-checkout-storage') {
        const storage = requireLayout(layout).storage;
        if (!storage?.inCheckout || !storage.subpaths.includes(operation.subpath)) deny('Storage subpath is not declared by this app.');
        const sovereign = lookupUser('sovereign');
        if (!sovereign) deny('The sovereign identity must exist before creating app storage.');
        const target = `${layout.checkout}/${operation.subpath}`;
        // Inside the sovereign-owned checkout, so created as sovereign: root never resolves a path there.
        asUser(sovereign, () => {
          const existing = lstatOrNull(fsImpl, target);
          if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) deny(`${target} is not a real directory.`);
          if (!existing) fsImpl.mkdirSync(target, { mode: 0o700 });
          fsImpl.chmodSync(target, 0o700);
        });
        return `ensured ${operation.subpath} storage`;
      }
      const directory = directoryFor(operation, layout);
      const parent = path.dirname(directory);
      // Missing ancestors (e.g. /var/lib/sovereign-home) are created root-owned; they are never sovereign-controlled.
      if (!fsImpl.existsSync(parent)) fsImpl.mkdirSync(parent, { recursive: true, mode: 0o755 });
      if (fsImpl.realpathSync(parent) !== parent) deny('Managed directory parent is a symlink.');
      const rootOwned = ROOT_OWNED_DIRECTORIES.has(operation.purpose);
      const sovereign = rootOwned ? null : lookupUser('sovereign');
      if (!rootOwned && !sovereign) deny('The sovereign identity must exist before creating app-owned directories.');
      // Inspect before mutating: a sovereign-planted symlink here would otherwise turn chown into a root escalation.
      const existing = lstatOrNull(fsImpl, directory);
      if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) deny('Managed directory is not a real directory.');
      const mode = DIRECTORY_MODES[operation.purpose] || 0o755;
      if (!existing) fsImpl.mkdirSync(directory, { mode });
      // The owner of a sovereign-writable parent can swap this entry for a symlink at any moment, so
      // ownership and mode are applied through a no-follow directory descriptor, never by path.
      const fd = fsImpl.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        if (!fsImpl.fstatSync(fd).isDirectory()) deny('Managed directory is not a real directory.');
        if (rootOwned) fsImpl.fchownSync(fd, 0, 0);
        else fsImpl.fchownSync(fd, sovereign.uid, sovereign.gid);
        // Also heals hosts bootstrapped before sovereign-root became root-owned.
        fsImpl.fchmodSync(fd, mode);
      } finally { fsImpl.closeSync(fd); }
      return `ensured ${operation.purpose}`;
    },
    'filesystem.write-managed-file': async (operation, { secretBindings = {}, layout } = {}) => {
      const template = renderManagedFile(operation, { secretBindings, layout });
      if (template.owner === 'root') {
        writeFileAtomic(fsImpl, template.path, template.content, template.mode);
        return `wrote ${operation.template}`;
      }
      const sovereign = lookupUser('sovereign');
      if (!sovereign) deny('The sovereign identity must exist before writing app configuration.');
      asUser(sovereign, () => {
        const existing = lstatOrNull(fsImpl, template.path);
        if (existing && !existing.isFile()) deny('Managed file destination is not a regular file.');
        const existingContent = existing ? (readSmallFileNoFollow(fsImpl, template.path) ?? deny('Managed file destination is not a regular file.')) : '';
        writeFileAtomic(fsImpl, template.path, template.render({ existingContent, fsImpl }), template.mode);
      });
      return `wrote ${operation.template}`;
    },
  };
}

module.exports = {
  DIRECTORY_PATHS,
  SOVEREIGN_HOME,
  GIT_DEPLOY_KEY_PATH,
  GIT_KNOWN_HOSTS_PATH,
  SOVEREIGN_GITCONFIG_PATH,
  GITHUB_KNOWN_HOSTS,
  NGINX_GATEWAY_CONTENT,
  lookupSystemUser,
  deployKeyStatus,
  createBaseHandlers,
  renderManagedFile,
  readExistingDatabasePassword,
  renderAppEnvFile,
  buildEnvContext,
  runAsUser,
  rootGitEnvironment,
  ROOT_GIT_CONFIG,
  lstatOrNull,
  readSmallFileNoFollow,
  writeFileAtomic,
  requireLayout,
  deny,
};
