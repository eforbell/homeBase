function renderServiceUnit({ appDir, envFile, user, port, stateDir }) {
  return [
    '[Unit]',
    'Description=Home Base Control Plane',
    'After=network-online.target',
    'Wants=network-online.target',
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
    'UMask=0077',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectControlGroups=true',
    'RestrictSUIDSGID=true',
    `ReadWritePaths=${stateDir}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function renderEnvFile({
  port,
  bindHost,
  stateDbPath,
  baseInstallDir,
  baseBackupDir,
  baseConfigDir,
  gitTransport,
  gitSshKeyPath,
  gitSshKnownHostsPath,
  gitSshStrictHostKeyChecking,
  repositoryUrl,
  repositorySshUrl,
  enablePrivilegedJobs,
  executionMode,
  defaultHostname,
  defaultDomain,
  autoBootstrap,
  autoBootstrapMode,
  autoBootstrapDelayMs,
  sharedRoot,
  assetsRoot,
  sovereignFontMountPath,
  sovereignFontSansCssUrl,
  sovereignFontMonoCssUrl,
}) {
  return [
    `PORT=${port}`,
    `HOME_BASE_BIND_HOST=${bindHost}`,
    `HOME_BASE_STATE_DB=${stateDbPath}`,
    `HOME_BASE_INSTALL_DIR=${baseInstallDir}`,
    `HOME_BASE_SHARED_ROOT=${sharedRoot}`,
    `HOME_BASE_ASSETS_ROOT=${assetsRoot}`,
    `HOME_BASE_BACKUP_DIR=${baseBackupDir}`,
    `HOME_BASE_CONFIG_DIR=${baseConfigDir}`,
    `HOME_BASE_GIT_TRANSPORT=${gitTransport}`,
    `HOME_BASE_GIT_SSH_KEY_PATH=${gitSshKeyPath || ''}`,
    `HOME_BASE_GIT_SSH_KNOWN_HOSTS_PATH=${gitSshKnownHostsPath || ''}`,
    `HOME_BASE_GIT_SSH_STRICT_HOST_KEY_CHECKING=${gitSshStrictHostKeyChecking || 'accept-new'}`,
    `HOME_BASE_REPOSITORY_URL=${repositoryUrl || 'https://github.com/eforbell/homeBase.git'}`,
    `HOME_BASE_REPOSITORY_SSH_URL=${repositorySshUrl || 'git@github.com:eforbell/homeBase.git'}`,
    `HOME_BASE_DEFAULT_HOSTNAME=${defaultHostname || 'homebase'}`,
    `HOME_BASE_DEFAULT_DOMAIN=${defaultDomain || 'tailnet'}`,
    `HOME_BASE_EXECUTION_MODE=${executionMode}`,
    `HOME_BASE_ENABLE_PRIVILEGED_JOBS=${enablePrivilegedJobs ? '1' : '0'}`,
    `HOME_BASE_AUTO_BOOTSTRAP=${autoBootstrap ? '1' : '0'}`,
    `HOME_BASE_AUTO_BOOTSTRAP_MODE=${autoBootstrapMode || 'execute'}`,
    `HOME_BASE_AUTO_BOOTSTRAP_DELAY_MS=${autoBootstrapDelayMs || 5000}`,
    `SOVEREIGN_FONT_MOUNT_PATH=${sovereignFontMountPath || '/_sovereign/fonts/'}`,
    `SOVEREIGN_FONT_SANS_CSS_URL=${sovereignFontSansCssUrl || 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap'}`,
    `SOVEREIGN_FONT_MONO_CSS_URL=${sovereignFontMonoCssUrl || 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap'}`,
    '',
  ].join('\n');
}

function buildHomeBaseRuntimePlan(config = {}, options = {}) {
  const generatedAt = new Date().toISOString();
  const runtimeUser = options.runtimeUser || config.homeBaseRuntimeUser || 'homebase';
  const appDir = options.appDir || config.homeBaseAppDir || '/opt/sovereign-home/homebase';
  const stateDir = options.stateDir || config.homeBaseStateDir || '/var/lib/sovereign-home/homebase';
  const stateDbPath = options.stateDbPath || config.homeBaseRuntimeStateDbPath || `${stateDir}/home-base.sqlite3`;
  const envFile = options.envFile || config.homeBaseEnvFile || '/etc/sovereign-home/homebase.env';
  const serviceName = 'homebase';
  const port = options.port || config.port || 3080;
  const startImmediately = options.startImmediately === true;
  const requestedPrivilegedJobs = options.enablePrivilegedJobs !== undefined
    ? options.enablePrivilegedJobs === true
    : config.homeBaseEnablePrivilegedJobs === true;
  if (requestedPrivilegedJobs) {
    const error = new Error('Home Base no longer generates privileged sudoers configuration; install the service in plan-only mode.');
    error.code = 'UNSAFE_PRIVILEGED_CONFIGURATION';
    throw error;
  }
  if (options.autoBootstrap === true || config.homeBaseAutoBootstrap === true) {
    const error = new Error('Home Base service auto-bootstrap is unavailable in the hardened plan-only runtime.');
    error.code = 'UNSAFE_AUTO_BOOTSTRAP_CONFIGURATION';
    throw error;
  }
  const executionMode = 'plan-only';
  const enablePrivilegedJobs = false;
  const autoBootstrap = false;
  const autoBootstrapMode = options.autoBootstrapMode || config.homeBaseAutoBootstrapMode || 'execute';
  const autoBootstrapDelayMs = options.autoBootstrapDelayMs || config.homeBaseAutoBootstrapDelayMs || 5000;
  const sudoersFile = `/etc/sudoers.d/${serviceName}`;

  const envContent = renderEnvFile({
    port,
    bindHost: options.bindHost || config.bindHost || '127.0.0.1',
    stateDbPath,
    baseInstallDir: config.baseInstallDir || '/opt/sovereign-home/apps',
    sharedRoot: config.homeBaseSharedRoot || '/opt/sovereign-home',
    assetsRoot: config.homeBaseAssetsRoot || '/opt/sovereign-home/assets',
    baseBackupDir: config.baseBackupDir || '/var/lib/sovereign-home/backups',
    baseConfigDir: config.baseConfigDir || '/etc/sovereign-home',
    gitTransport: config.gitTransport || 'https',
    gitSshKeyPath: config.gitSshKeyPath || '',
    gitSshKnownHostsPath: config.gitSshKnownHostsPath || '',
    gitSshStrictHostKeyChecking: config.gitSshStrictHostKeyChecking || 'accept-new',
    repositoryUrl: config.homeBaseRepositoryUrl || 'https://github.com/eforbell/homeBase.git',
    repositorySshUrl: config.homeBaseRepositorySshUrl || 'git@github.com:eforbell/homeBase.git',
    defaultHostname: config.defaultHostname || 'homebase',
    defaultDomain: config.defaultDomain || 'tailnet',
    enablePrivilegedJobs,
    executionMode,
    autoBootstrap,
    autoBootstrapMode,
    autoBootstrapDelayMs,
    sovereignFontMountPath: config.sovereignFontMountPath || '/_sovereign/fonts/',
    sovereignFontSansCssUrl: config.sovereignFontGoogleSansCssUrl || 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap',
    sovereignFontMonoCssUrl: config.sovereignFontGoogleMonoCssUrl || 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap',
  });

  const serviceContent = renderServiceUnit({
    appDir,
    envFile,
    user: runtimeUser,
    port,
    stateDir,
  });

  const executionSteps = [
    {
      id: 'prepare-runtime',
      title: 'Prepare Home Base runtime directories and config',
      run: [
    `id -u ${runtimeUser} >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir ${stateDir} --shell /usr/sbin/nologin ${runtimeUser}`,
    `sudo install -d -m 0755 -o root -g root ${appDir}`,
    `sudo install -d -m 0700 -o ${runtimeUser} -g ${runtimeUser} ${stateDir}`,
    `sudo install -d -m 0755 -o root -g root ${envFile.substring(0, envFile.lastIndexOf('/')) || '/etc'}`,
    `tar --exclude .data --exclude node_modules -cf - . | sudo tar -C ${appDir} -xf -`,
    `sudo chown -R root:root ${appDir}`,
    `sudo chmod -R go-w ${appDir}`,
    `sudo chown -R ${runtimeUser}:${runtimeUser} ${stateDir}`,
    config.stateDbPath && config.stateDbPath !== stateDbPath
      ? `if [ -f ${config.stateDbPath} ]; then sudo cp ${config.stateDbPath} ${stateDbPath}; sudo chown ${runtimeUser}:${runtimeUser} ${stateDbPath}; fi`
      : null,
    `sudo tee ${envFile} > /dev/null <<'EOF'\n${envContent}EOF`,
    `sudo chown root:${runtimeUser} ${envFile}`,
    `sudo chmod 0640 ${envFile}`,
    `sudo tee /etc/systemd/system/${serviceName}.service > /dev/null <<'EOF'\n${serviceContent}EOF`,
    `sudo chown root:root /etc/systemd/system/${serviceName}.service`,
    `sudo chmod 0644 /etc/systemd/system/${serviceName}.service`,
    'sudo systemctl daemon-reload',
    `sudo systemctl enable ${serviceName}`,
      ].filter(Boolean),
    },
    {
      id: 'verify-privilege-boundary',
      title: 'Verify the installed service has no legacy broad sudoers access',
      run: [
        `if sudo test -f ${sudoersFile} && sudo grep -Eq '^[[:space:]]*${runtimeUser}[[:space:]]+.*NOPASSWD:[[:space:]]*ALL([[:space:]]|$)' ${sudoersFile}; then echo "Refusing to continue while legacy broad sudoers exists at ${sudoersFile}. Remove it before installing the hardened service." >&2; exit 1; fi`,
        'echo "Home Base will run in plan-only mode. Execute reviewed host plans from an operator shell."',
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
      executionMode,
      autoBootstrap,
      autoBootstrapMode,
      autoBootstrapDelayMs,
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
