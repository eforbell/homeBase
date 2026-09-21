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
