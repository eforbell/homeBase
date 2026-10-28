const { getAppById } = require('../../catalog');
const { appLayout } = require('../app-layout');
const { operation, planEnvelope } = require('./common');

// Restart, backup, restore, and uninstall compile from the same catalog layout as install.
// Destructive plans (restore, uninstall) take a safety backup before changing anything.

const { archiveNameFor } = require('./archive-name');

function layoutFor(appId) {
  const app = getAppById(appId);
  if (!app) throw Object.assign(new Error(`Unknown catalog app: ${appId}`), { code: 'POLICY_DENIED' });
  return appLayout(app);
}

function sequence() {
  const operations = [];
  const add = (fields) => {
    const previous = operations.at(-1);
    operations.push(operation({ dependsOn: previous ? [previous.id] : [], ...fields }));
  };
  return { operations, add };
}

// Main service first on start, last on stop, so sidecars and timers never run without it.
function startUnits(layout, add) {
  add({ id: 'start-service', type: 'systemd.ensure-service', title: `Restart ${layout.app.name}`, unit: layout.service.unit, action: 'enable-and-restart' });
  layout.sidecars.forEach((sidecar, index) => add({ id: `start-sidecar-${index + 1}`, type: 'systemd.ensure-service', title: `Restart ${sidecar.name}`, unit: sidecar.unit, action: 'enable-and-restart' }));
  layout.timers.forEach((timer, index) => add({ id: `start-timer-${index + 1}`, type: 'systemd.ensure-service', title: `Restart ${timer.timerUnit}`, unit: timer.timerUnit, action: 'enable-and-restart' }));
}

function stopUnits(layout, add, action) {
  const verb = action === 'disable-now' ? 'Disable and stop' : 'Stop';
  layout.timers.forEach((timer, index) => {
    add({ id: `stop-timer-${index + 1}`, type: 'systemd.ensure-service', title: `${verb} ${timer.timerUnit}`, risk: 'destructive', unit: timer.timerUnit, action });
    // A run the timer already started keeps going (as whoever it started as) unless its service stops too.
    add({ id: `stop-timer-service-${index + 1}`, type: 'systemd.ensure-service', title: `Stop ${timer.serviceUnit}`, risk: 'destructive', unit: timer.serviceUnit, action: 'stop' });
  });
  layout.sidecars.forEach((sidecar, index) => add({ id: `stop-sidecar-${index + 1}`, type: 'systemd.ensure-service', title: `${verb} ${sidecar.name}`, risk: 'destructive', unit: sidecar.unit, action }));
  add({ id: 'stop-service', type: 'systemd.ensure-service', title: `${verb} ${layout.app.name}`, risk: 'destructive', unit: layout.service.unit, action });
}

function waitReady(layout, add) {
  add({ id: 'wait-ready', type: 'http.wait-ready', title: `Wait for ${layout.app.name} readiness`, risk: 'read', timeoutMs: 60000, executor: 'homebase', port: layout.port, path: layout.readinessPath });
}

// whatRemains: back up whatever still exists (used by uninstall, so a re-run after an interruption
// that already dropped the database or removed the checkout is not blocked by its own safety backup).
function backupOperation(layout, archiveName, id = 'create-backup', title = `Back up ${layout.app.name}`, { whatRemains = false } = {}) {
  return { id, type: 'backup.create', title, timeoutMs: 900000, archiveName, ...(whatRemains ? { whatRemains: true } : {}) };
}

function buildAppRestartPlan({ appId, generatedAt = new Date().toISOString(), catalogRevision } = {}) {
  const layout = layoutFor(appId);
  const { operations, add } = sequence();
  startUnits(layout, add);
  waitReady(layout, add);
  return planEnvelope({ kind: 'app-restart', target: layout.app.id, policyProfile: 'app-restart-v1', operations, generatedAt, catalogRevision });
}

function buildAppBackupPlan({ appId, generatedAt = new Date().toISOString(), catalogRevision } = {}) {
  const layout = layoutFor(appId);
  const { operations, add } = sequence();
  add(backupOperation(layout, archiveNameFor(generatedAt)));
  return planEnvelope({ kind: 'app-backup', target: layout.app.id, policyProfile: 'app-backup-v1', operations, generatedAt, catalogRevision });
}

function buildAppRestorePlan({ appId, backupId, generatedAt = new Date().toISOString(), catalogRevision } = {}) {
  const layout = layoutFor(appId);
  const safetyName = archiveNameFor(generatedAt);
  if (safetyName === backupId) throw Object.assign(new Error('Restore source and safety backup names collide; retry.'), { code: 'POLICY_DENIED' });
  const { operations, add } = sequence();
  // Read-only check of the source archive before anything is stopped or changed.
  add({ id: 'verify-backup', type: 'backup.verify', title: `Verify backup ${backupId} is complete and readable`, risk: 'read', timeoutMs: 300000, archiveName: backupId });
  add(backupOperation(layout, safetyName, 'safety-backup', `Back up ${layout.app.name} before restoring`));
  stopUnits(layout, add, 'stop');
  add({ id: 'restore-backup', type: 'backup.restore', title: `Restore ${layout.app.name} from ${backupId}`, risk: 'destructive', timeoutMs: 900000, archiveName: backupId });
  startUnits(layout, add);
  waitReady(layout, add);
  return planEnvelope({ kind: 'app-restore', target: layout.app.id, policyProfile: 'app-restore-v1', operations, generatedAt, catalogRevision });
}

