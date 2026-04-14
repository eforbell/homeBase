const { spawnSync } = require('child_process');

function runShell(command) {
  const result = spawnSync('/bin/bash', ['-lc', command], {
    encoding: 'utf8',
  });

  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function buildCheck(id, title, command, hint) {
  const result = runShell(command);
  return {
    id,
    title,
    command,
    ok: result.ok,
    summary: result.ok ? (result.stdout || 'ok') : (result.stderr || result.stdout || `exit ${result.exitCode}`),
    hint,
  };
}

function runPreflightChecks(config = {}) {
  const checks = [
    buildCheck('os', 'Debian-family host detected', 'test -f /etc/debian_version && . /etc/os-release && echo "$PRETTY_NAME"', 'Home Base currently targets Ubuntu/Debian hosts.'),
    buildCheck('sudo', 'sudo available', 'command -v sudo', 'Install and configure sudo or run Home Base in a root context.'),
    buildCheck('systemd', 'systemd available', 'command -v systemctl', 'This host must support systemd-managed services.'),
    buildCheck('git', 'git installed', 'command -v git && git --version', 'Install git before attempting app installs.'),
    buildCheck('node', 'Node.js installed', 'command -v node && node --version', 'Install Node.js 18+ for Home Base and Node-managed apps.'),
    buildCheck('python3', 'Python 3 installed', 'command -v python3 && python3 --version', 'Install Python 3 for Bitcoin Accounting and SQLite state support.'),
    buildCheck('psql', 'PostgreSQL client installed', 'command -v psql && psql --version', 'Install postgresql-client so Home Base can run schema and backup commands.'),
    buildCheck('nginx', 'nginx installed', 'command -v nginx && nginx -v', 'Install nginx before enabling routed apps.'),
    buildCheck('postgres-service', 'PostgreSQL service active', 'systemctl is-active postgresql', 'Start PostgreSQL or finish bootstrap before app installs.'),
    buildCheck('nginx-config', 'nginx configuration validates', 'sudo nginx -t', 'Fix nginx configuration issues before generating/reloading app routes.'),
    buildCheck('nginx-snippets-include', 'nginx includes managed app snippets', 'sudo nginx -T 2>/dev/null | grep -Fq "include /etc/nginx/snippets/*.conf;"', 'Bootstrap should configure the default nginx site to include generated app snippets.'),
    buildCheck('tailscale', 'Tailscale installed', 'command -v tailscale && tailscale version', 'Install Tailscale during bootstrap for private remote access.'),
  ];

  if (config.gitTransport === 'ssh-key') {
    const keyPath = config.gitSshKeyPath || '';
    const serviceUser = config.serviceUser || 'sovereign';
    if (keyPath) {
      checks.push(buildCheck(
        'git-ssh-key',
        `SSH key readable by ${serviceUser}`,
        `sudo -u ${serviceUser} test -r ${keyPath}`,
        `Place your SSH key at ${keyPath} and run: sudo chown ${serviceUser}:${serviceUser} ${keyPath} && sudo chmod 600 ${keyPath}`
      ));
    } else {
      checks.push({
        id: 'git-ssh-key',
        title: 'SSH key path configured',
        command: '',
        ok: false,
        summary: 'HOME_BASE_GIT_SSH_KEY_PATH is not set',
        hint: 'Set HOME_BASE_GIT_SSH_KEY_PATH to the path of the SSH key that the sovereign user should use for git clones.',
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    ok: checks.every((check) => check.ok),
    checks,
  };
}

module.exports = {
  runPreflightChecks,
};
