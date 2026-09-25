const path = require('path');

function numberFromEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFromEnv(value, fallback) {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function executionModeFromEnv(value) {
  const mode = String(value || '').trim().toLowerCase();
  return ['legacy-sudo', 'executor'].includes(mode) ? mode : 'plan-only';
}

function loadConfig() {
  const rootDir = process.cwd();
  const dataDir = process.env.HOME_BASE_DATA_DIR || path.join(rootDir, '.data');
  const stateDbPath = process.env.HOME_BASE_STATE_DB || path.join(dataDir, 'home-base.sqlite3');
  const baseInstallDir = process.env.HOME_BASE_INSTALL_DIR || '/opt/sovereign-home/apps';
  const sharedRoot = process.env.HOME_BASE_SHARED_ROOT || path.dirname(baseInstallDir);
  const assetsRoot = process.env.HOME_BASE_ASSETS_ROOT || path.join(sharedRoot, 'assets');
  const homeBaseExecutionMode = executionModeFromEnv(process.env.HOME_BASE_EXECUTION_MODE);
  const homeBaseEnablePrivilegedJobs = ['legacy-sudo', 'executor'].includes(homeBaseExecutionMode)
    && boolFromEnv(process.env.HOME_BASE_ENABLE_PRIVILEGED_JOBS, false);
  // Hosts upgraded from before execution modes existed enabled privileged jobs with this flag alone.
  // They now fail closed to plan-only; this lets the service say exactly how to opt back in.
  const homeBaseExecutionModeMissing = !String(process.env.HOME_BASE_EXECUTION_MODE || '').trim()
    && boolFromEnv(process.env.HOME_BASE_ENABLE_PRIVILEGED_JOBS, false);

  return {
    appName: 'Home Base',
    rootDir,
    dataDir,
    stateDbPath,
    port: numberFromEnv(process.env.PORT, 3080),
    bindHost: process.env.HOME_BASE_BIND_HOST || '127.0.0.1',
    serviceUser: process.env.HOME_BASE_SERVICE_USER || 'sovereign',
    baseInstallDir,
    homeBaseSharedRoot: sharedRoot,
    homeBaseAssetsRoot: assetsRoot,
    baseBackupDir: process.env.HOME_BASE_BACKUP_DIR || '/var/lib/sovereign-home/backups',
    baseConfigDir: process.env.HOME_BASE_CONFIG_DIR || '/etc/sovereign-home',
    defaultHostname: process.env.HOME_BASE_DEFAULT_HOSTNAME || process.env.HOME_BASE_HOSTNAME || 'homebase',
    defaultDomain: process.env.HOME_BASE_DEFAULT_DOMAIN || process.env.HOME_BASE_DOMAIN || 'tailnet',
    gitTransport: process.env.HOME_BASE_GIT_TRANSPORT || 'https',
    gitSshKeyPath: process.env.HOME_BASE_GIT_SSH_KEY_PATH || '',
    gitSshKnownHostsPath: process.env.HOME_BASE_GIT_SSH_KNOWN_HOSTS_PATH || '',
    gitSshStrictHostKeyChecking: process.env.HOME_BASE_GIT_SSH_STRICT_HOST_KEY_CHECKING || 'accept-new',
    homeBaseRepositoryUrl: process.env.HOME_BASE_REPOSITORY_URL || 'https://github.com/eforbell/homeBase.git',
    homeBaseRepositorySshUrl: process.env.HOME_BASE_REPOSITORY_SSH_URL || 'git@github.com:eforbell/homeBase.git',
    homeBaseRuntimeUser: process.env.HOME_BASE_RUNTIME_USER || 'homebase',
    homeBaseAppDir: process.env.HOME_BASE_APP_DIR || '/opt/sovereign-home/homebase',
    homeBaseStateDir: process.env.HOME_BASE_RUNTIME_STATE_DIR || '/var/lib/sovereign-home/homebase',
    homeBaseEnvFile: process.env.HOME_BASE_ENV_FILE || '/etc/sovereign-home/homebase.env',
    homeBaseExecutionMode,
    homeBaseEnablePrivilegedJobs,
    homeBaseExecutionModeMissing,
    homeBaseExecutorSocket: process.env.HOME_BASE_EXECUTOR_SOCKET || '/run/homebase/executor.sock',
    // How the executor fetches app repositories on a legacy-sudo host that is adopting apps. Kept apart
    // from HOME_BASE_GIT_TRANSPORT, which the legacy path still uses for apps not adopted yet.
    homeBaseExecutorGitTransport: ['ssh', 'https'].includes(process.env.HOME_BASE_EXECUTOR_GIT_TRANSPORT) ? process.env.HOME_BASE_EXECUTOR_GIT_TRANSPORT : '',
    homeBaseAutoBootstrap: homeBaseEnablePrivilegedJobs
      && boolFromEnv(process.env.HOME_BASE_AUTO_BOOTSTRAP, false),
    homeBaseAutoBootstrapMode: process.env.HOME_BASE_AUTO_BOOTSTRAP_MODE || 'execute',
    homeBaseAutoBootstrapDelayMs: numberFromEnv(process.env.HOME_BASE_AUTO_BOOTSTRAP_DELAY_MS, 5000),
    sovereignFontMountPath: process.env.SOVEREIGN_FONT_MOUNT_PATH || '/_sovereign/fonts/',
    sovereignFontGoogleSansCssUrl: process.env.SOVEREIGN_FONT_SANS_CSS_URL || 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap',
    sovereignFontGoogleMonoCssUrl: process.env.SOVEREIGN_FONT_MONO_CSS_URL || 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap',
  };
}

module.exports = { loadConfig };
