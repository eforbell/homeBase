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

function loadConfig(env = process.env) {
  const rootDir = process.cwd();
  const dataDir = env.HOME_BASE_DATA_DIR || path.join(rootDir, '.data');
  const stateDbPath = env.HOME_BASE_STATE_DB || path.join(dataDir, 'home-base.sqlite3');
  const baseInstallDir = env.HOME_BASE_INSTALL_DIR || '/opt/sovereign-home/apps';
  const sharedRoot = env.HOME_BASE_SHARED_ROOT || path.dirname(baseInstallDir);
  const assetsRoot = env.HOME_BASE_ASSETS_ROOT || path.join(sharedRoot, 'assets');
  const homeBaseExecutionMode = executionModeFromEnv(env.HOME_BASE_EXECUTION_MODE);
  const homeBaseEnablePrivilegedJobs = ['legacy-sudo', 'executor'].includes(homeBaseExecutionMode)
    && boolFromEnv(env.HOME_BASE_ENABLE_PRIVILEGED_JOBS, false);
  // Hosts upgraded from before execution modes existed enabled privileged jobs with this flag alone.
  // They now fail closed to plan-only; this lets the service say exactly how to opt back in.
  const homeBaseExecutionModeMissing = !String(env.HOME_BASE_EXECUTION_MODE || '').trim()
    && boolFromEnv(env.HOME_BASE_ENABLE_PRIVILEGED_JOBS, false);

  return {
    appName: 'Home Base',
    rootDir,
    dataDir,
    stateDbPath,
    port: numberFromEnv(env.PORT, 3080),
    bindHost: env.HOME_BASE_BIND_HOST || '127.0.0.1',
    // Feature-10 D1: the socket nginx asks for each request's identity. Home Base listens once the ingress
    // cutover has created its directory; 'off' disables it (development machines).
    // SID-003: sovereignAuth's request guards, off | report | enforce (src/request-guard.js).
    requestGuards: String(env.HOME_BASE_REQUEST_GUARDS ?? '').trim().toLowerCase() || 'off',
    // SID-004: the household directory and its snapshot (src/identity/directory.js); needs HOME_BASE_INSTANCE.
    directory: boolFromEnv(env.HOME_BASE_DIRECTORY, false),
    // The SID-003 preview's members file, which the directory replaced; only to say so at startup.
    identityPreviewRetired: Boolean(String(env.HOME_BASE_IDENTITY_PREVIEW || '').trim()),
    identitySnapshotFile: env.HOME_BASE_IDENTITY_SNAPSHOT || '/var/lib/sovereign-home/identity/snapshot.json',
    identitySocket: env.HOME_BASE_IDENTITY_SOCKET === 'off' ? '' : (env.HOME_BASE_IDENTITY_SOCKET || '/run/homebase-identity/identity.sock'),
    // Feature-10 SID-001: this household's instance name (svc:<instance>-home, ...), unset until cutover.
    instance: String(env.HOME_BASE_INSTANCE || '').trim(),
    // A read-only Tailscale trust credential for D23 verification; absent means administrator confirmation.
    tailscaleApiCredentialPath: env.HOME_BASE_TAILSCALE_API_CREDENTIAL || path.join(env.HOME_BASE_CONFIG_DIR || '/etc/sovereign-home', 'tailscale-api.env'),
    administratorLogin: String(env.HOME_BASE_ADMINISTRATOR_LOGIN || '').trim(),
    serviceUser: env.HOME_BASE_SERVICE_USER || 'sovereign',
    baseInstallDir,
    homeBaseSharedRoot: sharedRoot,
    homeBaseAssetsRoot: assetsRoot,
    baseBackupDir: env.HOME_BASE_BACKUP_DIR || '/var/lib/sovereign-home/backups',
    baseConfigDir: env.HOME_BASE_CONFIG_DIR || '/etc/sovereign-home',
    defaultHostname: env.HOME_BASE_DEFAULT_HOSTNAME || env.HOME_BASE_HOSTNAME || 'homebase',
    defaultDomain: env.HOME_BASE_DEFAULT_DOMAIN || env.HOME_BASE_DOMAIN || 'tailnet',
    gitTransport: env.HOME_BASE_GIT_TRANSPORT || 'https',
    gitSshKeyPath: env.HOME_BASE_GIT_SSH_KEY_PATH || '',
    gitSshKnownHostsPath: env.HOME_BASE_GIT_SSH_KNOWN_HOSTS_PATH || '',
    gitSshStrictHostKeyChecking: env.HOME_BASE_GIT_SSH_STRICT_HOST_KEY_CHECKING || 'accept-new',
    homeBaseRepositoryUrl: env.HOME_BASE_REPOSITORY_URL || 'https://github.com/eforbell/homeBase.git',
    homeBaseRepositorySshUrl: env.HOME_BASE_REPOSITORY_SSH_URL || 'git@github.com:eforbell/homeBase.git',
    homeBaseRuntimeUser: env.HOME_BASE_RUNTIME_USER || 'homebase',
    homeBaseAppDir: env.HOME_BASE_APP_DIR || '/opt/sovereign-home/homebase',
    homeBaseStateDir: env.HOME_BASE_RUNTIME_STATE_DIR || '/var/lib/sovereign-home/homebase',
    homeBaseEnvFile: env.HOME_BASE_ENV_FILE || '/etc/sovereign-home/homebase.env',
    homeBaseExecutionMode,
    homeBaseEnablePrivilegedJobs,
    homeBaseExecutionModeMissing,
    homeBaseExecutorSocket: env.HOME_BASE_EXECUTOR_SOCKET || '/run/homebase/executor.sock',
    // How the executor fetches app repositories on a legacy-sudo host that is adopting apps. Kept apart
    // from HOME_BASE_GIT_TRANSPORT, which the legacy path still uses for apps not adopted yet.
    homeBaseExecutorGitTransport: ['ssh', 'https'].includes(env.HOME_BASE_EXECUTOR_GIT_TRANSPORT) ? env.HOME_BASE_EXECUTOR_GIT_TRANSPORT : '',
    homeBaseAutoBootstrap: homeBaseEnablePrivilegedJobs
      && boolFromEnv(env.HOME_BASE_AUTO_BOOTSTRAP, false),
    homeBaseAutoBootstrapMode: env.HOME_BASE_AUTO_BOOTSTRAP_MODE || 'execute',
    homeBaseAutoBootstrapDelayMs: numberFromEnv(env.HOME_BASE_AUTO_BOOTSTRAP_DELAY_MS, 5000),
    sovereignFontMountPath: env.SOVEREIGN_FONT_MOUNT_PATH || '/_sovereign/fonts/',
    sovereignFontGoogleSansCssUrl: env.SOVEREIGN_FONT_SANS_CSS_URL || 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap',
    sovereignFontGoogleMonoCssUrl: env.SOVEREIGN_FONT_MONO_CSS_URL || 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap',
  };
}

module.exports = { loadConfig };
