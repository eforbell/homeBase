const { OperationPlanError, validateOperationSchema } = require('./validate');
const { isValidSite } = require('../homebase-config');
const { getAppById } = require('../catalog');
const { appLayout } = require('./app-layout');

// Schema proves shape; policy proves authority. Every value in an app-install plan must equal what
// the catalog-derived layout for plan.target says, so even a forged plan can only do what the
// catalog already describes for that app.

const BOOTSTRAP_PACKAGES = new Set(['git', 'ca-certificates', 'openssh-client', 'ssl-cert', 'nginx', 'postgresql', 'postgresql-client', 'nodejs', 'npm']);
const BOOTSTRAP_DIRECTORIES = new Set(['sovereign-root', 'app-root', 'sovereign-home', 'backup-root', 'config-root', 'nginx-snippets', 'nginx-apps']);
const INSTALL_DIRECTORIES = new Set(['sovereign-root', 'app-root', 'sovereign-home', 'app-install', 'app-home', 'nginx-apps', 'app-storage-root', 'app-storage', 'app-checkout-storage']);
const SUBPATH_PURPOSES = new Set(['app-storage', 'app-checkout-storage']);
// Unit templates that start a process; they carry the household timezone (TZ=).
const TIMEZONE_TEMPLATES = new Set(['app-service-v1', 'app-sidecar-service-v1', 'app-timer-service-v1']);
const PROFILE_TYPES = {
  'host-bootstrap-v1': new Set(['host.assert-debian-family', 'package.ensure', 'identity.ensure-user', 'filesystem.ensure-directory', 'systemd.ensure-service', 'nginx.ensure-gateway', 'nginx.validate-and-reload']),
  'app-install-v1': new Set(['package.ensure', 'identity.ensure-user', 'filesystem.ensure-directory', 'git.sync', 'postgres.ensure-role', 'postgres.ensure-database', 'filesystem.write-managed-file', 'systemd.apply-tmpfiles', 'runtime.run-app-task', 'systemd.daemon-reload', 'systemd.ensure-service', 'nginx.ensure-gateway', 'nginx.validate-and-reload', 'http.wait-ready']),
  'app-restart-v1': new Set(['systemd.ensure-service', 'http.wait-ready']),
  'app-backup-v1': new Set(['backup.create']),
  'app-restore-v1': new Set(['backup.verify', 'backup.create', 'systemd.ensure-service', 'backup.restore', 'http.wait-ready']),
  'app-uninstall-v1': new Set(['backup.create', 'systemd.ensure-service', 'filesystem.remove-app-artifacts', 'systemd.daemon-reload', 'nginx.validate-and-reload', 'postgres.drop-database', 'filesystem.remove-checkout', 'backup.remove-all']),
};
// Adopt takes over a legacy install in place: the install operations, plus a safety backup, the nginx
// include check, retiring the legacy snippet, and handing database objects to the app role.
PROFILE_TYPES['app-adopt-v1'] = new Set([...PROFILE_TYPES['app-install-v1'], 'backup.create', 'nginx.assert-app-include', 'nginx.retire-legacy-snippets', 'postgres.transfer-ownership']);
// Identity-safe ingress (Feature-10 SID-001): the move to per-service nginx sockets, and its rollback.
// Publishing is its own profile because each service is gated separately (D23).
PROFILE_TYPES['ingress-cutover-v1'] = new Set(['nginx.ensure-socket-gateway', 'nginx.validate-and-reload', 'tailscale.retire-service']);
PROFILE_TYPES['ingress-rollback-v1'] = new Set(['nginx.restore-tcp-gateway', 'nginx.validate-and-reload', 'tailscale.restore-serve-snapshot']);
PROFILE_TYPES['service-publish-v1'] = new Set(['tailscale.publish-service']);
// Moving a sensitive app to its own user (SID-002): backup, stop, identity and home, the hand-over, the
// .env and units rewritten for the new user, start.
PROFILE_TYPES['app-move-user-v1'] = new Set(['filesystem.check-app-trees', 'backup.create', 'systemd.ensure-service', 'identity.ensure-user', 'filesystem.ensure-directory', 'filesystem.reown-app', 'filesystem.write-managed-file', 'systemd.apply-tmpfiles', 'systemd.daemon-reload', 'http.wait-ready']);
const PROFILE_KIND = {
  'host-bootstrap-v1': 'host-bootstrap',
  'app-install-v1': 'app-install',
  'app-restart-v1': 'app-restart',
  'app-backup-v1': 'app-backup',
  'app-restore-v1': 'app-restore',
  'app-uninstall-v1': 'app-uninstall',
  'app-adopt-v1': 'app-adopt',
  'ingress-cutover-v1': 'ingress-cutover',
  'ingress-rollback-v1': 'ingress-rollback',
  'service-publish-v1': 'service-publish',
  'app-move-user-v1': 'app-move-user',
};
// Profiles that change the host itself rather than one catalog app.
const HOST_PROFILES = new Set(['host-bootstrap-v1', 'ingress-cutover-v1', 'ingress-rollback-v1', 'service-publish-v1']);
// Destructive operations exist only in the profiles an operator explicitly confirms.
const DESTRUCTIVE_PROFILES = new Set(['app-restore-v1', 'app-uninstall-v1', 'app-adopt-v1', 'ingress-cutover-v1', 'ingress-rollback-v1', 'app-move-user-v1']);
const DESTRUCTIVE_TYPES = new Set(['filesystem.reown-app', 'backup.restore', 'backup.remove-all', 'filesystem.remove-app-artifacts', 'filesystem.remove-checkout', 'postgres.drop-database', 'nginx.retire-legacy-snippets', 'nginx.restore-tcp-gateway', 'tailscale.retire-service', 'tailscale.restore-serve-snapshot']);
const TEMPLATE_PURPOSE = {
  'app-env-v1': 'app-env',
  'app-service-v1': 'systemd-unit',
  'app-sidecar-service-v1': 'systemd-unit',
  'app-timer-service-v1': 'systemd-unit',
  'app-timer-v1': 'systemd-unit',
  'app-nginx-v1': 'nginx-snippet',
  'app-tmpfiles-v1': 'app-tmpfiles',
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

// The move rewrites only what depends on who the app runs as: its home, .env and units, never nginx.
function checkMoveOperation(operation, layout) {
  if (!layout.identity.own) deny('Only a sensitive app moves to its own identity.');
  if (operation.type === 'filesystem.ensure-directory' && operation.purpose !== 'app-home') deny('A move creates only the app\'s home.');
  if (operation.type === 'filesystem.write-managed-file' && operation.template === 'app-nginx-v1') deny('A move does not rewrite nginx.');
}

function checkInstallOperation(operation, layout, plan) {
  switch (operation.type) {
    case 'package.ensure':
      if (operation.packages.some((pkg) => !layout.packages.includes(pkg))) deny('Package is not declared by this app.');
      break;
    case 'identity.ensure-user':
      // Only the app's own identity (SID-002); the shared one is bootstrap's.
      if (!layout.identity.own || operation.user !== layout.identity.user) deny('An app install may create only its own identity.');
      break;
    case 'filesystem.ensure-directory':
      if (!INSTALL_DIRECTORIES.has(operation.purpose)) deny('Directory purpose is not allowed for app installs.');
      if (operation.purpose === 'app-home' && !layout.identity.own) deny('Only apps with their own identity have their own home.');
      if (SUBPATH_PURPOSES.has(operation.purpose) !== ('subpath' in operation)) deny('Only storage directories take a subpath.');
      if (/storage/.test(operation.purpose)) {
        if (!layout.storage) deny('This app declares no storage.');
        if ((operation.purpose === 'app-checkout-storage') !== layout.storage.inCheckout) deny('Storage purpose does not match where this app keeps its storage.');
        if ('subpath' in operation && !layout.storage.subpaths.includes(operation.subpath)) deny('Storage subpath is not declared by this app.');
      }
      break;
    case 'git.sync':
      if (![layout.repositories.https, layout.repositories.ssh].includes(operation.repository)) deny('Git repository does not match this app.');
      break;
    case 'postgres.ensure-role':
      if (!layout.database || operation.role !== layout.database.user || !operation.secretRefs.includes(operation.passwordSecretRef)) deny('Database role does not match this app.');
      break;
    case 'postgres.ensure-database':
    case 'postgres.drop-database':
    case 'postgres.transfer-ownership':
      if (!layout.database || operation.database !== layout.database.name || operation.owner !== layout.database.user) deny('Database does not match this app.');
      break;
    case 'systemd.apply-tmpfiles':
      if (layout.listen.kind !== 'unix') deny('This app does not listen on a socket.');
      break;
    case 'filesystem.write-managed-file': {
      if (TEMPLATE_PURPOSE[operation.template] !== operation.purpose) deny('Managed file template and purpose do not match.');
      if (operation.template === 'app-tmpfiles-v1' && layout.listen.kind !== 'unix') deny('This app does not listen on a socket.');
      const units = templateUnits(layout, operation.template);
      if (units ? !units.includes(operation.unit) : 'unit' in operation) deny('Managed file unit does not match this app.');
      // Only env templates consume site values; they must be present there and nowhere else.
      const needsSite = operation.purpose === 'app-env';
      if (needsSite !== ('site' in operation)) deny('Managed file site values are required for app env files only.');
      if (needsSite && !isValidSite(operation.site)) deny('Managed file site values are invalid.');
      if (TIMEZONE_TEMPLATES.has(operation.template) !== ('timezone' in operation)) deny('Only process unit templates carry a timezone.');
      if ('timezone' in operation) {
        const siteTimezone = plan.operations.find((entry) => entry.purpose === 'app-env')?.site?.householdTimezone;
        if (operation.timezone !== siteTimezone) deny('Unit timezone must match the install site timezone.');
      }
      break;
    }
    case 'backup.create':
      // Only uninstall may back up "what remains"; a restore's safety backup must be complete.
      if (operation.whatRemains && plan.policyProfile !== 'app-uninstall-v1') deny('Only uninstall safety backups may skip already-removed parts.');
      break;
    case 'runtime.run-app-task':
      if (operation.task === 'migrate' && !layout.migrationArgv) deny('This app declares no migrations.');
      if (operation.task === 'ensure-venv' && layout.runtime.kind !== 'python') deny('Only Python apps have a virtualenv.');
      if (operation.task === 'bootstrap-schema' && !layout.database?.schemaFile) deny('This app declares no schema file.');
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
  if (operation.type === 'identity.ensure-user' && operation.user !== 'sovereign') deny('Bootstrap creates only the shared sovereign identity.');
  if (operation.type === 'filesystem.ensure-directory' && (!BOOTSTRAP_DIRECTORIES.has(operation.purpose) || 'subpath' in operation)) deny('Directory purpose is not allowed for bootstrap.');
  if (operation.type === 'systemd.ensure-service' && !['postgresql.service', 'nginx.service'].includes(operation.unit)) deny('Systemd unit is not allowed by the bootstrap profile.');
}

function validateOperationPolicy(plan) {
  validateOperationSchema(plan);
  const profileTypes = PROFILE_TYPES[plan.policyProfile];
  if (!profileTypes) deny(`Unknown policy profile: ${plan.policyProfile}`);
  const hostPlan = HOST_PROFILES.has(plan.policyProfile);
  const bootstrap = plan.policyProfile === 'host-bootstrap-v1';
  if (plan.kind !== PROFILE_KIND[plan.policyProfile]) deny('Plan kind does not match its policy profile.');
  if (hostPlan !== (plan.target === 'local-host')) deny('Plan target does not match its policy profile.');
  const layout = hostPlan ? null : appLayout(getAppById(plan.target));
  for (const operation of plan.operations) {
    if (!profileTypes.has(operation.type)) deny(`Operation ${operation.type} is not allowed by ${plan.policyProfile}.`);
    const destructive = DESTRUCTIVE_TYPES.has(operation.type) || ['stop', 'disable-now'].includes(operation.action);
    if (destructive !== (operation.risk === 'destructive')) deny(`Operation ${operation.id} must declare risk "destructive" exactly when it is destructive.`);
    if (destructive && !DESTRUCTIVE_PROFILES.has(plan.policyProfile)) deny(`Destructive operations are not allowed by ${plan.policyProfile}.`);
    if (bootstrap) checkBootstrapOperation(operation);
    else if (!hostPlan) {
      if (plan.policyProfile === 'app-move-user-v1') checkMoveOperation(operation, layout);
      checkInstallOperation(operation, layout, plan);
    }
  }
  return plan;
}

function gitTransportForRepository(layout, repository) {
  if (repository === layout.repositories.https) return 'https';
  if (layout.repositories.ssh && repository === layout.repositories.ssh) return 'ssh';
  return null;
}

module.exports = { validateOperationPolicy, gitTransportForRepository, BOOTSTRAP_PACKAGES, PROFILE_TYPES };
