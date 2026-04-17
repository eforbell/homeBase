function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function resolveRepositoryUrl(config) {
  if (config.gitTransport === 'ssh' || config.gitTransport === 'ssh-key') {
    return config.homeBaseRepositorySshUrl || 'git@github.com:eforbell/homeBase.git';
  }
  return config.homeBaseRepositoryUrl || 'https://github.com/eforbell/homeBase.git';
}

function renderGitCommandPrefix(config, { needsSshKey = false } = {}) {
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
    // Run key-based Home Base self-update git operations as root. The runtime
    // service user intentionally does not need read access to the founder/app
    // SSH key, and root must write into the runtime checkout when recovering
    // a copied, non-git app directory.
    return `sudo env GIT_SSH_COMMAND=${shellSingleQuote(sshParts.join(' '))}`;
  }
  if (config.gitTransport === 'ssh') {
    return 'sudo --preserve-env=SSH_AUTH_SOCK';
  }
  return needsSshKey ? 'sudo' : `sudo -u ${config.homeBaseRuntimeUser || 'homebase'}`;
}

function renderGit(config, appDir, args, { needsSshKey = false } = {}) {
  return `${renderGitCommandPrefix(config, { needsSshKey })} git -c safe.directory=${shellSingleQuote(appDir)} -C ${appDir} ${args}`;
}

function buildHomeBaseUpdatePlan(config = {}, options = {}) {
  const generatedAt = new Date().toISOString();
  const runtimeUser = config.homeBaseRuntimeUser || 'homebase';
  const appDir = config.homeBaseAppDir || '/opt/sovereign-home/homebase';
  const serviceName = 'homebase';
  const port = config.port || 3080;
  const ref = options.ref || 'main';
  const repositoryUrl = resolveRepositoryUrl(config);
  const runGitAsPrivilegedUser = config.gitTransport === 'ssh-key';

  const executionSteps = [
    {
      id: 'git-pull',
      title: 'Pull latest Home Base source',
      run: [
        `if [ ! -d ${appDir}/.git ]; then ${renderGit(config, appDir, 'init', { needsSshKey: runGitAsPrivilegedUser })}; fi`,
        `${renderGit(config, appDir, `remote add origin ${shellSingleQuote(repositoryUrl)}`, { needsSshKey: runGitAsPrivilegedUser })} || ${renderGit(config, appDir, `remote set-url origin ${shellSingleQuote(repositoryUrl)}`, { needsSshKey: runGitAsPrivilegedUser })}`,
        `${renderGit(config, appDir, 'fetch origin --prune', { needsSshKey: runGitAsPrivilegedUser })}`,
        `${renderGit(config, appDir, `reset --hard origin/${shellSingleQuote(ref)}`, { needsSshKey: runGitAsPrivilegedUser })}`,
        `${renderGit(config, appDir, `checkout -B ${shellSingleQuote(ref)} origin/${shellSingleQuote(ref)}`, { needsSshKey: runGitAsPrivilegedUser })}`,
        `sudo chown -R ${runtimeUser}:${runtimeUser} ${appDir}`,
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
    update: { runtimeUser, appDir, serviceName, port, ref, repositoryUrl },
    executionSteps,
    commands,
    script: `#!/usr/bin/env bash\nset -euo pipefail\n\n${commands.join('\n')}\n`,
  };
}

module.exports = { buildHomeBaseUpdatePlan };
