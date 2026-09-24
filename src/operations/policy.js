const { OperationPlanError, validateOperationSchema } = require('./validate');
const { isValidSite } = require('../homebase-config');
const { getAppById } = require('../catalog');
const { appLayout } = require('./app-layout');

// Schema proves shape; policy proves authority. Every value in an app-install plan must equal what
// the catalog-derived layout for plan.target says, so even a forged plan can only do what the
// catalog already describes for that app.

const BOOTSTRAP_PACKAGES = new Set(['git', 'ca-certificates', 'openssh-client', 'ssl-cert', 'nginx', 'postgresql', 'postgresql-client', 'nodejs', 'npm']);
const BOOTSTRAP_DIRECTORIES = new Set(['sovereign-root', 'app-root', 'sovereign-home', 'backup-root', 'config-root', 'nginx-snippets', 'nginx-apps']);
const INSTALL_DIRECTORIES = new Set(['sovereign-root', 'app-root', 'sovereign-home', 'app-install', 'nginx-apps', 'app-storage-root', 'app-storage']);
const PROFILE_TYPES = {
  'host-bootstrap-v1': new Set(['host.assert-debian-family', 'package.ensure', 'identity.ensure-user', 'filesystem.ensure-directory', 'systemd.ensure-service', 'nginx.ensure-gateway', 'nginx.validate-and-reload']),
  'app-install-v1': new Set(['package.ensure', 'filesystem.ensure-directory', 'git.sync', 'postgres.ensure-role', 'postgres.ensure-database', 'filesystem.write-managed-file', 'runtime.run-app-task', 'systemd.daemon-reload', 'systemd.ensure-service', 'nginx.ensure-gateway', 'nginx.validate-and-reload', 'http.wait-ready']),
  'app-restart-v1': new Set(['systemd.ensure-service', 'http.wait-ready']),
  'app-backup-v1': new Set(['backup.create']),
  'app-restore-v1': new Set(['backup.create', 'systemd.ensure-service', 'backup.restore', 'http.wait-ready']),
  'app-uninstall-v1': new Set(['backup.create', 'systemd.ensure-service', 'filesystem.remove-app-artifacts', 'systemd.daemon-reload', 'nginx.validate-and-reload', 'postgres.drop-database', 'filesystem.remove-checkout', 'backup.remove-all']),
};
const PROFILE_KIND = {
  'host-bootstrap-v1': 'host-bootstrap',
  'app-install-v1': 'app-install',
  'app-restart-v1': 'app-restart',
  'app-backup-v1': 'app-backup',
  'app-restore-v1': 'app-restore',
  'app-uninstall-v1': 'app-uninstall',
};
// Destructive operations exist only in the profiles an operator explicitly confirms.
const DESTRUCTIVE_PROFILES = new Set(['app-restore-v1', 'app-uninstall-v1']);
const DESTRUCTIVE_TYPES = new Set(['backup.restore', 'backup.remove-all', 'filesystem.remove-app-artifacts', 'filesystem.remove-checkout', 'postgres.drop-database']);
const TEMPLATE_PURPOSE = {
  'app-env-v1': 'app-env',
  'app-service-v1': 'systemd-unit',
  'app-sidecar-service-v1': 'systemd-unit',
  'app-timer-service-v1': 'systemd-unit',
  'app-timer-v1': 'systemd-unit',
  'app-nginx-v1': 'nginx-snippet',
};

function deny(message) { throw new OperationPlanError('POLICY_DENIED', message); }

// The units each managed-file template may write for this app.
function templateUnits(layout, template) {
  switch (template) {
    case 'app-service-v1': return [layout.service.unit];
    case 'app-sidecar-service-v1': return layout.sidecars.map((sidecar) => sidecar.unit);
    case 'app-timer-service-v1': return layout.timers.map((timer) => timer.serviceUnit);
    case 'app-timer-v1': return layout.timers.map((timer) => timer.timerUnit);
    default: return null;
  }
}

