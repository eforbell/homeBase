function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function buildGitPrefix(runtimeUser, config) {
  if (config.gitTransport === 'ssh-key' && config.gitSshKeyPath) {
    const sshParts = [
      'ssh',
      '-i', config.gitSshKeyPath,
      '-o', 'IdentitiesOnly=yes',
      '-o', `StrictHostKeyChecking=${config.gitSshStrictHostKeyChecking || 'accept-new'}`,
    ];
    if (config.gitSshKnownHostsPath) {
      sshParts.push('-o', `UserKnownHostsFile=${config.gitSshKnownHostsPath}`);
    }
    return `sudo -u ${runtimeUser} env GIT_SSH_COMMAND=${shellSingleQuote(sshParts.join(' '))}`;
  }
  if (config.gitTransport === 'ssh') {
    return `sudo --preserve-env=SSH_AUTH_SOCK -u ${runtimeUser}`;
  }
  return `sudo -u ${runtimeUser}`;
}

function buildHomeBaseUpdatePlan(config = {}, options = {}) {
  const generatedAt = new Date().toISOString();
  const runtimeUser = config.homeBaseRuntimeUser || 'homebase';
  const appDir = config.homeBaseAppDir || '/opt/sovereign-home/homebase';
  const serviceName = 'homebase';
  const port = config.port || 3080;
  const ref = options.ref || 'main';
  const gitPrefix = buildGitPrefix(runtimeUser, config);

  const executionSteps = [
    {
      id: 'git-pull',
      title: 'Pull latest Home Base source',
      run: [
        `${gitPrefix} git -C ${appDir} fetch origin --prune`,
        `${gitPrefix} git -C ${appDir} checkout ${ref}`,
        `${gitPrefix} git -C ${appDir} pull --ff-only origin ${ref}`,
      ],
    },
    {
      id: 'install-deps',
      title: 'Install updated dependencies',
      run: [
        `sudo -u ${runtimeUser} -H bash -lc 'cd ${appDir} && if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi'`,
      ],
    },
    {
      id: 'restart-service',
      title: 'Restart Home Base service',
      run: [
        `sudo systemctl restart ${serviceName}`,
        `for attempt in $(seq 1 20); do curl --fail --silent --show-error http://127.0.0.1:${port}/api/state && exit 0; sleep 1; done; echo "Timed out waiting for Home Base on ${port}" >&2; exit 1`,
      ],
    },
  ];

  const commands = executionSteps.flatMap((step) => step.run);

  return {
    kind: 'homebase-update',
    generatedAt,
    update: { runtimeUser, appDir, serviceName, port, ref },
    executionSteps,
    commands,
    script: `#!/usr/bin/env bash\nset -euo pipefail\n\n${commands.join('\n')}\n`,
  };
}

module.exports = { buildHomeBaseUpdatePlan };
