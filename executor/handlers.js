const fs = require('fs');
const path = require('path');
const { ProtocolError } = require('./protocol');

const DIRECTORY_PATHS = Object.freeze({
  'sovereign-root': '/opt/sovereign-home',
  'app-root': '/opt/sovereign-home/apps',
  'app-install': '/opt/sovereign-home/apps/familyDinner',
  'backup-root': '/var/lib/sovereign-home/backups',
  'config-root': '/etc/sovereign-home',
  'nginx-snippets': '/etc/nginx/snippets',
});

function assertContained(directory) {
  const parent = path.dirname(directory);
  if (fs.existsSync(parent) && fs.realpathSync(parent) !== parent) throw new ProtocolError('POLICY_DENIED', 'Managed directory parent is a symlink.');
}

function createBaseHandlers({ platform = process.platform } = {}) {
  return {
    'host.assert-debian-family': async () => {
      if (platform !== 'linux') throw new ProtocolError('POLICY_DENIED', 'Executor requires a Linux Debian-family host.');
      const content = fs.readFileSync('/etc/os-release', 'utf8');
      if (!/^ID=(ubuntu|debian)$/m.test(content)) throw new ProtocolError('POLICY_DENIED', 'Executor requires Ubuntu or Debian.');
      return 'supported Debian-family host';
    },
    'filesystem.ensure-directory': async (operation) => {
      const directory = DIRECTORY_PATHS[operation.purpose];
      if (!directory) throw new ProtocolError('POLICY_DENIED', 'Unknown managed directory purpose.');
      assertContained(directory);
      fs.mkdirSync(directory, { recursive: true, mode: operation.purpose === 'config-root' ? 0o750 : 0o755 });
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ProtocolError('POLICY_DENIED', 'Managed directory is not a real directory.');
      return `ensured ${operation.purpose}`;
    },
  };
}

module.exports = { DIRECTORY_PATHS, createBaseHandlers };
