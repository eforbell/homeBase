const crypto = require('crypto');
const { ProtocolError } = require('./protocol-error');
const { buildHostBootstrapPlan } = require('../src/operations/compilers/bootstrap');
const { buildAppInstallPlan, buildAppAdoptPlan } = require('../src/operations/compilers/install');
const { buildIngressCutoverPlan, buildIngressRollbackPlan, buildServicePublishPlan } = require('../src/operations/compilers/ingress');
const { buildAppRestartPlan, buildAppBackupPlan, buildAppRestorePlan, buildAppUninstallPlan, buildAppMoveUserPlan } = require('../src/operations/compilers/lifecycle');
const { validateOperationPolicy } = require('../src/operations/policy');
const { digestOperationPlan } = require('../src/operations/digest');
const { getAppById } = require('../src/catalog');
const { isValidSite } = require('../src/homebase-config');

// The executor builds every plan it runs. Callers name a high-level action; they never submit
// operations, paths, commands, or secrets.
const ACTIONS = Object.freeze({
  bootstrap: { fields: [] },
  install: { fields: ['appId', 'ref', 'transport', 'site'] },
  adopt: { fields: ['appId', 'ref', 'transport', 'site'] },
  restart: { fields: ['appId'] },
  backup: { fields: ['appId'] },
  restore: { fields: ['appId', 'backupId'] },
  uninstall: { fields: ['appId', 'keepBackups'] },
  // Feature-10 SID-002: move a sensitive app installed before it to its own user (site: its units' timezone).
  'move-user': { fields: ['appId', 'site'] },
  // Feature-10 SID-001 socket ingress. Home Base gates each one first (D23); the executor still binds
  // service names to its own cutover record and checks app identity modes itself before a rollback.
  'ingress-cutover': { fields: ['instance', 'domain', 'legacyService'] },
  'service-publish': { fields: ['serviceKey'] },
  'ingress-rollback': { fields: [] },
});
// Apps the executor manages. Each entry has passed the runbook (docs/executor-app-runbook.md),
// including a container run; since 2026-09-25 that is the whole catalog.
const INSTALLABLE_APPS = Object.freeze(['family-dinner', 'home-source', 'family-plan', 'fast-to-eat', 'family-help', 'home-ops', 'family-pulse', 'bug-base', 'helm', 'bitcoin-accounting', 'home-drop']);
const ACTION_FIELDS = ['action', 'appId', 'ref', 'transport', 'site', 'backupId', 'keepBackups', 'instance', 'domain', 'legacyService', 'serviceKey'];

function deny(message) { throw new ProtocolError('POLICY_DENIED', message); }

// adopt exists only while a legacy-sudo host is moving to the executor. install.sh --add-executor writes
// this root-owned marker and --switch-to-executor removes it, so after the switch a compromised web
// process cannot re-run adopt (which rewrites units and hands database objects around).
const LEGACY_COEXISTENCE_MARKER = '/etc/sovereign-home/legacy-coexistence';
function legacyCoexistence(fsImpl = require('fs')) {
  try {
    const stat = fsImpl.lstatSync(LEGACY_COEXISTENCE_MARKER);
    return stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0;
  } catch { return false; }
}
function invalid(message) { throw new ProtocolError('INVALID_REQUEST', message); }

function normalizeAction(request) {
  const spec = typeof request.action === 'string' && Object.hasOwn(ACTIONS, request.action) ? ACTIONS[request.action] : null;
  if (!spec) invalid('Unsupported action.');
  for (const field of ACTION_FIELDS.slice(1)) {
    if (!spec.fields.includes(field) && field in request) invalid(`${field} is not accepted for ${request.action}.`);
  }
  if (request.action === 'bootstrap') return { action: 'bootstrap' };
  if (request.action === 'ingress-rollback') return { action: 'ingress-rollback' };
  if (request.action === 'service-publish') {
    if (typeof request.serviceKey !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.serviceKey)) invalid('serviceKey must name an ingress service.');
    return { action: 'service-publish', serviceKey: request.serviceKey };
  }
  if (request.action === 'ingress-cutover') {
    if (typeof request.instance !== 'string' || typeof request.domain !== 'string') invalid('instance and domain are required.');
    if (request.legacyService != null && (typeof request.legacyService !== 'string' || !/^svc:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(request.legacyService))) invalid('legacyService must be a service name.');
    return { action: 'ingress-cutover', instance: request.instance, domain: request.domain, ...(request.legacyService ? { legacyService: request.legacyService } : {}) };
  }
  if (typeof request.appId !== 'string' || !getAppById(request.appId)) invalid('appId must name a catalog app.');
  if (request.action === 'restart' || request.action === 'backup') return { action: request.action, appId: request.appId };
  if (request.action === 'restore') {
    if (typeof request.backupId !== 'string' || !/^[0-9]{8}T[0-9]{6}[0-9]{0,3}Z$/.test(request.backupId)) invalid('backupId must name a backup archive.');
    return { action: 'restore', appId: request.appId, backupId: request.backupId };
  }
  if (request.action === 'uninstall') {
    if (typeof request.keepBackups !== 'boolean') invalid('keepBackups must be true or false.');
    return { action: 'uninstall', appId: request.appId, keepBackups: request.keepBackups };
  }
  if (request.action === 'move-user') {
    if (!isValidSite(request.site)) invalid('site must be exactly { hostname, domain, householdTimezone } with valid values.');
    return { action: 'move-user', appId: request.appId, site: { hostname: request.site.hostname, domain: request.site.domain, householdTimezone: request.site.householdTimezone } };
  }
  if (typeof request.ref !== 'string' || !/^(main|[a-f0-9]{40})$/.test(request.ref)) invalid('ref must be main or a 40-character commit SHA.');
  if (!['https', 'ssh'].includes(request.transport)) invalid('transport must be https or ssh.');
  if (!isValidSite(request.site)) invalid('site must be exactly { hostname, domain, householdTimezone } with valid values.');
  const site = { hostname: request.site.hostname, domain: request.site.domain, householdTimezone: request.site.householdTimezone };
  return { action: request.action, appId: request.appId, ref: request.ref, transport: request.transport, site };
}

