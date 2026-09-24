const test = require('node:test');
const assert = require('node:assert/strict');
const { runPreflightChecks } = require('../src/services/preflight');

test('preflight uses non-interactive sudo for read-only privileged probes', () => {
  const commands = [];
  const result = runPreflightChecks({
    gitTransport: 'ssh-key',
    gitSshKeyPath: '/opt/sovereign-home/.ssh/id_homebase',
    serviceUser: 'sovereign',
  }, {
    runCommand(command) {
      commands.push(command);
      return { ok: true, exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  const sudoCommands = commands.filter((command) => command.trim().startsWith('sudo '));
  assert.equal(sudoCommands.length >= 3, true);
  for (const command of sudoCommands) {
    assert.match(command, /sudo -n(?: |$)/);
  }
  assert.equal(commands.some((command) => command.includes("test -r '/opt/sovereign-home/.ssh/id_homebase'")), true);
});

function runExecutorPreflight(executorStatus, config = {}) {
  const commands = [];
  const result = runPreflightChecks({ homeBaseExecutionMode: 'executor', ...config }, {
    executorStatus,
    runCommand(command) {
      commands.push(command);
      return { ok: true, exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });
  return { result, commands, check: (id) => result.checks.find((item) => item.id === id) };
}

const HEALTHY_EXECUTOR = {
  reachable: true,
  capabilities: { protocolVersions: [1], mutationsEnabled: true },
  host: { checks: {
    'nginx-config': { ok: true, summary: 'nginx: configuration file /etc/nginx/nginx.conf test is successful' },
    'nginx-gateway': { ok: true, summary: '/etc/nginx/sites-enabled/sovereign-home is enabled' },
    'git-deploy-key': { ok: true, status: 'present' },
  } },
};

test('executor mode reports protected host checks from the executor and never shells out to sudo', () => {
  const { result, commands, check } = runExecutorPreflight(HEALTHY_EXECUTOR, { gitTransport: 'ssh-key', gitSshKeyPath: '/etc/sovereign-home/git/deploy_key' });
  assert.equal(result.ok, true);
  assert.equal(check('executor').ok, true);
  assert.equal(check('nginx-config').ok, true);
  assert.equal(check('nginx-config').source, 'executor');
  assert.equal(check('nginx-gateway').ok, true);
  assert.equal(check('git-ssh-key').ok, true);
  assert.match(check('git-ssh-key').title, /root-only/);
  assert.equal(check('sudo'), undefined, 'sudo is irrelevant when the web service runs under NoNewPrivileges');
  assert.equal(result.checks.some((item) => item.ok === null), false, 'a healthy executor host has nothing left unevaluated');
  assert.equal(commands.some((command) => /sudo|nginx -t|nginx -T/.test(command)), false);
});

test('executor mode surfaces real executor-reported failures', () => {
  const { result, check } = runExecutorPreflight({
    ...HEALTHY_EXECUTOR,
    host: { checks: { ...HEALTHY_EXECUTOR.host.checks, 'nginx-config': { ok: false, summary: 'unknown directive "proxy_passs"' }, 'git-deploy-key': { ok: false, status: 'insecure' } } },
  }, { gitTransport: 'ssh-key' });
  assert.equal(result.ok, false);
  assert.equal(check('nginx-config').ok, false);
  assert.equal(check('nginx-config').severity, 'critical');
  assert.match(check('nginx-config').summary, /proxy_passs/);
  assert.match(check('git-ssh-key').summary, /0600/);
});

test('an unreachable executor is one critical failure, and dependent checks are not evaluated rather than failed', () => {
  const { result, check } = runExecutorPreflight({ reachable: false, error: 'Executor socket is missing.' });
  assert.equal(result.ok, false);
  assert.equal(check('executor').ok, false);
  assert.equal(check('executor').severity, 'critical');
  assert.equal(check('nginx-config').ok, null);
  assert.match(check('nginx-config').summary, /unreachable/);
  const beforeFirstProbe = runExecutorPreflight(null);
  assert.equal(beforeFirstProbe.check('executor').ok, false);
});

test('https transport in executor mode does not report a deploy-key check', () => {
  const { check } = runExecutorPreflight(HEALTHY_EXECUTOR, { gitTransport: 'https' });
  assert.equal(check('git-ssh-key'), undefined);
});


test('a missing Tailscale binary is reported plainly with install guidance', () => {
  const result = runPreflightChecks({ homeBaseExecutionMode: 'executor' }, {
    executorStatus: HEALTHY_EXECUTOR,
    runCommand: (command) => (command.includes('tailscale') ? { ok: false, exitCode: 1, stdout: '', stderr: '' } : { ok: true, exitCode: 0, stdout: 'ok', stderr: '' }),
  });
  const tailscale = result.checks.find((check) => check.id === 'tailscale');
  assert.equal(tailscale.ok, false);
  assert.equal(tailscale.severity, 'warning');
  assert.equal(tailscale.summary, 'Tailscale is not installed on this host.');
  assert.match(tailscale.hint, /tailscale\.com\/install\.sh/);
});
