const crypto = require('crypto');
const { ProtocolError } = require('./protocol-error');
const { buildDinnerBootstrapPlan } = require('../src/operations/compilers/bootstrap');
const { buildDinnerInstallPlan } = require('../src/operations/compilers/install');
const { validateOperationPolicy } = require('../src/operations/policy');
const { digestOperationPlan } = require('../src/operations/digest');
const { getAppById } = require('../src/catalog');

// The executor builds every plan it runs. Callers name a high-level action; they never submit
// operations, paths, commands, or secrets.
const ACTIONS = Object.freeze({
  bootstrap: { fields: [] },
  install: { fields: ['appId', 'ref', 'transport'] },
});
// Apps whose install the executor can compile today. Grows as catalog shapes are supported.
const INSTALLABLE_APPS = Object.freeze(['family-dinner']);
const ACTION_FIELDS = ['action', 'appId', 'ref', 'transport'];

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
  if (typeof request.ref !== 'string' || !/^(main|[a-f0-9]{40})$/.test(request.ref)) invalid('ref must be main or a 40-character commit SHA.');
  if (!['https', 'ssh'].includes(request.transport)) invalid('transport must be https or ssh.');
  return { action: 'install', appId: request.appId, ref: request.ref, transport: request.transport };
}

function compileAction(action, { generatedAt = new Date().toISOString() } = {}) {
  let plan;
  if (action.action === 'bootstrap') {
    plan = buildDinnerBootstrapPlan({ generatedAt });
  } else if (action.action === 'install') {
    if (!INSTALLABLE_APPS.includes(action.appId)) deny(`The executor cannot install ${action.appId} yet.`);
    plan = buildDinnerInstallPlan({ appId: action.appId, ref: action.ref, gitTransport: action.transport, generatedAt });
  } else {
    deny('Unsupported action.');
  }
  // Defense in depth: the executor's own compiler output must still satisfy schema and policy.
  validateOperationPolicy(plan);
  return { plan, planDigest: digestOperationPlan(plan) };
}

// Secrets are generated inside the executor, so they never exist in the web process.
const SECRET_GENERATORS = Object.freeze({
  familyDinnerDatabasePassword: () => crypto.randomBytes(24).toString('base64url'),
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
