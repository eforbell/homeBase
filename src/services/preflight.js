const { spawnSync } = require('child_process');

const CRITICAL_CHECK_IDS = new Set(['os', 'sudo', 'systemd', 'nginx-config', 'postgres-service']);

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
  if (id === 'nginx-config' && config.homeBaseExecutionMode === 'executor') return 'warning';
  return CRITICAL_CHECK_IDS.has(id) ? 'critical' : 'warning';
}

function buildCheck(id, title, command, hint, runCommand = runShell, config = {}) {
  const result = runCommand(command);
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

function runPreflightChecks(config = {}, { runCommand = runShell } = {}) {
  const checks = [
    buildCheck('os', 'Debian-family host detected', 'test -f /etc/debian_version && . /etc/os-release && echo "$PRETTY_NAME"', 'Home Base currently targets Ubuntu/Debian hosts.', runCommand, config),
    buildCheck('sudo', 'sudo available', 'command -v sudo', 'Install and configure sudo or run Home Base in a root context.', runCommand, config),
    buildCheck('systemd', 'systemd available', 'command -v systemctl', 'This host must support systemd-managed services.', runCommand, config),
    buildCheck('git', 'git installed', 'command -v git && git --version', 'Install git before attempting app installs.', runCommand, config),
    buildCheck('node', 'Node.js installed', 'command -v node && node --version', 'Install Node.js 18+ for Home Base and Node-managed apps.', runCommand, config),
    buildCheck('python3', 'Python 3 installed', 'command -v python3 && python3 --version', 'Install Python 3 for Bitcoin Accounting and SQLite state support.', runCommand, config),
    buildCheck('psql', 'PostgreSQL client installed', 'command -v psql && psql --version', 'Install postgresql-client so Home Base can run schema and backup commands.', runCommand, config),
    buildCheck('nginx', 'nginx installed', 'command -v nginx && nginx -v', 'Install nginx before enabling routed apps.', runCommand, config),
    buildCheck('postgres-service', 'PostgreSQL service active', 'systemctl is-active postgresql', 'Start PostgreSQL or finish bootstrap before app installs.', runCommand, config),
    config.homeBaseExecutionMode === 'executor'
      ? buildNotEvaluatedCheck('nginx-config', 'nginx configuration validates', 'Nginx is validated by the privileged executor whenever it applies a bootstrap or typed app plan.', config)
      : buildCheck('nginx-config', 'nginx configuration validates', 'sudo -n nginx -t', 'Run this check from an operator shell if the service cannot inspect nginx.', runCommand, config),
    config.homeBaseExecutionMode === 'executor'
      ? buildNotEvaluatedCheck('nginx-snippets-include', 'nginx includes managed app snippets', 'Managed snippets are inspected and validated by the privileged executor when it applies a typed app plan.', config)
      : buildCheck('nginx-snippets-include', 'nginx includes managed app snippets', 'sudo -n nginx -T 2>/dev/null | grep -Fq "include /etc/nginx/snippets/*.conf;"', 'Run this check from an operator shell if the service cannot inspect protected nginx configuration.', runCommand, config),
    buildCheck('tailscale', 'Tailscale installed', 'command -v tailscale && tailscale version', 'Install Tailscale during bootstrap for private remote access.', runCommand, config),
  ];

  if (config.gitTransport === 'ssh-key') {
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
