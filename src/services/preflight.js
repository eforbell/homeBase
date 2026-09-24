const { spawnSync } = require('child_process');

const CRITICAL_CHECK_IDS = new Set(['os', 'sudo', 'systemd', 'nginx-config', 'postgres-service', 'executor']);

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runShell(command) {
  const result = spawnSync('/bin/bash', ['-c', command], {
    encoding: 'utf8',
    timeout: 5000,
  });

  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim() || (result.error?.code === 'ETIMEDOUT' ? 'check timed out' : ''),
  };
}

function getCheckSeverity(id, config = {}) {
  return CRITICAL_CHECK_IDS.has(id) ? 'critical' : 'warning';
}

function buildCheck(id, title, command, hint, runCommand = runShell, config = {}, { missingSummary = null } = {}) {
  const result = runCommand(command);
  // `command -v x` fails silently when x is absent; say so instead of reporting a bare exit code.
  if (!result.ok && missingSummary && !result.stdout && !result.stderr) {
    return { id, title, command, severity: getCheckSeverity(id, config), ok: false, summary: missingSummary, hint };
  }
  return {
    id,
    title,
    command,
    severity: getCheckSeverity(id, config),
    ok: result.ok,
    summary: result.ok ? (result.stdout || 'ok') : (result.stderr || result.stdout || `exit ${result.exitCode}`),
    hint,
  };
}

function buildNotEvaluatedCheck(id, title, hint, config = {}) {
  return {
    id,
    title,
    command: '',
    severity: getCheckSeverity(id, config),
    ok: null,
    status: 'not-evaluated',
    summary: 'Not evaluated by the unprivileged Home Base web service.',
    hint,
  };
}

function buildExecutorCheck(id, title, hint, executorStatus, config) {
  const fact = executorStatus?.host?.checks?.[id];
  if (!fact) {
    return {
      ...buildNotEvaluatedCheck(id, title, hint, config),
      summary: executorStatus?.reachable
        ? 'The executor does not report this check; repair it with install.sh --repair.'
        : 'The privileged executor is unreachable, so this check could not run.',
    };
  }
  return { id, title, command: '', source: 'executor', severity: getCheckSeverity(id, config), ok: fact.ok, summary: fact.summary || (fact.ok ? 'ok' : 'failed'), hint };
}

function buildExecutorModeChecks(config, executorStatus) {
  const reachable = Boolean(executorStatus?.reachable);
  const checks = [
    {
      id: 'executor',
      title: 'Privileged executor reachable',
      command: '',
      severity: getCheckSeverity('executor', config),
      ok: reachable,
      summary: reachable
        ? `protocol ${executorStatus.capabilities?.protocolVersions?.join(', ') || '?'}, mutations ${executorStatus.capabilities?.mutationsEnabled ? 'enabled' : 'disabled'}`
        : (executorStatus?.error || 'No response from the executor socket.'),
      hint: 'On the host: sudo systemctl status homebase-executor.socket; repair with sudo bash install.sh --repair.',
    },
    buildExecutorCheck('nginx-config', 'nginx configuration validates', 'Checked by the executor with nginx -t. Inspect with: sudo nginx -t', executorStatus, config),
    buildExecutorCheck('nginx-gateway', 'nginx gateway serves managed apps', 'Run host bootstrap (or any app install) to install and enable the managed gateway site.', executorStatus, config),
  ];
  if (config.gitTransport === 'ssh' || config.gitTransport === 'ssh-key') {
    const key = executorStatus?.host?.checks?.['git-deploy-key'];
    checks.push(key ? {
      id: 'git-ssh-key',
      title: 'Git deploy key installed (root-only)',
      command: '',
      source: 'executor',
      severity: getCheckSeverity('git-ssh-key', config),
      ok: key.ok,
      summary: { present: 'Deploy key present at /etc/sovereign-home/git/deploy_key', missing: 'No deploy key installed', insecure: 'Deploy key is not root-owned with mode 0600' }[key.status] || key.status,
      hint: 'On the host: sudo bash install.sh --source-dir <checkout> --repair --git-ssh-key <path-to-private-key>',
    } : buildNotEvaluatedCheck('git-ssh-key', 'Git deploy key installed (root-only)', 'The executor holds the deploy key; it could not be queried.', config));
  }
  return checks;
}

