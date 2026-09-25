const crypto = require('crypto');
const { ProtocolError } = require('./protocol-error');
const { buildHostBootstrapPlan } = require('../src/operations/compilers/bootstrap');
const { buildAppInstallPlan, buildAppAdoptPlan } = require('../src/operations/compilers/install');
const { buildAppRestartPlan, buildAppBackupPlan, buildAppRestorePlan, buildAppUninstallPlan } = require('../src/operations/compilers/lifecycle');
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
});
// Apps the executor manages. Each entry has passed the runbook (docs/executor-app-runbook.md),
// including a container run; since 2026-09-25 that is the whole catalog.
const INSTALLABLE_APPS = Object.freeze(['family-dinner', 'home-source', 'family-plan', 'fast-to-eat', 'family-help', 'home-ops', 'family-pulse', 'bug-base', 'helm', 'bitcoin-accounting']);
const ACTION_FIELDS = ['action', 'appId', 'ref', 'transport', 'site', 'backupId', 'keepBackups'];

function deny(message) { throw new ProtocolError('POLICY_DENIED', message); }
function invalid(message) { throw new ProtocolError('INVALID_REQUEST', message); }

function normalizeAction(request) {
  const spec = typeof request.action === 'string' && Object.hasOwn(ACTIONS, request.action) ? ACTIONS[request.action] : null;
  if (!spec) invalid('Unsupported action.');
  for (const field of ACTION_FIELDS.slice(1)) {
    if (!spec.fields.includes(field) && field in request) invalid(`${field} is not accepted for ${request.action}.`);
  }
  if (request.action === 'bootstrap') return { action: 'bootstrap' };
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
  if (typeof request.ref !== 'string' || !/^(main|[a-f0-9]{40})$/.test(request.ref)) invalid('ref must be main or a 40-character commit SHA.');
  if (!['https', 'ssh'].includes(request.transport)) invalid('transport must be https or ssh.');
  if (!isValidSite(request.site)) invalid('site must be exactly { hostname, domain, householdTimezone } with valid values.');
  const site = { hostname: request.site.hostname, domain: request.site.domain, householdTimezone: request.site.householdTimezone };
  return { action: request.action, appId: request.appId, ref: request.ref, transport: request.transport, site };
}

function compileAction(action, { generatedAt = new Date().toISOString() } = {}) {
  let plan;
  if (action.action === 'bootstrap') {
    plan = buildHostBootstrapPlan({ generatedAt });
  } else if (!INSTALLABLE_APPS.includes(action.appId)) {
    deny(`The executor does not manage ${action.appId} yet.`);
  } else if (action.action === 'install') {
    plan = buildAppInstallPlan({ appId: action.appId, ref: action.ref, gitTransport: action.transport, site: action.site, generatedAt });
  } else if (action.action === 'adopt') {
    plan = buildAppAdoptPlan({ appId: action.appId, ref: action.ref, gitTransport: action.transport, site: action.site, generatedAt });
  } else if (action.action === 'restart') {
    plan = buildAppRestartPlan({ appId: action.appId, generatedAt });
  } else if (action.action === 'backup') {
    plan = buildAppBackupPlan({ appId: action.appId, generatedAt });
  } else if (action.action === 'restore') {
    plan = buildAppRestorePlan({ appId: action.appId, backupId: action.backupId, generatedAt });
  } else if (action.action === 'uninstall') {
    plan = buildAppUninstallPlan({ appId: action.appId, keepBackups: action.keepBackups, generatedAt });
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

module.exports = { ACTIONS, ACTION_FIELDS, INSTALLABLE_APPS, normalizeAction, compileAction, generateSecretBindings };
