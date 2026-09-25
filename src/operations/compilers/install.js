const { getAppById } = require('../../catalog');
const { appLayout } = require('../app-layout');
const { operation, planEnvelope } = require('./common');

const DEFAULT_SITE = Object.freeze({ hostname: 'homebase', domain: 'tailnet', householdTimezone: 'America/New_York' });
const DATABASE_PASSWORD_REF = 'databasePassword';

// Legacy 'ssh' (agent forwarding) and 'ssh-key' both map to the executor's root-held deploy key.
function repositoryForTransport(layout, gitTransport) {
  if (gitTransport === 'ssh' || gitTransport === 'ssh-key') {
    if (!layout.repositories.ssh) throw Object.assign(new Error(`${layout.app.id} has no SSH repository.`), { code: 'POLICY_DENIED' });
    return layout.repositories.ssh;
  }
  return layout.repositories.https;
}

// Compiles an app install from its catalog shape (app-layout.js). Operations run in order; each
// depends on the previous one so a failure stops the plan at a precise, resumable point.
function buildAppInstallPlan({ appId, ref = 'main', gitTransport = 'https', site = DEFAULT_SITE, generatedAt, catalogRevision } = {}) {
  const app = getAppById(appId);
  if (!app) throw Object.assign(new Error(`Unknown catalog app: ${appId}`), { code: 'POLICY_DENIED' });
  if (!/^(main|[a-f0-9]{40})$/.test(ref)) throw Object.assign(new Error('Executor installs permit only main or a 40-character commit SHA.'), { code: 'POLICY_DENIED' });
  const layout = appLayout(app);
  const operations = [];
  const add = (fields) => {
    const previous = operations.at(-1);
    operations.push(operation({ dependsOn: previous ? [previous.id] : [], ...fields }));
  };
  const name = app.name;

  add({ id: 'ensure-sovereign-root', type: 'filesystem.ensure-directory', title: 'Ensure root-owned Sovereign Home directory', purpose: 'sovereign-root' });
  add({ id: 'ensure-app-root', type: 'filesystem.ensure-directory', title: 'Ensure managed apps directory', purpose: 'app-root' });
  add({ id: 'ensure-sovereign-home', type: 'filesystem.ensure-directory', title: 'Ensure sovereign runtime home', purpose: 'sovereign-home' });
  add({ id: 'ensure-install-root', type: 'filesystem.ensure-directory', title: `Ensure ${name} install directory`, purpose: 'app-install' });
  if (layout.packages.length) {
    add({ id: 'install-app-packages', type: 'package.ensure', title: `Install ${name} system packages`, timeoutMs: 600000, packages: layout.packages, updateCache: true });
  }
  if (layout.storage) {
    add({ id: 'ensure-storage-root', type: 'filesystem.ensure-directory', title: `Ensure ${name} storage directory`, purpose: 'app-storage-root' });
    layout.storage.subpaths.forEach((subpath, index) => add({ id: `ensure-storage-${index + 1}`, type: 'filesystem.ensure-directory', title: `Ensure ${name} ${subpath} storage`, purpose: 'app-storage', subpath }));
  }
  add({ id: 'sync-repository', type: 'git.sync', title: `Synchronize ${name} repository`, timeoutMs: 300000, preconditions: ['directory-layout'], repository: repositoryForTransport(layout, gitTransport), ref });
  if (layout.database) {
    add({ id: 'ensure-db-role', type: 'postgres.ensure-role', title: `Ensure ${name} database role`, preconditions: ['postgres-ready'], secretRefs: [DATABASE_PASSWORD_REF], role: layout.database.user, passwordSecretRef: DATABASE_PASSWORD_REF });
    add({ id: 'ensure-database', type: 'postgres.ensure-database', title: `Ensure ${name} database`, database: layout.database.name, owner: layout.database.user });
  }
  add({
    id: 'write-environment', type: 'filesystem.write-managed-file', title: `Write ${name} environment`,
    secretRefs: layout.database ? [DATABASE_PASSWORD_REF] : [], purpose: 'app-env', template: 'app-env-v1',
    site: { hostname: site.hostname, domain: site.domain, householdTimezone: site.householdTimezone },
  });
  add({ id: 'write-service', type: 'filesystem.write-managed-file', title: `Write ${name} service unit`, purpose: 'systemd-unit', template: 'app-service-v1', unit: layout.service.unit });
  layout.sidecars.forEach((sidecar, index) => add({ id: `write-sidecar-${index + 1}`, type: 'filesystem.write-managed-file', title: `Write ${sidecar.name} service unit`, purpose: 'systemd-unit', template: 'app-sidecar-service-v1', unit: sidecar.unit }));
  layout.timers.forEach((timer, index) => {
    add({ id: `write-timer-service-${index + 1}`, type: 'filesystem.write-managed-file', title: `Write ${timer.serviceName} service unit`, purpose: 'systemd-unit', template: 'app-timer-service-v1', unit: timer.serviceUnit });
    add({ id: `write-timer-${index + 1}`, type: 'filesystem.write-managed-file', title: `Write ${timer.timerUnit}`, purpose: 'systemd-unit', template: 'app-timer-v1', unit: timer.timerUnit });
  });
  add({ id: 'ensure-nginx-apps', type: 'filesystem.ensure-directory', title: 'Ensure managed nginx app directory', purpose: 'nginx-apps' });
  add({ id: 'write-nginx', type: 'filesystem.write-managed-file', title: `Write ${name} nginx snippet`, purpose: 'nginx-snippet', template: 'app-nginx-v1' });
  add({ id: 'install-runtime', type: 'runtime.run-app-task', title: `Install ${name} runtime dependencies`, timeoutMs: 600000, preconditions: ['app-checkout'], task: 'install-dependencies' });
  if (layout.migrationArgv) {
    add({ id: 'run-migrations', type: 'runtime.run-app-task', title: `Run ${name} migrations`, timeoutMs: 300000, preconditions: ['app-checkout'], task: 'migrate' });
  }
  add({ id: 'reload-systemd', type: 'systemd.daemon-reload', title: 'Reload systemd units' });
  add({ id: 'start-service', type: 'systemd.ensure-service', title: `Enable and restart ${name}`, unit: layout.service.unit, action: 'enable-and-restart' });
  layout.sidecars.forEach((sidecar, index) => add({ id: `start-sidecar-${index + 1}`, type: 'systemd.ensure-service', title: `Enable and restart ${sidecar.name}`, unit: sidecar.unit, action: 'enable-and-restart' }));
  layout.timers.forEach((timer, index) => add({ id: `start-timer-${index + 1}`, type: 'systemd.ensure-service', title: `Enable and restart ${timer.timerUnit}`, unit: timer.timerUnit, action: 'enable-and-restart' }));
  add({ id: 'ensure-gateway', type: 'nginx.ensure-gateway', title: 'Ensure the managed nginx gateway site' });
  add({ id: 'reload-nginx', type: 'nginx.validate-and-reload', title: 'Validate and reload nginx', preconditions: ['nginx-configured'] });
  add({ id: 'wait-ready', type: 'http.wait-ready', title: `Wait for ${name} readiness`, risk: 'read', timeoutMs: 60000, executor: 'homebase', port: layout.port, path: layout.readinessPath });

  return planEnvelope({ kind: 'app-install', target: app.id, policyProfile: 'app-install-v1', operations, generatedAt, catalogRevision });
}

module.exports = { buildAppInstallPlan, repositoryForTransport, DATABASE_PASSWORD_REF, DEFAULT_SITE };