function runPreflightChecks(config = {}, { runCommand = runShell, executorStatus = null } = {}) {
  const executorMode = config.homeBaseExecutionMode === 'executor';
  const checks = [
    buildCheck('os', 'Debian-family host detected', 'test -f /etc/debian_version && . /etc/os-release && echo "$PRETTY_NAME"', 'Home Base currently targets Ubuntu/Debian hosts.', runCommand, config),
    // In executor mode the web service never uses sudo (NoNewPrivileges forbids it), so sudo is irrelevant.
    ...(executorMode ? [] : [buildCheck('sudo', 'sudo available', 'command -v sudo', 'Install and configure sudo or run Home Base in a root context.', runCommand, config)]),
    buildCheck('systemd', 'systemd available', 'command -v systemctl', 'This host must support systemd-managed services.', runCommand, config),
    buildCheck('git', 'git installed', 'command -v git && git --version', 'Install git before attempting app installs.', runCommand, config),
    buildCheck('node', 'Node.js installed', 'command -v node && node --version', 'Install Node.js 18+ for Home Base and Node-managed apps.', runCommand, config),
    buildCheck('python3', 'Python 3 installed', 'command -v python3 && python3 --version', 'Install Python 3 for Bitcoin Accounting and SQLite state support.', runCommand, config),
    buildCheck('psql', 'PostgreSQL client installed', 'command -v psql && psql --version', 'Install postgresql-client so Home Base can run schema and backup commands.', runCommand, config),
    buildCheck('nginx', 'nginx installed', 'command -v nginx && nginx -v', 'Install nginx before enabling routed apps.', runCommand, config),
    buildCheck('postgres-service', 'PostgreSQL service active', 'systemctl is-active postgresql', 'Start PostgreSQL or finish bootstrap before app installs.', runCommand, config),
    ...(executorMode ? buildExecutorModeChecks(config, executorStatus) : [
      buildCheck('nginx-config', 'nginx configuration validates', 'sudo -n nginx -t', 'Run this check from an operator shell if the service cannot inspect nginx.', runCommand, config),
      buildCheck('nginx-snippets-include', 'nginx includes managed app snippets', 'sudo -n nginx -T 2>/dev/null | grep -Fq "include /etc/nginx/snippets/*.conf;"', 'Run this check from an operator shell if the service cannot inspect protected nginx configuration.', runCommand, config),
    ]),
    buildCheck('tailscale', 'Tailscale installed', 'command -v tailscale && tailscale version', executorMode
      ? 'Tailscale is how household devices reach Home Base. The typed bootstrap does not install it yet; on the host run: curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up'
      : 'Install Tailscale during bootstrap for private remote access.', runCommand, config, { missingSummary: 'Tailscale is not installed on this host.' }),
  ];

  if (!executorMode && config.gitTransport === 'ssh-key') {
    const keyPath = config.gitSshKeyPath || '';
    const serviceUser = config.serviceUser || 'sovereign';
    if (keyPath) {
      checks.push(buildCheck(
        'git-ssh-key',
        `SSH key readable by ${serviceUser}`,
        `sudo -n -u ${shellSingleQuote(serviceUser)} test -r ${shellSingleQuote(keyPath)}`,
        `Place your SSH key at ${keyPath} and run: sudo chown ${serviceUser}:${serviceUser} ${keyPath} && sudo chmod 600 ${keyPath}`,
        runCommand
      ));
    } else {
      checks.push({
        id: 'git-ssh-key',
        title: 'SSH key path configured',
        command: '',
        severity: getCheckSeverity('git-ssh-key'),
        ok: false,
        summary: 'HOME_BASE_GIT_SSH_KEY_PATH is not set',
        hint: 'Set HOME_BASE_GIT_SSH_KEY_PATH to the path of the SSH key that the sovereign user should use for git clones.',
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    ok: checks.every((check) => check.ok !== false),
    checks,
  };
}

module.exports = {
  CRITICAL_CHECK_IDS,
  getCheckSeverity,
  runShell,
  runPreflightChecks,
};
