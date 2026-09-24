const fs = require('fs');
const path = require('path');
const { ProtocolError } = require('./protocol');
const { runApproved } = require('./spawn');
const { getAppById } = require('../src/catalog');
const { lookupSystemUser, rootGitEnvironment, ROOT_GIT_CONFIG, SOVEREIGN_HOME } = require('./handlers');

const MIRROR_ROOT = '/var/lib/sovereign-home/git-mirrors';
const APPS_ROOT = '/opt/sovereign-home/apps';
const SHA = /^[0-9a-f]{40}$/;

// Catalog-derived locations: the caller names an app, never a path or URL.
function appGitLocations(app, transport) {
  const repository = transport === 'ssh'
    ? `ssh://${String(app.repository.sshUrl || '').replace(':', '/')}`
    : app.repository.url;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(app.repoKey || '')) throw new ProtocolError('POLICY_DENIED', 'Catalog entry has no usable repoKey.');
  if (transport === 'ssh' && !app.repository.sshUrl) throw new ProtocolError('POLICY_DENIED', `${app.id} has no SSH repository.`);
  return { repository, mirror: path.join(MIRROR_ROOT, `${app.repoKey}.git`), checkout: path.join(APPS_ROOT, app.repoKey) };
}

// Reports how an installed checkout compares with its upstream branch. Root refreshes only the
// root-owned mirror; sovereign reads the checkout's HEAD. Root never runs git inside the
// sovereign-owned checkout, whose config could otherwise execute code as root.
function createAppUpdateStatusChecker({ run = runApproved, fsImpl = fs, lookupUser = (name) => lookupSystemUser(name, fsImpl) } = {}) {
  return async function checkAppUpdateStatus({ appId, transport, ref }) {
    const app = getAppById(appId);
    if (!app) throw new ProtocolError('POLICY_DENIED', 'Unknown catalog app.');
    const { repository, mirror, checkout } = appGitLocations(app, transport);
    const sovereign = lookupUser('sovereign');
    if (!sovereign) throw new ProtocolError('POLICY_DENIED', 'The sovereign identity does not exist.');
    if (!fsImpl.existsSync(path.join(checkout, '.git'))) throw new ProtocolError('NOT_INSTALLED', `${app.name} has no checkout at ${checkout}.`);

    const rootEnv = rootGitEnvironment(transport, fsImpl);
    const rootGit = (args) => run({ binary: '/usr/bin/git', args: [...ROOT_GIT_CONFIG, ...args], uid: 0, gid: 0, timeoutMs: 60000, env: rootEnv });
    if (!fsImpl.existsSync(MIRROR_ROOT)) fsImpl.mkdirSync(MIRROR_ROOT, { recursive: true, mode: 0o755 });
    if (!fsImpl.existsSync(mirror)) {
      await rootGit(['clone', '--mirror', repository, mirror]);
    } else {
      await rootGit(['-C', mirror, 'remote', 'set-url', 'origin', repository]);
      await rootGit(['-C', mirror, 'fetch', '--prune', 'origin']);
    }

    const local = await run({ binary: '/usr/bin/git', args: ['-C', checkout, 'rev-parse', 'HEAD'], uid: sovereign.uid, gid: sovereign.gid, timeoutMs: 10000, env: { PATH: '/usr/bin:/bin', HOME: SOVEREIGN_HOME, LANG: 'C' } });
    const localHeadSha = String(local.stdout || '').trim();
    if (!SHA.test(localHeadSha)) throw new ProtocolError('OPERATION_FAILED', 'Checkout HEAD is not a commit.');

    if (SHA.test(ref)) {
      // Pinned installs never "update"; report whether the checkout still matches its pin.
      return { localHeadSha, remoteHeadSha: ref, aheadCount: 0, behindCount: 0, pinned: true, matchesPin: localHeadSha === ref };
    }
    const remote = await rootGit(['-C', mirror, 'rev-parse', '--verify', `refs/heads/${ref}^{commit}`]);
    const remoteHeadSha = String(remote.stdout || '').trim();
    let counts;
    try {
      // localHeadSha is validated as a bare SHA, so it cannot be read as an option or revision expression.
      counts = await rootGit(['-C', mirror, 'rev-list', '--left-right', '--count', `${localHeadSha}...${remoteHeadSha}`]);
    } catch {
      // The checkout holds commits the upstream mirror has never seen (local work or a force-push upstream).
      return { localHeadSha, remoteHeadSha, aheadCount: null, behindCount: null, unknownLocalCommit: true };
    }
    const [ahead, behind] = String(counts.stdout || '').trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
    return { localHeadSha, remoteHeadSha, aheadCount: Number.isFinite(ahead) ? ahead : 0, behindCount: Number.isFinite(behind) ? behind : 0 };
  };
}

module.exports = { createAppUpdateStatusChecker, appGitLocations };
