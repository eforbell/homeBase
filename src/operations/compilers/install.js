const { getAppById } = require('../../catalog');
const { operation, planEnvelope } = require('./common');
const { DINNER_REPOSITORY } = require('../policy');

function buildDinnerInstallPlan({ appId = 'family-dinner', ref = 'main', generatedAt, catalogRevision } = {}) {
  const app = getAppById(appId);
  if (!app || app.id !== 'family-dinner' || app.repository.url !== DINNER_REPOSITORY) {
    const error = new Error('Typed execution is currently supported only for Family Dinner.');
    error.code = 'TYPED_EXECUTION_NOT_SUPPORTED';
    throw error;
  }
  if (!/^(main|[a-f0-9]{40})$/.test(ref)) {
    const error = new Error('Family Dinner typed execution permits only main or a 40-character commit SHA.');
    error.code = 'POLICY_DENIED';
    throw error;
  }
  const databasePasswordRef = 'familyDinnerDatabasePassword';
  const operations = [
    operation({ id: 'ensure-install-root', type: 'filesystem.ensure-directory', title: 'Ensure Family Dinner install directory', purpose: 'app-install' }),
    operation({ id: 'sync-repository', type: 'git.sync', title: 'Synchronize Family Dinner repository', timeoutMs: 300000, dependsOn: ['ensure-install-root'], preconditions: ['directory-layout'], repository: app.repository.url, ref, destination: 'familyDinner' }),
    operation({ id: 'ensure-db-role', type: 'postgres.ensure-role', title: 'Ensure Family Dinner database role', dependsOn: ['sync-repository'], preconditions: ['postgres-ready'], secretRefs: [databasePasswordRef], role: app.database.databaseUser, passwordSecretRef: databasePasswordRef }),
    operation({ id: 'ensure-database', type: 'postgres.ensure-database', title: 'Ensure Family Dinner database', dependsOn: ['ensure-db-role'], database: app.database.databaseName, owner: app.database.databaseUser }),
    operation({ id: 'write-environment', type: 'filesystem.write-managed-file', title: 'Write Family Dinner environment', dependsOn: ['ensure-database'], secretRefs: [databasePasswordRef], purpose: 'app-env', template: 'family-dinner-env-v1' }),
    operation({ id: 'write-service', type: 'filesystem.write-managed-file', title: 'Write Family Dinner service unit', dependsOn: ['write-environment'], purpose: 'systemd-unit', template: 'family-dinner-service-v1' }),
    operation({ id: 'write-nginx', type: 'filesystem.write-managed-file', title: 'Write Family Dinner nginx snippet', dependsOn: ['write-service'], purpose: 'nginx-snippet', template: 'family-dinner-nginx-v1' }),
    operation({ id: 'install-runtime', type: 'runtime.run-npm', title: 'Install Family Dinner runtime dependencies', timeoutMs: 600000, dependsOn: ['write-nginx'], preconditions: ['dinner-checkout'], task: 'install-production' }),
    operation({ id: 'run-migrations', type: 'runtime.run-npm', title: 'Run Family Dinner migrations', timeoutMs: 300000, dependsOn: ['install-runtime'], preconditions: ['dinner-checkout'], task: 'migrate' }),
    operation({ id: 'reload-systemd', type: 'systemd.daemon-reload', title: 'Reload systemd units', dependsOn: ['run-migrations'] }),
    operation({ id: 'start-service', type: 'systemd.ensure-service', title: 'Enable and restart Family Dinner', dependsOn: ['reload-systemd'], unit: 'family-dinner.service', action: 'enable-and-restart' }),
    operation({ id: 'reload-nginx', type: 'nginx.validate-and-reload', title: 'Validate and reload nginx', dependsOn: ['start-service'], preconditions: ['nginx-configured'] }),
    operation({ id: 'wait-ready', type: 'http.wait-ready', title: 'Wait for Family Dinner readiness', risk: 'read', timeoutMs: 60000, dependsOn: ['reload-nginx'], executor: 'homebase', port: app.network.preferredPort, path: app.network.health.readinessPath }),
  ];
  return planEnvelope({ kind: 'app-install', target: app.id, policyProfile: 'family-dinner-v1', operations, generatedAt, catalogRevision });
}

module.exports = { buildDinnerInstallPlan };
