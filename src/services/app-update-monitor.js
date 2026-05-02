const { spawnSync } = require('child_process');

const DEFAULT_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const DEFAULT_GIT_TIMEOUT_MS = 20_000;

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

function parseRevListCounts(output) {
  const trimmed = String(output || '').trim();
  const [aheadRaw, behindRaw] = trimmed.split(/\s+/);
  const ahead = Number.parseInt(aheadRaw, 10);
  const behind = Number.parseInt(behindRaw, 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

function formatGitFailure(message, result) {
  const stderr = String(result?.stderr || '').trim();
  const stdout = String(result?.stdout || '').trim();
  const suffix = stderr || stdout;
  return suffix ? `${message}: ${suffix}` : message;
}

class AppUpdateMonitor {
  constructor(stateStore, {
    logger = console,
    serviceUser = '',
    gitTransport = 'https',
    gitSshKeyPath = '',
    gitSshKnownHostsPath = '',
    gitSshStrictHostKeyChecking = 'accept-new',
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  } = {}) {
    this.stateStore = stateStore;
    this.logger = logger;
    this.serviceUser = String(serviceUser || '').trim();
    this.gitTransport = String(gitTransport || 'https').trim() || 'https';
    this.gitSshKeyPath = String(gitSshKeyPath || '').trim();
    this.gitSshKnownHostsPath = String(gitSshKnownHostsPath || '').trim();
    this.gitSshStrictHostKeyChecking = String(gitSshStrictHostKeyChecking || 'accept-new').trim() || 'accept-new';
    this.checkIntervalMs = Number.isFinite(checkIntervalMs) ? Math.max(10_000, checkIntervalMs) : DEFAULT_CHECK_INTERVAL_MS;
    this.staleAfterMs = Number.isFinite(staleAfterMs) ? Math.max(1_000, staleAfterMs) : DEFAULT_STALE_AFTER_MS;
    this.gitTimeoutMs = Number.isFinite(gitTimeoutMs) ? Math.max(1_000, gitTimeoutMs) : DEFAULT_GIT_TIMEOUT_MS;
    this.timer = null;
    this.scanPromise = null;
  }

  configureGit({
    serviceUser = this.serviceUser,
    gitTransport = this.gitTransport,
    gitSshKeyPath = this.gitSshKeyPath,
    gitSshKnownHostsPath = this.gitSshKnownHostsPath,
    gitSshStrictHostKeyChecking = this.gitSshStrictHostKeyChecking,
  } = {}) {
    this.serviceUser = String(serviceUser || '').trim();
    this.gitTransport = String(gitTransport || 'https').trim() || 'https';
    this.gitSshKeyPath = String(gitSshKeyPath || '').trim();
    this.gitSshKnownHostsPath = String(gitSshKnownHostsPath || '').trim();
    this.gitSshStrictHostKeyChecking = String(gitSshStrictHostKeyChecking || 'accept-new').trim() || 'accept-new';
  }

  buildGitSshCommand() {
    const parts = [
      'ssh',
      '-i', this.gitSshKeyPath,
      '-o', 'IdentitiesOnly=yes',
      '-o', `StrictHostKeyChecking=${this.gitSshStrictHostKeyChecking}`,
    ];
    if (this.gitSshKnownHostsPath) {
      parts.push('-o', `UserKnownHostsFile=${this.gitSshKnownHostsPath}`);
    }
    return parts.join(' ');
  }

  buildGitInvocation(args, installRoot) {
    const env = { ...process.env };
    const gitArgs = ['-C', installRoot, ...args];
    let command = 'git';
    let commandArgs = gitArgs;
    if (this.serviceUser) {
      command = 'sudo';
      if (this.gitTransport === 'ssh') {
        commandArgs = ['--preserve-env=SSH_AUTH_SOCK', '-u', this.serviceUser, 'git', ...gitArgs];
      } else if (this.gitTransport === 'ssh-key') {
        commandArgs = ['-u', this.serviceUser, 'env', `GIT_SSH_COMMAND=${this.buildGitSshCommand()}`, 'git', ...gitArgs];
      } else {
        commandArgs = ['-u', this.serviceUser, 'git', ...gitArgs];
      }
    } else if (this.gitTransport === 'ssh-key') {
      env.GIT_SSH_COMMAND = this.buildGitSshCommand();
    }
    return { command, commandArgs, env };
  }

  runGit(args, installRoot) {
    const { command, commandArgs, env } = this.buildGitInvocation(args, installRoot);
    return spawnSync(command, commandArgs, {
      env,
      encoding: 'utf8',
      timeout: this.gitTimeoutMs,
    });
  }

  buildSnapshotByApp() {
    const rows = this.stateStore.listAppUpdateStatuses();
    const map = {};
    for (const row of rows) {
      map[row.appId] = row;
    }
    return map;
  }

  shouldRefreshStatus(status, now, force) {
    if (force) return true;
    const checkedAt = status?.lastCheckedAt ? Date.parse(status.lastCheckedAt) : Number.NaN;
    if (!Number.isFinite(checkedAt)) return true;
    return (now - checkedAt) >= this.staleAfterMs;
  }

  async refreshInstalledApps(installations = [], { force = false } = {}) {
    if (this.scanPromise) return this.scanPromise;
    const task = (async () => {
      const snapshot = this.buildSnapshotByApp();
      const now = Date.now();
      for (const install of installations) {
        if (!install?.appId) continue;
        const current = snapshot[install.appId];
        if (!this.shouldRefreshStatus(current, now, force)) continue;
        const next = this.evaluateInstallation(install);
        this.stateStore.upsertAppUpdateStatus(next);
        snapshot[install.appId] = next;
      }
      return snapshot;
    })();

    this.scanPromise = task;
    try {
      return await task;
    } finally {
      this.scanPromise = null;
    }
  }

  evaluateInstallation(install) {
    const appId = install.appId;
    const trackedRef = String(install.ref || 'main').trim() || 'main';
    const installRoot = String(install.installRoot || '').trim();
    const checkedAt = new Date().toISOString();

    if (!isValidGitRef(trackedRef)) {
      return {
        appId,
        trackedRef,
        status: 'check-failed',
        canUpdate: null,
        aheadCount: 0,
        behindCount: 0,
        localHeadSha: '',
        remoteHeadSha: '',
        lastCheckedAt: checkedAt,
        lastError: `Invalid git ref: ${trackedRef}`,
      };
    }

    if (!installRoot) {
      return {
        appId,
        trackedRef,
        status: 'check-failed',
        canUpdate: null,
        aheadCount: 0,
        behindCount: 0,
        localHeadSha: '',
        remoteHeadSha: '',
        lastCheckedAt: checkedAt,
        lastError: 'Install root is not recorded for this app.',
      };
    }
    if (this.gitTransport === 'ssh-key' && !this.gitSshKeyPath) {
      return {
        appId,
        trackedRef,
        status: 'check-failed',
        canUpdate: null,
        aheadCount: 0,
        behindCount: 0,
        localHeadSha: '',
        remoteHeadSha: '',
        lastCheckedAt: checkedAt,
        lastError: 'HOME_BASE_GIT_SSH_KEY_PATH is required when HOME_BASE_GIT_TRANSPORT=ssh-key',
      };
    }

    const localHead = this.runGit(['rev-parse', 'HEAD'], installRoot);
    if (localHead.status !== 0) {
      return {
        appId,
        trackedRef,
        status: 'check-failed',
        canUpdate: null,
        aheadCount: 0,
        behindCount: 0,
        localHeadSha: '',
        remoteHeadSha: '',
        lastCheckedAt: checkedAt,
        lastError: formatGitFailure('Unable to read local HEAD', localHead),
      };
    }

    const localHeadSha = String(localHead.stdout || '').trim();

    const fetch = this.runGit(['fetch', 'origin', '--prune'], installRoot);
    if (fetch.status !== 0) {
      return {
        appId,
        trackedRef,
        status: 'check-failed',
        canUpdate: null,
        aheadCount: 0,
        behindCount: 0,
        localHeadSha,
        remoteHeadSha: '',
        lastCheckedAt: checkedAt,
        lastError: formatGitFailure(`Unable to fetch origin/${trackedRef}`, fetch),
      };
    }

    const remoteHead = this.runGit(['rev-parse', `origin/${trackedRef}`], installRoot);
    if (remoteHead.status !== 0) {
      return {
        appId,
        trackedRef,
        status: 'check-failed',
        canUpdate: null,
        aheadCount: 0,
        behindCount: 0,
        localHeadSha,
        remoteHeadSha: '',
        lastCheckedAt: checkedAt,
        lastError: formatGitFailure(`Unable to read origin/${trackedRef}`, remoteHead),
      };
    }

    const remoteHeadSha = String(remoteHead.stdout || '').trim();
    const revList = this.runGit(['rev-list', '--left-right', '--count', `HEAD...origin/${trackedRef}`], installRoot);
    if (revList.status !== 0) {
      return {
        appId,
        trackedRef,
        status: 'check-failed',
        canUpdate: null,
        aheadCount: 0,
        behindCount: 0,
        localHeadSha,
        remoteHeadSha,
        lastCheckedAt: checkedAt,
        lastError: formatGitFailure(`Unable to compare HEAD with origin/${trackedRef}`, revList),
      };
    }

    const { ahead, behind } = parseRevListCounts(revList.stdout || '0 0');
    let status = 'up-to-date';
    if (behind > 0 && ahead > 0) status = 'diverged';
    else if (behind > 0) status = 'update-available';
    else if (ahead > 0) status = 'ahead';

    return {
      appId,
      trackedRef,
      status,
      canUpdate: behind > 0,
      aheadCount: ahead,
      behindCount: behind,
      localHeadSha,
      remoteHeadSha,
      lastCheckedAt: checkedAt,
      lastError: '',
    };
  }

  async getSnapshot(installations = [], { force = false } = {}) {
    await this.refreshInstalledApps(installations, { force });
    return this.buildSnapshotByApp();
  }

  schedule(installationsProvider) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      Promise.resolve()
        .then(() => installationsProvider())
        .then((installations) => this.refreshInstalledApps(Array.isArray(installations) ? installations : [], { force: true }))
        .catch((error) => {
          this.logger.warn?.(`[homebase] app update scan failed: ${error.message}`);
        });
    }, this.checkIntervalMs);

    if (typeof this.timer.unref === 'function') this.timer.unref();
    return { intervalMs: this.checkIntervalMs };
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  AppUpdateMonitor,
};
