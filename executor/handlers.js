const fs = require('fs');
const path = require('path');
const { ProtocolError } = require('./protocol');
const { runApproved } = require('./spawn');

const DIRECTORY_PATHS = Object.freeze({
  'sovereign-root': '/opt/sovereign-home',
  'app-root': '/opt/sovereign-home/apps',
  'app-install': '/opt/sovereign-home/apps/familyDinner',
  'backup-root': '/var/lib/sovereign-home/backups',
  'config-root': '/etc/sovereign-home',
  'nginx-snippets': '/etc/nginx/snippets',
});
const DINNER_PACKAGES = new Set(['git', 'ca-certificates', 'ssl-cert', 'nginx', 'postgresql', 'postgresql-client', 'nodejs', 'npm']);

function deny(message) { throw new ProtocolError('POLICY_DENIED', message); }
function assertContained(directory, fsImpl) {
  const parent = path.dirname(directory);
  if (fsImpl.existsSync(parent) && fsImpl.realpathSync(parent) !== parent) deny('Managed directory parent is a symlink.');
}

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

function createBaseHandlers({ platform = process.platform, fsImpl = fs, run = runApproved, lookupUser = (name) => lookupSystemUser(name, fsImpl) } = {}) {
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
      if (operation.updateCache) await run({ binary: '/usr/bin/apt-get', args: ['update'], ...rootIdentity, timeoutMs: operation.timeoutMs, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
      await run({ binary: '/usr/bin/apt-get', args: ['install', '--yes', '--no-install-recommends', ...operation.packages], ...rootIdentity, timeoutMs: operation.timeoutMs, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
      return `ensured ${operation.packages.length} approved packages`;
    },
    'identity.ensure-user': async (operation) => {
      if (operation.user !== 'sovereign') deny('Only the sovereign identity may be created.');
      const user = lookupUser('sovereign');
      if (user) return 'sovereign identity already exists';
      await run({ binary: '/usr/sbin/useradd', args: ['--system', '--home-dir', '/opt/sovereign-home', '--shell', '/usr/sbin/nologin', 'sovereign'], ...rootIdentity, timeoutMs: operation.timeoutMs, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
      return 'created sovereign identity';
    },
    'git.sync': async (operation) => {
      const sovereign = lookupUser('sovereign');
      if (!sovereign) deny('The sovereign identity must exist before Git synchronization.');
      if (operation.repository !== 'https://github.com/eforbell/familyDinner.git' || operation.destination !== 'familyDinner' || !/^(main|[a-f0-9]{40})$/.test(operation.ref)) deny('Git operation does not match Family Dinner policy.');
      const destination = DIRECTORY_PATHS['app-install'];
      const env = { PATH: '/usr/bin:/bin', HOME: '/opt/sovereign-home', LANG: 'C' };
      if (!fsImpl.existsSync(destination)) {
        const args = operation.ref === 'main'
          ? ['clone', '--origin', 'origin', '--branch', 'main', '--single-branch', operation.repository, destination]
          : ['clone', '--origin', 'origin', operation.repository, destination];
        await run({ binary: '/usr/bin/git', args, uid: sovereign.uid, gid: sovereign.gid, timeoutMs: operation.timeoutMs, env });
      }
      const status = await run({ binary: '/usr/bin/git', args: ['-C', destination, 'status', '--porcelain'], uid: sovereign.uid, gid: sovereign.gid, timeoutMs: operation.timeoutMs, env });
      if (String(status.stdout || '').trim()) deny('Family Dinner checkout is dirty; refusing to overwrite operator changes.');
      if (operation.ref === 'main') {
        await run({ binary: '/usr/bin/git', args: ['-C', destination, 'pull', '--ff-only', 'origin', 'main'], uid: sovereign.uid, gid: sovereign.gid, timeoutMs: operation.timeoutMs, env });
      } else {
        await run({ binary: '/usr/bin/git', args: ['-C', destination, 'fetch', '--depth', '1', 'origin', operation.ref], uid: sovereign.uid, gid: sovereign.gid, timeoutMs: operation.timeoutMs, env });
        await run({ binary: '/usr/bin/git', args: ['-C', destination, 'checkout', '--detach', 'FETCH_HEAD'], uid: sovereign.uid, gid: sovereign.gid, timeoutMs: operation.timeoutMs, env });
      }
      return 'synchronized Family Dinner repository';
    },
    'runtime.run-npm': async (operation) => {
      const sovereign = lookupUser('sovereign');
      if (!sovereign) deny('The sovereign identity must exist before running Family Dinner.');
      const argsByTask = { 'install-production': ['ci', '--omit=dev'], migrate: ['run', 'db:migrate'] };
      const args = argsByTask[operation.task];
      if (!args) deny('Unsupported npm task.');
      const result = await run({ binary: '/usr/bin/npm', args, uid: sovereign.uid, gid: sovereign.gid, cwd: DIRECTORY_PATHS['app-install'], timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', HOME: '/opt/sovereign-home', NODE_ENV: 'production', LANG: 'C' } });
      return result.stdout || `completed npm ${operation.task}`;
    },
    'postgres.ensure-role': async (operation, { secretBindings = {} } = {}) => {
      const postgres = lookupUser('postgres');
      if (!postgres || operation.role !== 'family_dinner' || operation.passwordSecretRef !== 'familyDinnerDatabasePassword') deny('PostgreSQL role operation does not match Family Dinner policy.');
      const password = secretBindings.familyDinnerDatabasePassword;
      if (typeof password !== 'string' || !password) throw new ProtocolError('SECRET_BINDING_MISSING', 'Family Dinner database password is missing.');
      const stdin = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'family_dinner') THEN CREATE ROLE family_dinner LOGIN; END IF; END $$;\n\password family_dinner\n${password}\n${password}\n`;
      await run({ binary: '/usr/bin/psql', args: ['-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], uid: postgres.uid, gid: postgres.gid, stdin, timeoutMs: operation.timeoutMs, secrets: [password], env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/postgresql', LANG: 'C' } });
      return 'ensured Family Dinner database role';
    },
    'postgres.ensure-database': async (operation) => {
      const postgres = lookupUser('postgres');
      if (!postgres || operation.database !== 'family_dinner' || operation.owner !== 'family_dinner') deny('PostgreSQL database operation does not match Family Dinner policy.');
      const sql = `SELECT 'CREATE DATABASE family_dinner OWNER family_dinner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'family_dinner')\gexec\nALTER DATABASE family_dinner OWNER TO family_dinner;\n`;
      await run({ binary: '/usr/bin/psql', args: ['-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], uid: postgres.uid, gid: postgres.gid, stdin: sql, timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/postgresql', LANG: 'C' } });
      return 'ensured Family Dinner database';
    },
    'systemd.daemon-reload': async (operation) => {
      await run({ binary: '/usr/bin/systemctl', args: ['daemon-reload'], ...rootIdentity, timeoutMs: operation.timeoutMs, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
      return 'reloaded systemd unit definitions';
    },
    'systemd.ensure-service': async (operation) => {
      const allowed = new Set(['postgresql.service', 'nginx.service', 'family-dinner.service']);
      if (!allowed.has(operation.unit) || !['enable', 'restart', 'enable-and-restart'].includes(operation.action)) deny('Systemd unit or action is not allowed.');
      const args = operation.action === 'enable' ? ['enable', operation.unit]
        : operation.action === 'restart' ? ['restart', operation.unit]
          : ['enable', '--now', operation.unit];
      await run({ binary: '/usr/bin/systemctl', args, ...rootIdentity, timeoutMs: operation.timeoutMs, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
      return `${operation.action} ${operation.unit}`;
    },
    'nginx.validate-and-reload': async (operation) => {
      const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' };
      await run({ binary: '/usr/sbin/nginx', args: ['-t'], ...rootIdentity, timeoutMs: operation.timeoutMs, env });
      await run({ binary: '/usr/bin/systemctl', args: ['reload', 'nginx.service'], ...rootIdentity, timeoutMs: operation.timeoutMs, env });
      return 'validated and reloaded nginx';
    },
    'filesystem.ensure-directory': async (operation) => {
      const directory = DIRECTORY_PATHS[operation.purpose];
      if (!directory) deny('Unknown managed directory purpose.');
      assertContained(directory, fsImpl);
      const rootOwned = new Set(['config-root', 'nginx-snippets']).has(operation.purpose);
      const sovereign = rootOwned ? null : lookupUser('sovereign');
      if (!rootOwned && !sovereign) deny('The sovereign identity must exist before creating app-owned directories.');
      fsImpl.mkdirSync(directory, { recursive: true, mode: rootOwned ? 0o750 : 0o755 });
      if (!rootOwned && typeof fsImpl.chownSync === 'function') fsImpl.chownSync(directory, sovereign.uid, sovereign.gid);
      const stat = fsImpl.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) deny('Managed directory is not a real directory.');
      return `ensured ${operation.purpose}`;
    },
  };
}
module.exports = { DIRECTORY_PATHS, DINNER_PACKAGES, lookupSystemUser, createBaseHandlers };
