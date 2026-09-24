const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { ProtocolError } = require('./protocol');
const { runApproved } = require('./spawn');
const { getAppById } = require('../src/catalog');
const { gitTransportForRepository } = require('../src/operations/policy');

const DIRECTORY_PATHS = Object.freeze({
  'sovereign-root': '/opt/sovereign-home',
  'app-root': '/opt/sovereign-home/apps',
  'app-install': '/opt/sovereign-home/apps/familyDinner',
  'backup-root': '/var/lib/sovereign-home/backups',
  'config-root': '/etc/sovereign-home',
  'nginx-snippets': '/etc/nginx/snippets',
  'nginx-apps': '/etc/nginx/sovereign-home.d',
  'sovereign-home': '/var/lib/sovereign-home/sovereign',
});
// /opt/sovereign-home also holds the root executor's own code (/opt/sovereign-home/homebase). The owner
// of a directory can rename its entries, so it must stay root-owned; only apps/ belongs to sovereign.
const ROOT_OWNED_DIRECTORIES = new Set(['sovereign-root', 'config-root', 'nginx-snippets', 'nginx-apps']);
const PRIVATE_DIRECTORIES = new Set(['sovereign-home']);
// HOME for git/npm children: sovereign-writable (npm cache) without owning any root-controlled path.
const SOVEREIGN_HOME = DIRECTORY_PATHS['sovereign-home'];
const DINNER_PACKAGES = new Set(['git', 'ca-certificates', 'openssh-client', 'ssl-cert', 'nginx', 'postgresql', 'postgresql-client', 'nodejs', 'npm']);

// Operator-provisioned by `install.sh --git-ssh-key`; root-owned and only ever read by root's ssh.
const GIT_DEPLOY_KEY_PATH = '/etc/sovereign-home/git/deploy_key';
const GIT_KNOWN_HOSTS_PATH = '/etc/sovereign-home/git/known_hosts';
const DINNER_MIRROR = '/var/lib/sovereign-home/git-mirrors/familyDinner.git';
// System-scope git config for sovereign's git: the only scope git's upload-pack honours for safe.directory,
// which sovereign needs to read the deliberately root-owned mirror. Root-owned, world-readable.
const SOVEREIGN_GITCONFIG_PATH = '/etc/sovereign-home/sovereign.gitconfig';
const SOVEREIGN_GITCONFIG = `[safe]\n\tdirectory = ${DINNER_MIRROR}\n`;
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

function parseEnvFile(content) {
  const entries = new Map();
  for (const line of String(content || '').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) entries.set(match[1], match[2]);
  }
  return entries;
}

function assertDatabasePassword(password) {
  if (typeof password !== 'string' || !password) throw new ProtocolError('SECRET_BINDING_MISSING', 'Family Dinner database password is missing.');
  // Printable, whitespace-free ASCII keeps the password safe for psql's line-oriented stdin and .env lines.
  if (!/^[\x21-\x7e]{8,256}$/.test(password)) deny('Family Dinner database password must be 8-256 printable non-space ASCII characters.');
  return password;
}

// Managed keys are authoritative; every other key keeps the operator's non-empty value, and catalog
// defaults fill anything missing. Keys the operator added outside the catalog survive reinstall.
function renderDinnerEnv({ password, existingContent = '' }) {
  const app = getAppById('family-dinner');
  const existing = parseEnvFile(existingContent);
  const port = String(app.network.preferredPort);
  const databaseUrl = `postgresql://${app.database.databaseUser}:${encodeURIComponent(password)}@127.0.0.1:5432/${app.database.databaseName}`;
  const placeholders = {
    databaseUrl,
    port,
    sovereignFontSource: 'google',
    sovereignFontSansCssUrl: 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap',
    sovereignFontMonoCssUrl: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap',
    sovereignFontSansCssUrlLocal: '',
    sovereignFontMonoCssUrlLocal: '',
  };
  const managed = { DATABASE_URL: databaseUrl, PORT: port, NODE_ENV: app.runtime.nodeEnv || 'production' };
  const lines = [];
  const written = new Set();
  const emit = (key, value) => { lines.push(`${key}=${value}`); written.add(key); };
  for (const [key, template] of Object.entries(app.config.env)) {
    if (key in managed) { emit(key, managed[key]); continue; }
    const current = existing.get(key);
    if (current) { emit(key, current); continue; }
    emit(key, String(template).replace(/\{\{(\w+)\}\}/g, (_, name) => placeholders[name] ?? ''));
  }
  for (const [key, value] of Object.entries(managed)) if (!written.has(key)) emit(key, value);
  for (const [key, value] of existing) if (!written.has(key)) emit(key, value);
  return `${lines.join('\n')}\n`;
}

