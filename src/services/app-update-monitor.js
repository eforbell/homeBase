const path = require('path');
const { spawn } = require('child_process');
const { appUpdateStatus: requestExecutorAppUpdateStatus } = require('../executor/client');
const { getAppById } = require('../catalog');

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

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function runProcess(command, args, { env = process.env, timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 500).unref?.();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: 1,
        stdout,
        stderr: stderr || error.message,
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timeoutHit = signal === 'SIGTERM' || signal === 'SIGKILL';
      resolve({
        status: Number.isInteger(code) ? code : 1,
        stdout,
        stderr: timeoutHit && !stderr ? `Process timed out after ${timeoutMs}ms` : stderr,
      });
    });
  });
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
    executionMode = 'plan-only',
    executorSocket = '',
    executorGitTransport = '',
    baseInstallDir = '/opt/sovereign-home/apps',
    executorAppUpdateStatus = requestExecutorAppUpdateStatus,
  } = {}) {
    this.stateStore = stateStore;
    this.executorAppUpdateStatus = executorAppUpdateStatus;
    this.logger = logger;
    this.defaultGitConfig = {
      serviceUser: String(serviceUser || '').trim(),
      gitTransport: String(gitTransport || 'https').trim() || 'https',
      gitSshKeyPath: String(gitSshKeyPath || '').trim(),
      gitSshKnownHostsPath: String(gitSshKnownHostsPath || '').trim(),
      gitSshStrictHostKeyChecking: String(gitSshStrictHostKeyChecking || 'accept-new').trim() || 'accept-new',
      executionMode: String(executionMode || 'plan-only'),
      executorSocket: String(executorSocket || ''),
      executorGitTransport: String(executorGitTransport || ''),
      baseInstallDir: String(baseInstallDir || '/opt/sovereign-home/apps'),
    };
    this.checkIntervalMs = Number.isFinite(checkIntervalMs) ? Math.max(10_000, checkIntervalMs) : DEFAULT_CHECK_INTERVAL_MS;
    this.staleAfterMs = Number.isFinite(staleAfterMs) ? Math.max(1_000, staleAfterMs) : DEFAULT_STALE_AFTER_MS;
    this.gitTimeoutMs = Number.isFinite(gitTimeoutMs) ? Math.max(1_000, gitTimeoutMs) : DEFAULT_GIT_TIMEOUT_MS;
    this.timer = null;
    this.scanPromise = null;
  }

  resolveGitConfig(overrides = null) {
    if (!overrides || typeof overrides !== 'object') return this.defaultGitConfig;
    return {
      serviceUser: String(overrides.serviceUser ?? this.defaultGitConfig.serviceUser).trim(),
      gitTransport: String(overrides.gitTransport ?? this.defaultGitConfig.gitTransport).trim() || 'https',
      gitSshKeyPath: String(overrides.gitSshKeyPath ?? this.defaultGitConfig.gitSshKeyPath).trim(),
      gitSshKnownHostsPath: String(overrides.gitSshKnownHostsPath ?? this.defaultGitConfig.gitSshKnownHostsPath).trim(),
      gitSshStrictHostKeyChecking: String(overrides.gitSshStrictHostKeyChecking ?? this.defaultGitConfig.gitSshStrictHostKeyChecking).trim() || 'accept-new',
      executionMode: String(overrides.executionMode ?? this.defaultGitConfig.executionMode),
      executorSocket: String(overrides.executorSocket ?? this.defaultGitConfig.executorSocket),
      executorGitTransport: String(overrides.executorGitTransport ?? this.defaultGitConfig.executorGitTransport),
      baseInstallDir: String(overrides.baseInstallDir ?? this.defaultGitConfig.baseInstallDir),
    };
  }

  // In executor mode the web service cannot run git as sovereign (no sudo under NoNewPrivileges), the
  // checkout's origin is a local mirror, and the SSH key is root-only; the executor answers instead.
  async evaluateViaExecutor(install, gitConfig, { appId, trackedRef, installRoot, checkedAt }) {
    const failed = (lastError, extra = {}) => ({
      appId, trackedRef, status: 'check-failed', canUpdate: null, aheadCount: 0, behindCount: 0,
      localHeadSha: '', remoteHeadSha: '', lastCheckedAt: checkedAt, lastError, ...extra,
    });
    const app = getAppById(appId);
    if (!app) return failed('App is no longer in the catalog.');
    const expectedRoot = path.join(gitConfig.baseInstallDir, app.repoKey);
    if (path.resolve(installRoot) !== expectedRoot) return failed(`Update checks in executor mode require the standard install root ${expectedRoot}.`);
    if (!/^(main|[a-f0-9]{40})$/.test(trackedRef)) return failed(`Executor update checks track main or a pinned commit, not ${trackedRef}.`);
    const transport = ['ssh', 'https'].includes(gitConfig.executorGitTransport) ? gitConfig.executorGitTransport
      : gitConfig.gitTransport === 'ssh' || gitConfig.gitTransport === 'ssh-key' ? 'ssh' : 'https';
    let result;
    try {
      result = await this.executorAppUpdateStatus(gitConfig.executorSocket, { appId, transport, ref: trackedRef }, { timeoutMs: 120_000 });
    } catch (error) {
      if (error.code === 'EXECUTOR_BUSY' || error.code === 'EXECUTOR_MAINTENANCE') {
        // An install or update is running; keep the last known answer rather than flapping to failed.
        const previous = this.buildSnapshotByApp()[appId];
        if (previous) return previous;
      }
      return failed(error.message || 'Executor update check failed.');
    }
    const base = { appId, trackedRef, localHeadSha: result.localHeadSha || '', remoteHeadSha: result.remoteHeadSha || '', lastCheckedAt: checkedAt, lastError: '' };
    if (result.pinned) {
      return { ...base, status: result.matchesPin ? 'up-to-date' : 'diverged', canUpdate: false, aheadCount: 0, behindCount: 0,
        lastError: result.matchesPin ? '' : 'Checkout no longer matches its pinned commit.' };
    }
    if (result.unknownLocalCommit) {
      return { ...base, status: 'diverged', canUpdate: false, aheadCount: 0, behindCount: 0,
        lastError: 'The installed commit is not on the upstream branch (local commits or an upstream force-push).' };
    }
    const ahead = result.aheadCount || 0;
    const behind = result.behindCount || 0;
    let status = 'up-to-date';
    if (behind > 0 && ahead > 0) status = 'diverged';
    else if (behind > 0) status = 'update-available';
    else if (ahead > 0) status = 'ahead';
    return { ...base, status, canUpdate: behind > 0, aheadCount: ahead, behindCount: behind };
  }

  buildGitSshCommand(gitConfig) {
    const parts = [
      'ssh',
      '-i', shellSingleQuote(gitConfig.gitSshKeyPath),
      '-o', 'IdentitiesOnly=yes',
      '-o', `StrictHostKeyChecking=${shellSingleQuote(gitConfig.gitSshStrictHostKeyChecking)}`,
    ];
    if (gitConfig.gitSshKnownHostsPath) {
      parts.push('-o', `UserKnownHostsFile=${shellSingleQuote(gitConfig.gitSshKnownHostsPath)}`);
    }
    return parts.join(' ');
  }

  buildGitInvocation(args, installRoot, overrides = null) {
    const gitConfig = this.resolveGitConfig(overrides);
    const env = { ...process.env };
    const gitArgs = ['-C', installRoot, ...args];
    let command = 'git';
    let commandArgs = gitArgs;

    if (gitConfig.serviceUser) {
      command = 'sudo';
      if (gitConfig.gitTransport === 'ssh') {
        commandArgs = ['--preserve-env=SSH_AUTH_SOCK', '-u', gitConfig.serviceUser, 'git', ...gitArgs];
      } else if (gitConfig.gitTransport === 'ssh-key') {
        commandArgs = ['-u', gitConfig.serviceUser, 'env', `GIT_SSH_COMMAND=${this.buildGitSshCommand(gitConfig)}`, 'git', ...gitArgs];
      } else {
        commandArgs = ['-u', gitConfig.serviceUser, 'git', ...gitArgs];
      }
    } else if (gitConfig.gitTransport === 'ssh-key') {
      env.GIT_SSH_COMMAND = this.buildGitSshCommand(gitConfig);
    }

    return { command, commandArgs, env, gitConfig };
  }

  async runGit(args, installRoot, overrides = null) {
    const { command, commandArgs, env } = this.buildGitInvocation(args, installRoot, overrides);
    return runProcess(command, commandArgs, {
      env,
      timeoutMs: this.gitTimeoutMs,
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

  async refreshInstalledApps(installations = [], { force = false, gitConfig = null } = {}) {
    if (this.scanPromise) return this.scanPromise;
    const task = (async () => {
      const snapshot = this.buildSnapshotByApp();
      const now = Date.now();
      for (const install of installations) {
        if (!install?.appId) continue;
        const current = snapshot[install.appId];
        if (!this.shouldRefreshStatus(current, now, force)) continue;
        const next = await this.evaluateInstallation(install, gitConfig);
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

  async evaluateInstallation(install, overrides = null) {
    const gitConfig = this.resolveGitConfig(overrides);
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

    // Adopted apps on a legacy-sudo host have a mirror-backed checkout too, so the executor answers.
    if (gitConfig.executionMode === 'executor' || ['executor', 'adopting'].includes(install.managedBy)) {
      return this.evaluateViaExecutor(install, gitConfig, { appId, trackedRef, installRoot, checkedAt });
    }

    if (gitConfig.gitTransport === 'ssh-key' && !gitConfig.gitSshKeyPath) {
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

    const localHead = await this.runGit(['rev-parse', 'HEAD'], installRoot, gitConfig);
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

    const fetch = await this.runGit(['fetch', 'origin', '--prune'], installRoot, gitConfig);
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

    const remoteHead = await this.runGit(['rev-parse', `origin/${trackedRef}`], installRoot, gitConfig);
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
    const revList = await this.runGit(['rev-list', '--left-right', '--count', `HEAD...origin/${trackedRef}`], installRoot, gitConfig);
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

  async getSnapshot(installations = [], { force = false, gitConfig = null } = {}) {
    await this.refreshInstalledApps(installations, { force, gitConfig });
    return this.buildSnapshotByApp();
  }

  schedule({ installationsProvider, gitConfigProvider = null } = {}) {
    if (typeof installationsProvider !== 'function') {
      throw new Error('installationsProvider is required');
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      Promise.resolve()
        .then(() => installationsProvider())
        .then((installations) => this.refreshInstalledApps(
          Array.isArray(installations) ? installations : [],
          {
            force: true,
            gitConfig: typeof gitConfigProvider === 'function' ? gitConfigProvider() : null,
          }
        ))
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
