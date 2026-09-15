const SAFE_RUNTIME_USER_PATTERN = /^[a-z_][a-z0-9_-]*$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertSafeRuntimeUser(value) {
  if (!SAFE_RUNTIME_USER_PATTERN.test(value)) {
    fail('INVALID_RUNTIME_USER', 'runtimeUser must be a valid system account name');
  }
}

function assertSafeAbsolutePath(name, value) {
  if (!SAFE_PATH_PATTERN.test(value) || value.split('/').includes('..')) {
    fail('INVALID_RUNTIME_PATH', `${name} must be an absolute path containing only letters, numbers, dots, dashes, underscores, and slashes`);
  }
}

function assertSingleLine(name, value) {
  if (String(value).includes('\0') || /[\r\n]/.test(String(value))) {
    fail('INVALID_RUNTIME_VALUE', `${name} must be a single-line value`);
  }
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

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
  const runtimeUser = String(options.runtimeUser || config.homeBaseRuntimeUser || 'homebase');
  const appDir = String(options.appDir || config.homeBaseAppDir || '/opt/sovereign-home/homebase');
  const stateDir = String(options.stateDir || config.homeBaseStateDir || '/var/lib/sovereign-home/homebase');
  const stateDbPath = String(options.stateDbPath || config.homeBaseRuntimeStateDbPath || `${stateDir}/home-base.sqlite3`);
  const envFile = String(options.envFile || config.homeBaseEnvFile || '/etc/sovereign-home/homebase.env');
  const serviceName = 'homebase';
  const configuredPort = Number(config.port);
  const port = Number(options.port !== undefined
    ? options.port
    : (Number.isInteger(configuredPort) && configuredPort >= 1 ? configuredPort : 3080));
  const requestedBindHost = String(options.bindHost ?? config.bindHost ?? '127.0.0.1');
  const startImmediately = options.startImmediately === true;
  assertSafeRuntimeUser(runtimeUser);
  assertSafeAbsolutePath('appDir', appDir);
  assertSafeAbsolutePath('stateDir', stateDir);
  assertSafeAbsolutePath('stateDbPath', stateDbPath);
  assertSafeAbsolutePath('envFile', envFile);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('INVALID_RUNTIME_PORT', 'port must be an integer between 1 and 65535');
  }
  if (requestedBindHost !== '127.0.0.1') {
    fail('INVALID_BIND_HOST', 'the hardened runtime binds only to 127.0.0.1');
  }
  const bindHost = '127.0.0.1';
  const requestedPrivilegedJobs = options.enablePrivilegedJobs !== undefined
    ? options.enablePrivilegedJobs === true
    : config.homeBaseEnablePrivilegedJobs === true;
  if (requestedPrivilegedJobs) {
    fail('UNSAFE_PRIVILEGED_CONFIGURATION', 'Home Base no longer generates privileged sudoers configuration; install the service in plan-only mode.');
  }
  if (options.autoBootstrap === true || config.homeBaseAutoBootstrap === true) {
    fail('UNSAFE_AUTO_BOOTSTRAP_CONFIGURATION', 'Home Base service auto-bootstrap is unavailable in the hardened plan-only runtime.');
  }
  const executionMode = 'plan-only';
  const enablePrivilegedJobs = false;
  const autoBootstrap = false;
  const autoBootstrapMode = options.autoBootstrapMode || config.homeBaseAutoBootstrapMode || 'execute';
  const autoBootstrapDelayMs = options.autoBootstrapDelayMs || config.homeBaseAutoBootstrapDelayMs || 5000;
  const sudoersFile = `/etc/sudoers.d/${serviceName}`;
  if (!['execute', 'dry-run'].includes(autoBootstrapMode)) {
    fail('INVALID_AUTO_BOOTSTRAP_MODE', 'autoBootstrapMode must be execute or dry-run');
  }
  if (!Number.isInteger(Number(autoBootstrapDelayMs)) || Number(autoBootstrapDelayMs) < 0) {
    fail('INVALID_AUTO_BOOTSTRAP_DELAY', 'autoBootstrapDelayMs must be a non-negative integer');
  }

  const envValues = {
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
    sovereignFontMountPath: config.sovereignFontMountPath || '/_sovereign/fonts/',
    sovereignFontSansCssUrl: config.sovereignFontGoogleSansCssUrl || 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap',
    sovereignFontMonoCssUrl: config.sovereignFontGoogleMonoCssUrl || 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap',
  };
  for (const [name, value] of Object.entries(envValues)) assertSingleLine(name, value);
  if (!['https', 'ssh', 'ssh-key'].includes(envValues.gitTransport)) {
    fail('INVALID_GIT_TRANSPORT', 'gitTransport must be https, ssh, or ssh-key');
  }
  for (const name of ['baseInstallDir', 'sharedRoot', 'assetsRoot', 'baseBackupDir', 'baseConfigDir']) {
    assertSafeAbsolutePath(name, String(envValues[name]));
  }
  for (const name of ['gitSshKeyPath', 'gitSshKnownHostsPath']) {
    if (envValues[name]) assertSafeAbsolutePath(name, String(envValues[name]));
  }

  const envContent = renderEnvFile({
    port,
    bindHost,
    stateDbPath,
    ...envValues,
    enablePrivilegedJobs,
    executionMode,
    autoBootstrap,
    autoBootstrapMode,
    autoBootstrapDelayMs,
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
    `id -u ${shellSingleQuote(runtimeUser)} >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir ${shellSingleQuote(stateDir)} --shell /usr/sbin/nologin ${shellSingleQuote(runtimeUser)}`,
    `sudo install -d -m 0755 -o root -g root ${shellSingleQuote(appDir)}`,
    `sudo install -d -m 0700 -o ${shellSingleQuote(runtimeUser)} -g ${shellSingleQuote(runtimeUser)} ${shellSingleQuote(stateDir)}`,
    `sudo install -d -m 0755 -o root -g root ${shellSingleQuote(envFile.substring(0, envFile.lastIndexOf('/')) || '/etc')}`,
    `tar --exclude .data --exclude node_modules -cf - . | sudo tar -C ${shellSingleQuote(appDir)} -xf -`,
    `sudo chown -R root:root ${shellSingleQuote(appDir)}`,
    `sudo chmod -R go-w ${shellSingleQuote(appDir)}`,
    `sudo chown -R ${shellSingleQuote(`${runtimeUser}:${runtimeUser}`)} ${shellSingleQuote(stateDir)}`,
    config.stateDbPath && config.stateDbPath !== stateDbPath
      ? `if [ -f ${shellSingleQuote(config.stateDbPath)} ]; then sudo cp ${shellSingleQuote(config.stateDbPath)} ${shellSingleQuote(stateDbPath)}; sudo chown ${shellSingleQuote(`${runtimeUser}:${runtimeUser}`)} ${shellSingleQuote(stateDbPath)}; fi`
      : null,
    `sudo tee ${shellSingleQuote(envFile)} > /dev/null <<'EOF'\n${envContent}EOF`,
    `sudo chown ${shellSingleQuote(`root:${runtimeUser}`)} ${shellSingleQuote(envFile)}`,
    `sudo chmod 0640 ${shellSingleQuote(envFile)}`,
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
        `if sudo test -f ${shellSingleQuote(sudoersFile)}; then echo "Refusing to continue while an existing Home Base sudoers policy is present at ${sudoersFile}. Remove it before installing the hardened service." >&2; exit 1; fi`,
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
  assertSafeAbsolutePath,
};