function checkInstallOperation(operation, layout) {
  switch (operation.type) {
    case 'package.ensure':
      if (operation.packages.some((pkg) => !layout.packages.includes(pkg))) deny('Package is not declared by this app.');
      break;
    case 'filesystem.ensure-directory':
      if (!INSTALL_DIRECTORIES.has(operation.purpose)) deny('Directory purpose is not allowed for app installs.');
      if ((operation.purpose === 'app-storage') !== ('subpath' in operation)) deny('Only app-storage directories take a subpath.');
      if (operation.purpose.startsWith('app-storage') && !layout.storage) deny('This app declares no storage.');
      if (operation.purpose === 'app-storage' && !layout.storage.subpaths.includes(operation.subpath)) deny('Storage subpath is not declared by this app.');
      break;
    case 'git.sync':
      if (![layout.repositories.https, layout.repositories.ssh].includes(operation.repository)) deny('Git repository does not match this app.');
      break;
    case 'postgres.ensure-role':
      if (!layout.database || operation.role !== layout.database.user || !operation.secretRefs.includes(operation.passwordSecretRef)) deny('Database role does not match this app.');
      break;
    case 'postgres.ensure-database':
    case 'postgres.drop-database':
      if (!layout.database || operation.database !== layout.database.name || operation.owner !== layout.database.user) deny('Database does not match this app.');
      break;
    case 'filesystem.write-managed-file': {
      if (TEMPLATE_PURPOSE[operation.template] !== operation.purpose) deny('Managed file template and purpose do not match.');
      const units = templateUnits(layout, operation.template);
      if (units ? !units.includes(operation.unit) : 'unit' in operation) deny('Managed file unit does not match this app.');
      // Only env templates consume site values; they must be present there and nowhere else.
      const needsSite = operation.purpose === 'app-env';
      if (needsSite !== ('site' in operation)) deny('Managed file site values are required for app env files only.');
      if (needsSite && !isValidSite(operation.site)) deny('Managed file site values are invalid.');
      break;
    }
    case 'runtime.run-app-task':
      if (operation.task === 'migrate' && !layout.migrationArgv) deny('This app declares no migrations.');
      break;
    case 'systemd.ensure-service':
      if (!layout.unitNames.includes(operation.unit)) deny('Systemd unit is not declared by this app.');
      break;
    case 'http.wait-ready':
      if (operation.port !== layout.port || operation.path !== layout.readinessPath) deny('Readiness endpoint does not match this app.');
      break;
    default:
      break;
  }
}

function checkBootstrapOperation(operation) {
  if (operation.type === 'package.ensure' && operation.packages.some((pkg) => !BOOTSTRAP_PACKAGES.has(pkg))) deny('Package is not in the bootstrap allowlist.');
  if (operation.type === 'filesystem.ensure-directory' && (!BOOTSTRAP_DIRECTORIES.has(operation.purpose) || 'subpath' in operation)) deny('Directory purpose is not allowed for bootstrap.');
  if (operation.type === 'systemd.ensure-service' && !['postgresql.service', 'nginx.service'].includes(operation.unit)) deny('Systemd unit is not allowed by the bootstrap profile.');
}

function validateOperationPolicy(plan) {
  validateOperationSchema(plan);
  const profileTypes = PROFILE_TYPES[plan.policyProfile];
  if (!profileTypes) deny(`Unknown policy profile: ${plan.policyProfile}`);
  const bootstrap = plan.policyProfile === 'host-bootstrap-v1';
  if (plan.kind !== PROFILE_KIND[plan.policyProfile]) deny('Plan kind does not match its policy profile.');
  if (bootstrap !== (plan.target === 'local-host')) deny('Plan target does not match its policy profile.');
  const layout = bootstrap ? null : appLayout(getAppById(plan.target));
  for (const operation of plan.operations) {
    if (!profileTypes.has(operation.type)) deny(`Operation ${operation.type} is not allowed by ${plan.policyProfile}.`);
    const destructive = DESTRUCTIVE_TYPES.has(operation.type) || ['stop', 'disable-now'].includes(operation.action);
    if (destructive !== (operation.risk === 'destructive')) deny(`Operation ${operation.id} must declare risk "destructive" exactly when it is destructive.`);
    if (destructive && !DESTRUCTIVE_PROFILES.has(plan.policyProfile)) deny(`Destructive operations are not allowed by ${plan.policyProfile}.`);
    if (bootstrap) checkBootstrapOperation(operation);
    else checkInstallOperation(operation, layout);
  }
  return plan;
}

function gitTransportForRepository(layout, repository) {
  if (repository === layout.repositories.https) return 'https';
  if (layout.repositories.ssh && repository === layout.repositories.ssh) return 'ssh';
  return null;
}

module.exports = { validateOperationPolicy, gitTransportForRepository, BOOTSTRAP_PACKAGES };