function compileAction(action, { generatedAt = new Date().toISOString(), adoptAllowed = legacyCoexistence } = {}) {
  let plan;
  if (action.action === 'bootstrap') {
    plan = buildHostBootstrapPlan({ generatedAt });
  } else if (action.action === 'ingress-cutover') {
    plan = buildIngressCutoverPlan({ instance: action.instance, domain: action.domain, legacyService: action.legacyService || null, generatedAt });
  } else if (action.action === 'service-publish') {
    plan = buildServicePublishPlan({ serviceKey: action.serviceKey, generatedAt });
  } else if (action.action === 'ingress-rollback') {
    // App identity modes are checked again by nginx.restore-tcp-gateway, from the apps' own env files.
    plan = buildIngressRollbackPlan({ generatedAt });
  } else if (!INSTALLABLE_APPS.includes(action.appId)) {
    deny(`The executor does not manage ${action.appId} yet.`);
  } else if (action.action === 'install') {
    plan = buildAppInstallPlan({ appId: action.appId, ref: action.ref, gitTransport: action.transport, site: action.site, generatedAt });
  } else if (action.action === 'adopt') {
    if (!adoptAllowed()) deny('adopt is only available while a legacy-sudo host is moving to the executor (install.sh --add-executor).');
    plan = buildAppAdoptPlan({ appId: action.appId, ref: action.ref, gitTransport: action.transport, site: action.site, generatedAt });
  } else if (action.action === 'restart') {
    plan = buildAppRestartPlan({ appId: action.appId, generatedAt });
  } else if (action.action === 'backup') {
    plan = buildAppBackupPlan({ appId: action.appId, generatedAt });
  } else if (action.action === 'restore') {
    plan = buildAppRestorePlan({ appId: action.appId, backupId: action.backupId, generatedAt });
  } else if (action.action === 'uninstall') {
    plan = buildAppUninstallPlan({ appId: action.appId, keepBackups: action.keepBackups, generatedAt });
  } else if (action.action === 'move-user') {
    plan = buildAppMoveUserPlan({ appId: action.appId, site: action.site, generatedAt });
  } else {
    deny('Unsupported action.');
  }
  // Defense in depth: the executor's own compiler output must still satisfy schema and policy.
  validateOperationPolicy(plan);
  return { plan, planDigest: digestOperationPlan(plan) };
}

// Secrets are generated inside the executor, so they never exist in the web process.
const SECRET_GENERATORS = Object.freeze({
  databasePassword: () => crypto.randomBytes(24).toString('base64url'),
});

// Existing values (read by the executor from the app's managed config) win, so reinstalls and
// updates keep credentials stable; new values are generated only when none exist yet.
function generateSecretBindings(plan, { existing = {} } = {}) {
  const bindings = {};
  for (const ref of new Set(plan.operations.flatMap((operation) => operation.secretRefs))) {
    const generate = SECRET_GENERATORS[ref];
    if (!generate) deny(`No generator for secret ${ref}.`);
    bindings[ref] = typeof existing[ref] === 'string' && existing[ref] ? existing[ref] : generate();
  }
  return bindings;
}

module.exports = { ACTIONS, ACTION_FIELDS, INSTALLABLE_APPS, LEGACY_COEXISTENCE_MARKER, legacyCoexistence, normalizeAction, compileAction, generateSecretBindings };