// Reuse the app's current database password so an update never rotates credentials under a running
// service (a failed update would otherwise leave the live app unable to connect). Read as sovereign:
// the .env sits in a sovereign-owned directory. Returns null when there is nothing valid to reuse.
function readExistingDinnerPassword({ fsImpl = fs, lookupUser = (name) => lookupSystemUser(name, fsImpl), asUser = runAsUser } = {}) {
  const sovereign = lookupUser('sovereign');
  if (!sovereign) return null;
  const envPath = '/opt/sovereign-home/apps/familyDinner/.env';
  let content = null;
  try {
    content = asUser(sovereign, () => {
      const stat = lstatOrNull(fsImpl, envPath);
      return stat && stat.isFile() ? fsImpl.readFileSync(envPath, 'utf8') : null;
    });
  } catch { return null; }
  const url = parseEnvFile(content).get('DATABASE_URL') || '';
  const match = /^postgresql:\/\/family_dinner:([^@]+)@127\.0\.0\.1:5432\/family_dinner$/.exec(url);
  if (!match) return null;
  try {
    const password = decodeURIComponent(match[1]);
    return /^[\x21-\x7e]{8,256}$/.test(password) ? password : null;
  } catch { return null; }
}

function renderManagedFile(operation, secretBindings = {}) {
  const templates = {
    'family-dinner-env-v1': {
      path: '/opt/sovereign-home/apps/familyDinner/.env', mode: 0o640, owner: 'sovereign',
      render: ({ existingContent }) => renderDinnerEnv({ password: assertDatabasePassword(secretBindings.familyDinnerDatabasePassword), existingContent }),
    },
    // No EnvironmentFile=: systemd would read the sovereign-owned .env as root before dropping to
    // User=, letting a planted symlink expose root-only files. Dinner loads .env itself via dotenv.
    'family-dinner-service-v1': {
      path: '/etc/systemd/system/family-dinner.service', mode: 0o644, owner: 'root',
      content: '[Unit]\nDescription=Family Dinner\nAfter=network.target postgresql.service\n\n[Service]\nType=simple\nUser=sovereign\nWorkingDirectory=/opt/sovereign-home/apps/familyDinner\nExecStart=/usr/bin/node server.js\nRestart=on-failure\nUMask=0077\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=multi-user.target\n',
    },
    'family-dinner-nginx-v1': {
      path: '/etc/nginx/sovereign-home.d/family-dinner.conf', mode: 0o644, owner: 'root',
      content: '# family-dinner\nlocation = /dinner {\n    return 301 /dinner/;\n}\nlocation /dinner/ {\n    proxy_pass http://127.0.0.1:3000/;\n    proxy_set_header Host $host;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n    proxy_set_header X-Forwarded-Prefix /dinner;\n}\n',
    },
  };
  const template = templates[operation.template];
  if (!template) deny('Managed file template is not allowed.');
  return template;
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

function createBaseHandlers({ platform = process.platform, fsImpl = fs, run = runApproved, lookupUser = (name) => lookupSystemUser(name, fsImpl), asUser = runAsUser } = {}) {
  const rootIdentity = { uid: 0, gid: 0 };
  return {
    'host.assert-debian-family': async () => {
      if (platform !== 'linux') deny('Executor requires a Linux Debian-family host.');
      const content = fsImpl.readFileSync('/etc/os-release', 'utf8');
      if (!/^ID=(ubuntu|debian)$/m.test(content)) deny('Executor requires Ubuntu or Debian.');
      return 'supported Debian-family host';
    },
    'package.ensure': async (operation) => {
      if (!operation.packages.every((pkg) => DINNER_PACKAGES.has(pkg))) deny('Package is not in the compiled policy allowlist.');
      if (operation.updateCache) await run({ binary: '/usr/bin/apt-get', args: ['update'], ...rootIdentity, timeoutMs: operation.timeoutMs, env: APT_ENV });
      await run({ binary: '/usr/bin/apt-get', args: ['install', '--yes', '--no-install-recommends', ...APT_DPKG_OPTIONS, ...operation.packages], ...rootIdentity, timeoutMs: operation.timeoutMs, env: APT_ENV });
      return `ensured ${operation.packages.length} approved packages`;
    },
    'identity.ensure-user': async (operation) => {
      if (operation.user !== 'sovereign') deny('Only the sovereign identity may be created.');
      const user = lookupUser('sovereign');
      if (user) return 'sovereign identity already exists';
      await run({ binary: '/usr/sbin/useradd', args: ['--system', '--home-dir', SOVEREIGN_HOME, '--shell', '/usr/sbin/nologin', 'sovereign'], ...rootIdentity, timeoutMs: operation.timeoutMs, env: ROOT_ENV });
      return 'created sovereign identity';
    },
    'git.sync': async (operation) => {
      const sovereign = lookupUser('sovereign');
      if (!sovereign) deny('The sovereign identity must exist before Git synchronization.');
      const transport = gitTransportForRepository(operation.repository);
      if (!transport || operation.destination !== 'familyDinner' || !/^(main|[a-f0-9]{40})$/.test(operation.ref)) deny('Git operation does not match Family Dinner policy.');
      const destination = DIRECTORY_PATHS['app-install'];

      // 1. Root refreshes the mirror from the network (credentials, if any, stay with root).
      const rootEnv = rootGitEnvironment(transport, fsImpl);
      const rootGit = (args) => run({ binary: '/usr/bin/git', args: [...ROOT_GIT_CONFIG, ...args], ...rootIdentity, timeoutMs: operation.timeoutMs, env: rootEnv });
      const mirrorParent = path.dirname(DINNER_MIRROR);
      if (!fsImpl.existsSync(mirrorParent)) fsImpl.mkdirSync(mirrorParent, { recursive: true, mode: 0o755 });
      if (!lstatOrNull(fsImpl, DINNER_MIRROR)) {
        await rootGit(['clone', '--mirror', operation.repository, DINNER_MIRROR]);
      } else {
        await rootGit(['-C', DINNER_MIRROR, 'remote', 'set-url', 'origin', operation.repository]);
        await rootGit(['-C', DINNER_MIRROR, 'fetch', '--prune', 'origin']);
      }

      // 2. Sovereign updates the checkout from the local mirror only; it never touches the network or a key.
      const env = { PATH: '/usr/bin:/bin', HOME: SOVEREIGN_HOME, LANG: 'C', GIT_TERMINAL_PROMPT: '0' };
      // The mirror is root-owned by design (sovereign must not be able to plant config that root's fetch
      // would read), so sovereign's git gets a safe.directory exception through a managed system config.
      const currentConfig = fsImpl.existsSync(SOVEREIGN_GITCONFIG_PATH) ? fsImpl.readFileSync(SOVEREIGN_GITCONFIG_PATH, 'utf8') : null;
      if (currentConfig !== SOVEREIGN_GITCONFIG) writeFileAtomic(fsImpl, SOVEREIGN_GITCONFIG_PATH, SOVEREIGN_GITCONFIG, 0o644);
      env.GIT_CONFIG_SYSTEM = SOVEREIGN_GITCONFIG_PATH;
      const git = (args) => run({ binary: '/usr/bin/git', args, uid: sovereign.uid, gid: sovereign.gid, timeoutMs: operation.timeoutMs, env });
      const checkout = lstatOrNull(fsImpl, path.join(destination, '.git'));
      if (!checkout) {
        // ensure-install-root creates the destination first; git clones into an existing directory only when it is empty.
        if (fsImpl.existsSync(destination) && fsImpl.readdirSync(destination).length) deny('Family Dinner install directory is not empty and is not a Git checkout.');
        await git(['clone', '--origin', 'origin', '--no-checkout', DINNER_MIRROR, destination]);
      } else {
        if (!checkout.isDirectory()) deny('Family Dinner checkout metadata is not a directory.');
        const status = await git(['-C', destination, 'status', '--porcelain']);
        if (String(status.stdout || '').trim()) deny('Family Dinner checkout is dirty; refusing to overwrite operator changes.');
        await git(['-C', destination, 'remote', 'set-url', 'origin', DINNER_MIRROR]);
        await git(['-C', destination, 'fetch', 'origin']);
      }
      if (operation.ref === 'main') {
        // First install has no local branch yet; later runs fast-forward and refuse divergent history.
        if (!checkout) await git(['-C', destination, 'checkout', '-B', 'main', 'origin/main']);
        else await git(['-C', destination, 'merge', '--ff-only', 'origin/main']);
      } else {
        await git(['-C', destination, 'checkout', '--detach', operation.ref]);
      }
      return `synchronized Family Dinner repository over ${transport}`;
    },
    'runtime.run-npm': async (operation) => {
      const sovereign = lookupUser('sovereign');
      if (!sovereign) deny('The sovereign identity must exist before running Family Dinner.');
      const argsByTask = { 'install-production': ['ci', '--omit=dev'], migrate: ['run', 'db:migrate'] };
      const args = argsByTask[operation.task];
      if (!args) deny('Unsupported npm task.');
      const result = await run({ binary: '/usr/bin/npm', args, uid: sovereign.uid, gid: sovereign.gid, cwd: DIRECTORY_PATHS['app-install'], timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', HOME: SOVEREIGN_HOME, NODE_ENV: 'production', LANG: 'C' } });
      // Keep success output well under the protocol's 64 KiB event line limit.
      const output = String(result.stdout || '').trim();
      return output ? output.slice(-8 * 1024) : `completed npm ${operation.task}`;
    },
    'postgres.ensure-role': async (operation, { secretBindings = {} } = {}) => {
      const postgres = lookupUser('postgres');
      if (!postgres || operation.role !== 'family_dinner' || operation.passwordSecretRef !== 'familyDinnerDatabasePassword') deny('PostgreSQL role operation does not match Family Dinner policy.');
      const password = assertDatabasePassword(secretBindings.familyDinnerDatabasePassword);
      // Sent on stdin only. assertDatabasePassword admits no whitespace or control characters, and
      // doubling quotes is sufficient under standard_conforming_strings (the default since PostgreSQL 9.1).
      const literal = `'${password.replaceAll("'", "''")}'`;
      const stdin = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'family_dinner') THEN CREATE ROLE family_dinner LOGIN; END IF; END $$;\nSET standard_conforming_strings = on;\nALTER ROLE family_dinner WITH LOGIN PASSWORD ${literal};\n`;
      await run({ binary: '/usr/bin/psql', args: ['-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], uid: postgres.uid, gid: postgres.gid, stdin, timeoutMs: operation.timeoutMs, secrets: [password, password.replaceAll("'", "''")], env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/postgresql', LANG: 'C' } });
      return 'ensured Family Dinner database role';
    },
    'postgres.ensure-database': async (operation) => {
      const postgres = lookupUser('postgres');
      if (!postgres || operation.database !== 'family_dinner' || operation.owner !== 'family_dinner') deny('PostgreSQL database operation does not match Family Dinner policy.');
      const sql = `SELECT 'CREATE DATABASE family_dinner OWNER family_dinner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'family_dinner')\\gexec\nALTER DATABASE family_dinner OWNER TO family_dinner;\n`;
      await run({ binary: '/usr/bin/psql', args: ['-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], uid: postgres.uid, gid: postgres.gid, stdin: sql, timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/postgresql', LANG: 'C' } });
      return 'ensured Family Dinner database';
    },
    'systemd.daemon-reload': async (operation) => {
      await run({ binary: '/usr/bin/systemctl', args: ['daemon-reload'], ...rootIdentity, timeoutMs: operation.timeoutMs, env: ROOT_ENV });
      return 'reloaded systemd unit definitions';
    },
    'systemd.ensure-service': async (operation) => {
      const allowed = new Set(['postgresql.service', 'nginx.service', 'family-dinner.service']);
      if (!allowed.has(operation.unit) || !['enable', 'restart', 'enable-and-restart'].includes(operation.action)) deny('Systemd unit or action is not allowed.');
      const args = operation.action === 'enable' ? ['enable', operation.unit]
        : operation.action === 'restart' ? ['restart', operation.unit]
          : ['enable', '--now', operation.unit];
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
    'filesystem.ensure-directory': async (operation) => {
      const directory = DIRECTORY_PATHS[operation.purpose];
      if (!directory) deny('Unknown managed directory purpose.');
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
      const mode = PRIVATE_DIRECTORIES.has(operation.purpose) ? 0o700 : 0o755;
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
    'filesystem.write-managed-file': async (operation, { secretBindings = {} } = {}) => {
      const template = renderManagedFile(operation, secretBindings);
      if (template.owner === 'root') {
        writeFileAtomic(fsImpl, template.path, template.content, template.mode);
        return `wrote ${operation.template}`;
      }
      const sovereign = lookupUser('sovereign');
      if (!sovereign) deny('The sovereign identity must exist before writing app configuration.');
      asUser(sovereign, () => {
        const existing = lstatOrNull(fsImpl, template.path);
        if (existing && !existing.isFile()) deny('Managed file destination is not a regular file.');
        const existingContent = existing ? fsImpl.readFileSync(template.path, 'utf8') : '';
        writeFileAtomic(fsImpl, template.path, template.render({ existingContent }), template.mode);
      });
      return `wrote ${operation.template}`;
    },
  };
}

module.exports = {
  DIRECTORY_PATHS,
  DINNER_PACKAGES,
  SOVEREIGN_HOME,
  GIT_DEPLOY_KEY_PATH,
  GIT_KNOWN_HOSTS_PATH,
  DINNER_MIRROR,
  SOVEREIGN_GITCONFIG_PATH,
  GITHUB_KNOWN_HOSTS,
  NGINX_GATEWAY_CONTENT,
  lookupSystemUser,
  deployKeyStatus,
  createBaseHandlers,
  renderManagedFile,
  readExistingDinnerPassword,
  renderDinnerEnv,
  parseEnvFile,
  runAsUser,
  rootGitEnvironment,
  ROOT_GIT_CONFIG,
};