// Removes the checkout (with any in-checkout storage), units, nginx snippet, git mirror, and database.
// External storage (storage.absoluteRoot) is kept: it holds user data that a reinstall should find again.
function buildAppUninstallPlan({ appId, keepBackups = true, generatedAt = new Date().toISOString(), catalogRevision } = {}) {
  const layout = layoutFor(appId);
  const { operations, add } = sequence();
  if (keepBackups) add(backupOperation(layout, archiveNameFor(generatedAt), 'safety-backup', `Back up what remains of ${layout.app.name} before uninstalling`, { whatRemains: true }));
  stopUnits(layout, add, 'disable-now');
  add({ id: 'remove-artifacts', type: 'filesystem.remove-app-artifacts', title: `Remove ${layout.app.name} units, nginx snippet, and git mirror`, risk: 'destructive' });
  add({ id: 'reload-systemd', type: 'systemd.daemon-reload', title: 'Reload systemd units' });
  add({ id: 'reload-nginx', type: 'nginx.validate-and-reload', title: 'Validate and reload nginx' });
  if (layout.database) add({ id: 'drop-database', type: 'postgres.drop-database', title: `Drop ${layout.app.name} database and role`, risk: 'destructive', database: layout.database.name, owner: layout.database.user });
  // In-checkout storage goes with the checkout (the safety backup above holds it); say so on the plan.
  const inCheckout = layout.storage?.inCheckout ? ` and its ${layout.storage.subpaths.join(', ')} storage` : '';
  add({ id: 'remove-checkout', type: 'filesystem.remove-checkout', title: `Remove ${layout.app.name} install directory${inCheckout}`, risk: 'destructive' });
  if (!keepBackups) add({ id: 'remove-backups', type: 'backup.remove-all', title: `Remove ${layout.app.name} backups`, risk: 'destructive' });
  return planEnvelope({ kind: 'app-uninstall', target: layout.app.id, policyProfile: 'app-uninstall-v1', operations, generatedAt, catalogRevision });
}

// Moves a sensitive app installed before SID-002 from the shared user to its own (one time, on request):
// a safety backup, stop, hand every file over, then the .env and units again as the new user, and start.
// Re-running it after an interruption picks up where it stopped (the checkout is handed over last).
function buildAppMoveUserPlan({ appId, site, generatedAt = new Date().toISOString(), catalogRevision } = {}) {
  const layout = layoutFor(appId);
  if (!layout.identity.own) throw Object.assign(new Error(`${layout.app.name} runs as the shared user by design.`), { code: 'POLICY_DENIED' });
  const { operations, add } = sequence();
  const name = layout.app.name;
  // Read only, before the app stops: refuse what the hand-over can't finish (a mount inside a tree).
  add({ id: 'check-app-trees', type: 'filesystem.check-app-trees', title: `Check ${name}'s files can be handed over`, risk: 'read' });
  add(backupOperation(layout, archiveNameFor(generatedAt), 'safety-backup', `Back up ${name} before moving it to ${layout.identity.user}`));
  stopUnits(layout, add, 'stop');
  add({ id: 'ensure-app-user', type: 'identity.ensure-user', title: `Ensure the ${layout.identity.user} identity`, user: layout.identity.user });
  add({ id: 'ensure-app-home', type: 'filesystem.ensure-directory', title: `Ensure ${layout.identity.user} home`, purpose: 'app-home' });
  add({ id: 'reown-app', type: 'filesystem.reown-app', title: `Hand ${name}'s checkout, data and backups to ${layout.identity.user}`, risk: 'destructive', timeoutMs: 600000 });
  add({
    id: 'write-environment', type: 'filesystem.write-managed-file', title: `Write ${name} environment as ${layout.identity.user}`,
    secretRefs: layout.database ? ['databasePassword'] : [], purpose: 'app-env', template: 'app-env-v1',
    site: { hostname: site.hostname, domain: site.domain, householdTimezone: site.householdTimezone },
  });
  const timezone = site.householdTimezone;
  add({ id: 'write-service', type: 'filesystem.write-managed-file', title: `Write ${name} service unit`, purpose: 'systemd-unit', template: 'app-service-v1', unit: layout.service.unit, timezone });
  layout.sidecars.forEach((sidecar, index) => add({ id: `write-sidecar-${index + 1}`, type: 'filesystem.write-managed-file', title: `Write ${sidecar.name} service unit`, purpose: 'systemd-unit', template: 'app-sidecar-service-v1', unit: sidecar.unit, timezone }));
  layout.timers.forEach((timer, index) => add({ id: `write-timer-service-${index + 1}`, type: 'filesystem.write-managed-file', title: `Write ${timer.serviceName} service unit`, purpose: 'systemd-unit', template: 'app-timer-service-v1', unit: timer.serviceUnit, timezone }));
  if (layout.listen.kind === 'unix') {
    add({ id: 'write-socket-tmpfiles', type: 'filesystem.write-managed-file', title: `Write ${name} socket directory entry for ${layout.identity.user}`, purpose: 'app-tmpfiles', template: 'app-tmpfiles-v1' });
    add({ id: 'ensure-socket-directory', type: 'systemd.apply-tmpfiles', title: `Hand ${name}'s socket directory to ${layout.identity.user}` });
  }
  add({ id: 'reload-systemd', type: 'systemd.daemon-reload', title: 'Reload systemd units' });
  startUnits(layout, add);
  waitReady(layout, add);
  return planEnvelope({ kind: 'app-move-user', target: layout.app.id, policyProfile: 'app-move-user-v1', operations, generatedAt, catalogRevision });
}

module.exports = { archiveNameFor, buildAppRestartPlan, buildAppBackupPlan, buildAppRestorePlan, buildAppUninstallPlan, buildAppMoveUserPlan };
