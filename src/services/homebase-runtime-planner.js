function renderServiceUnit({ appDir, envFile, user }) {
  return [
    '[Unit]',
    'Description=Home Base Control Plane',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${user}`,
    `WorkingDirectory=${appDir}`,
    `EnvironmentFile=${envFile}`,
    'ExecStart=/usr/bin/env node server.js',
    'Restart=always',
    'RestartSec=5',
    'KillSignal=SIGTERM',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function renderEnvFile({ port, stateDbPath, baseInstallDir, baseBackupDir, baseConfigDir, gitTransport }) {
  return [
    `PORT=${port}`,
    `HOME_BASE_STATE_DB=${stateDbPath}`,
    `HOME_BASE_INSTALL_DIR=${baseInstallDir}`,
    `HOME_BASE_BACKUP_DIR=${baseBackupDir}`,
    `HOME_BASE_CONFIG_DIR=${baseConfigDir}`,
    `HOME_BASE_GIT_TRANSPORT=${gitTransport}`,
    '',
  ].join('\n');
}

function buildHomeBaseRuntimePlan(config = {}) {
  const generatedAt = new Date().toISOString();
  const runtimeUser = config.homeBaseRuntimeUser || 'homebase';
  const appDir = config.homeBaseAppDir || '/opt/sovereign-home/homebase';
  const stateDir = config.homeBaseStateDir || '/var/lib/sovereign-home/homebase';
  const stateDbPath = config.homeBaseRuntimeStateDbPath || `${stateDir}/home-base.sqlite3`;
  const envFile = config.homeBaseEnvFile || '/etc/sovereign-home/homebase.env';
  const serviceName = 'homebase';

  const envContent = renderEnvFile({
    port: config.port || 3080,
    stateDbPath,
    baseInstallDir: config.baseInstallDir || '/opt/sovereign-home/apps',
    baseBackupDir: config.baseBackupDir || '/var/lib/sovereign-home/backups',
    baseConfigDir: config.baseConfigDir || '/etc/sovereign-home',
    gitTransport: config.gitTransport || 'https',
  });

  const serviceContent = renderServiceUnit({
    appDir,
    envFile,
    user: runtimeUser,
  });

  const commands = [
    `id -u ${runtimeUser} >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir ${stateDir} --shell /usr/sbin/nologin ${runtimeUser}`,
    `sudo install -d -m 0755 -o ${runtimeUser} -g ${runtimeUser} ${appDir}`,
    `sudo install -d -m 0755 -o ${runtimeUser} -g ${runtimeUser} ${stateDir}`,
    `tar --exclude .git --exclude .data --exclude node_modules -cf - . | sudo tar -C ${appDir} -xf -`,
    `sudo chown -R ${runtimeUser}:${runtimeUser} ${appDir} ${stateDir}`,
    `sudo tee ${envFile} > /dev/null <<'EOF'\n${envContent}EOF`,
    `sudo tee /etc/systemd/system/${serviceName}.service > /dev/null <<'EOF'\n${serviceContent}EOF`,
    `sudo -u ${runtimeUser} -H bash -lc 'cd ${appDir} && npm ci --omit=dev'`,
    'sudo systemctl daemon-reload',
    `sudo systemctl enable --now ${serviceName}`,
    `curl --fail --silent --show-error http://127.0.0.1:${config.port || 3080}/api/state`,
  ];

  return {
    kind: 'homebase-runtime',
    generatedAt,
    runtime: {
      user: runtimeUser,
      appDir,
      stateDir,
      stateDbPath,
      envFile,
      serviceName,
    },
    files: {
      'homebase.env': envContent,
      'homebase.service': serviceContent,
    },
    commands,
    script: `#!/usr/bin/env bash\nset -euo pipefail\n\n${commands.join('\n')}\n`,
  };
}

module.exports = {
  buildHomeBaseRuntimePlan,
};
