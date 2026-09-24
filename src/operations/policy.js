const { OperationPlanError, validateOperationSchema } = require('./validate');

const DINNER_REPOSITORY = 'https://github.com/eforbell/familyDinner.git';
// URI form of the catalog's scp-style sshUrl (git@github.com:eforbell/familyDinner.git); JSON Schema requires a URI.
const DINNER_SSH_REPOSITORY = 'ssh://git@github.com/eforbell/familyDinner.git';
const DINNER_DESTINATION = '/opt/sovereign-home/apps/familyDinner';
const ALLOWED_PACKAGES = new Set(['git', 'ca-certificates', 'openssh-client', 'ssl-cert', 'nginx', 'postgresql', 'postgresql-client', 'nodejs', 'npm']);
const ALLOWED_DIRECTORIES = new Set(['sovereign-root', 'app-root', 'app-install', 'backup-root', 'config-root', 'nginx-snippets', 'nginx-apps', 'sovereign-home']);
const PROFILE_TYPES = {
  'host-bootstrap-v1': new Set(['host.assert-debian-family', 'package.ensure', 'identity.ensure-user', 'filesystem.ensure-directory', 'systemd.ensure-service', 'nginx.ensure-gateway', 'nginx.validate-and-reload']),
  'family-dinner-v1': new Set(['filesystem.ensure-directory', 'git.sync', 'postgres.ensure-role', 'postgres.ensure-database', 'filesystem.write-managed-file', 'runtime.run-npm', 'systemd.daemon-reload', 'systemd.ensure-service', 'nginx.ensure-gateway', 'nginx.validate-and-reload', 'http.wait-ready']),
};

function gitTransportForRepository(repository) {
  if (repository === DINNER_REPOSITORY) return 'https';
  if (repository === DINNER_SSH_REPOSITORY) return 'ssh';
  return null;
}

function deny(message) { throw new OperationPlanError('POLICY_DENIED', message); }

function validateOperationPolicy(plan) {
  validateOperationSchema(plan);
  const profileTypes = PROFILE_TYPES[plan.policyProfile];
  if (!profileTypes) deny(`Unknown policy profile: ${plan.policyProfile}`);
  if ((plan.policyProfile === 'host-bootstrap-v1') !== (plan.kind === 'host-bootstrap')) deny('Plan kind does not match policy profile.');
  if ((plan.policyProfile === 'family-dinner-v1') !== (plan.kind === 'app-install' && plan.target === 'family-dinner')) deny('Plan target does not match policy profile.');

  for (const operation of plan.operations) {
    if (!profileTypes.has(operation.type)) deny(`Operation ${operation.type} is not allowed by ${plan.policyProfile}.`);
    if (operation.risk === 'destructive') deny('Destructive operations are not allowed in v1.');
    if (operation.type === 'package.ensure' && operation.packages.some((pkg) => !ALLOWED_PACKAGES.has(pkg))) deny('Package is not in the compiled policy allowlist.');
    if (operation.type === 'filesystem.ensure-directory' && !ALLOWED_DIRECTORIES.has(operation.purpose)) deny('Directory purpose is not allowed.');
    if (operation.type === 'git.sync' && (!gitTransportForRepository(operation.repository) || !(/^(main|[a-f0-9]{40})$/.test(operation.ref)) || operation.destination !== 'familyDinner')) deny('Git operation does not match Family Dinner policy.');
    if (operation.type === 'postgres.ensure-role' && (!operation.secretRefs.includes(operation.passwordSecretRef) || operation.passwordSecretRef !== 'familyDinnerDatabasePassword')) deny('PostgreSQL password binding is invalid.');
    if (operation.type === 'systemd.ensure-service') {
      const units = plan.policyProfile === 'host-bootstrap-v1' ? new Set(['postgresql.service', 'nginx.service']) : new Set(['family-dinner.service']);
      if (!units.has(operation.unit)) deny('Systemd unit is not allowed by this policy profile.');
    }
  }
  return plan;
}

module.exports = { validateOperationPolicy, gitTransportForRepository, DINNER_REPOSITORY, DINNER_SSH_REPOSITORY, DINNER_DESTINATION, ALLOWED_PACKAGES };
