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
