const path = require('path');

function numberFromEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig() {
  const rootDir = process.cwd();
  const dataDir = process.env.HOME_BASE_DATA_DIR || path.join(rootDir, '.data');
  const stateDbPath = process.env.HOME_BASE_STATE_DB || path.join(dataDir, 'home-base.sqlite3');

  return {
    appName: 'Home Base',
    rootDir,
    dataDir,
    stateDbPath,
    port: numberFromEnv(process.env.PORT, 3080),
    serviceUser: process.env.HOME_BASE_SERVICE_USER || 'sovereign',
    baseInstallDir: process.env.HOME_BASE_INSTALL_DIR || '/opt/sovereign-home/apps',
    baseBackupDir: process.env.HOME_BASE_BACKUP_DIR || '/var/lib/sovereign-home/backups',
    baseConfigDir: process.env.HOME_BASE_CONFIG_DIR || '/etc/sovereign-home',
    defaultHostname: process.env.HOME_BASE_HOSTNAME || 'homebase',
    defaultDomain: process.env.HOME_BASE_DOMAIN || 'tailnet',
    gitTransport: process.env.HOME_BASE_GIT_TRANSPORT || 'https',
    gitSshKeyPath: process.env.HOME_BASE_GIT_SSH_KEY_PATH || '',
    gitSshKnownHostsPath: process.env.HOME_BASE_GIT_SSH_KNOWN_HOSTS_PATH || '',
    gitSshStrictHostKeyChecking: process.env.HOME_BASE_GIT_SSH_STRICT_HOST_KEY_CHECKING || 'accept-new',
    homeBaseRuntimeUser: process.env.HOME_BASE_RUNTIME_USER || 'homebase',
    homeBaseAppDir: process.env.HOME_BASE_APP_DIR || '/opt/sovereign-home/homebase',
    homeBaseStateDir: process.env.HOME_BASE_RUNTIME_STATE_DIR || '/var/lib/sovereign-home/homebase',
    homeBaseEnvFile: process.env.HOME_BASE_ENV_FILE || '/etc/sovereign-home/homebase.env',
  };
}

module.exports = { loadConfig };
