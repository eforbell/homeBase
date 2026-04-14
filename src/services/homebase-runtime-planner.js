function renderServiceUnit({ appDir, envFile, user, port }) {
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
    `ExecStart=/usr/bin/env PORT=${port} node server.js`,
    'Restart=always',
    'RestartSec=5',
    'KillSignal=SIGTERM',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function renderEnvFile({ port, stateDbPath, baseInstallDir, baseBackupDir, baseConfigDir, gitTransport, enablePrivilegedJobs }) {
  return [
    `PORT=${port}`,
    `HOME_BASE_STATE_DB=${stateDbPath}`,
    `HOME_BASE_INSTALL_DIR=${baseInstallDir}`,
    `HOME_BASE_BACKUP_DIR=${baseBackupDir}`,
    `HOME_BASE_CONFIG_DIR=${baseConfigDir}`,
    `HOME_BASE_GIT_TRANSPORT=${gitTransport}`,
    `HOME_BASE_ENABLE_PRIVILEGED_JOBS=${enablePrivilegedJobs ? '1' : '0'}`,
    '',
  ].join('\n');
}

function buildHomeBaseRuntimePlan(config = {}, options = {}) {
  const generatedAt = new Date().toISOString();
  const runtimeUser = options.runtimeUser || config.homeBaseRuntimeUser || 'homebase';
  const serviceUser = config.serviceUser || 'sovereign';
  const appDir = options.appDir || config.homeBaseAppDir || '/opt/sovereign-home/homebase';
  const stateDir = options.stateDir || config.homeBaseStateDir || '/var/lib/sovereign-home/homebase';
  const stateDbPath = options.stateDbPath || config.homeBaseRuntimeStateDbPath || `${stateDir}/home-base.sqlite3`;
  const envFile = options.envFile || config.homeBaseEnvFile || '/etc/sovereign-home/homebase.env';
  const serviceName = 'homebase';
  const port = options.port || config.port || 3080;
  const startImmediately = options.startImmediately === true;
  const enablePrivilegedJobs = options.enablePrivilegedJobs !== undefined
    ? options.enablePrivilegedJobs === true
    : config.homeBaseEnablePrivilegedJobs !== false;
  const sudoersFile = `/etc/sudoers.d/${serviceName}`;

  const envContent = renderEnvFile({
    port,
    stateDbPath,
    baseInstallDir: config.baseInstallDir || '/opt/sovereign-home/apps',
    baseBackupDir: config.baseBackupDir || '/var/lib/sovereign-home/backups',
    baseConfigDir: config.baseConfigDir || '/etc/sovereign-home',
    gitTransport: config.gitTransport || 'https',
    enablePrivilegedJobs,
  });

  const serviceContent = renderServiceUnit({
    appDir,
    envFile,
    user: runtimeUser,
    port,
  });

  const executionSteps = [
    {
      id: 'prepare-runtime',
      title: 'Prepare Home Base runtime directories and config',
      run: [
    `id -u ${runtimeUser} >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir ${stateDir} --shell /usr/sbin/nologin ${runtimeUser}`,
    `sudo usermod -aG ${serviceUser} ${runtimeUser}`,
    `sudo install -d -m 0755 -o ${runtimeUser} -g ${runtimeUser} ${appDir}`,
    `sudo install -d -m 0755 -o ${runtimeUser} -g ${runtimeUser} ${stateDir}`,
    `sudo install -d -m 0755 -o root -g root ${envFile.substring(0, envFile.lastIndexOf('/')) || '/etc'}`,
    `tar --exclude .git --exclude .data --exclude node_modules -cf - . | sudo tar -C ${appDir} -xf -`,
    `sudo chown -R ${runtimeUser}:${runtimeUser} ${appDir} ${stateDir}`,
    config.stateDbPath && config.stateDbPath !== stateDbPath
      ? `if [ -f ${config.stateDbPath} ]; then sudo cp ${config.stateDbPath} ${stateDbPath}; sudo chown ${runtimeUser}:${runtimeUser} ${stateDbPath}; fi`
      : null,
    `sudo tee ${envFile} > /dev/null <<'EOF'\n${envContent}EOF`,
    `sudo tee /etc/systemd/system/${serviceName}.service > /dev/null <<'EOF'\n${serviceContent}EOF`,
    `sudo -u ${runtimeUser} -H bash -lc 'cd ${appDir} && if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi'`,
    'sudo systemctl daemon-reload',
    `sudo systemctl enable ${serviceName}`,
      ].filter(Boolean),
    },
    {
      id: 'configure-privileges',
      title: enablePrivilegedJobs
        ? 'Allow Home Base service user to run host-management jobs'
        : 'Skip privileged job sudoers configuration',
      run: enablePrivilegedJobs
        ? [
            `sudo tee ${sudoersFile} > /dev/null <<'EOF'\n${runtimeUser} ALL=(ALL) NOPASSWD:ALL\nEOF`,
            `sudo chmod 0440 ${sudoersFile}`,
            `sudo visudo -cf ${sudoersFile}`,
          ]
        : [
            `echo "Privileged jobs disabled. Home Base service will serve UI/status only until executor privileges are configured."`,
          ],
    },
    {
      id: 'activate-service',
      title: startImmediately ? 'Start Home Base service now' : 'Defer Home Base service start until shell-run instance stops',
      run: startImmediately
        ? [
            `sudo systemctl restart ${serviceName}`,
            `for attempt in $(seq 1 20); do curl --fail --silent --show-error http://127.0.0.1:${port}/api/state && exit 0; sleep 1; done; echo "Timed out waiting for Home Base runtime on ${port}" >&2; exit 1`,
          ]
        : [
            `echo "Home Base service installed and enabled. Stop the shell-run instance, then run: sudo systemctl start ${serviceName}"`,
          ],
    },
  ];
  const commands = executionSteps.flatMap((step) => step.run);

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
      port,
      startImmediately,
      enablePrivilegedJobs,
      sudoersFile,
    },
    files: {
      'homebase.env': envContent,
      'homebase.service': serviceContent,
    },
    executionSteps,
    commands,
    script: `#!/usr/bin/env bash\nset -euo pipefail\n\n${commands.join('\n')}\n`,
  };
}

module.exports = {
  buildHomeBaseRuntimePlan,
};
