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
  };
}

module.exports = { loadConfig };
