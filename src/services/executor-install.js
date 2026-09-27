const path = require('path');
const { getAppById } = require('../catalog');
const { APPS_ROOT } = require('../operations/paths');

// Executor-mode install metadata, derived only from the catalog and Home Base's site settings. The
// legacy planner is never involved here: it renders .env files (with generated credentials) and shell
// commands, and none of that may exist in the web process for executor installs.

const REF_PATTERN = /^(main|[a-f0-9]{40})$/;

function siteFor(config = {}) {
  return {
    hostname: config.defaultHostname || 'homebase',
    domain: config.defaultDomain || 'tailnet',
    householdTimezone: config.householdTimezone || 'America/New_York',
  };
}

// The executor's own transport wins: on a legacy host that is adopting apps, HOME_BASE_GIT_TRANSPORT
// still describes the legacy path (sovereign's key), while the executor fetches with its root-only key.
function transportFor(config = {}) {
  if (config.homeBaseExecutorGitTransport === 'ssh' || config.homeBaseExecutorGitTransport === 'https') return config.homeBaseExecutorGitTransport;
  return config.gitTransport === 'ssh' || config.gitTransport === 'ssh-key' ? 'ssh' : 'https';
}

function resolveRef(app, requested) {
  const ref = requested == null || String(requested).trim() === '' ? app.repository.defaultRef || 'main' : String(requested).trim();
  return REF_PATTERN.test(ref) ? ref : null;
}

// The install action Home Base sends; null ref means the request asked for something the executor refuses.
function buildExecutorInstallAction({ appId, ref, config = {}, action = 'install' }) {
  const app = getAppById(appId);
  if (!app) return null;
  return { action, appId, ref: resolveRef(app, ref), transport: transportFor(config), site: siteFor(config) };
}

// Which path manages an app. A host in executor mode manages every app through the executor. A host in
// legacy-sudo mode keeps the legacy path for each app until that app is adopted, so apps move over one
// at a time and the host switches mode only once all of them have.
// The one place that decides this; every route, the UI label, and update checks ask it.
//   executor  - the executor runs every action for the app
//   adopting  - an adopt started and has not completed; only adopt (or abandon) may run
//   legacy    - legacy-sudo plans run it
//   plan-only - nothing runs privileged actions on this host
function appManagement(config = {}, state = {}, appId) {
  if (config.homeBaseExecutionMode === 'executor') return 'executor';
  if (config.homeBaseExecutionMode !== 'legacy-sudo') return 'plan-only';
  const managedBy = state.installations?.[appId]?.managedBy;
  return managedBy === 'executor' || managedBy === 'adopting' ? managedBy : 'legacy';
}

function executorManagesApp(config = {}, state = {}, appId) {
  return appManagement(config, state, appId) === 'executor';
}

// Home Base's record of an executor install: the executor always installs at the catalog's port and
// mount path under the standard apps root, so only the ref varies.
function buildExecutorInstallRecord({ appId, ref, config = {} }) {
  const app = getAppById(appId);
  const site = siteFor(config);
  const mountPath = app.network.preferredMountPath;
  const resolvedRef = resolveRef(app, ref);
  return {
    ref: resolvedRef,
    stateRecord: {
      appId: app.id,
      name: app.name,
      port: app.network.preferredPort,
      mountPath,
      externalUrl: `https://${site.hostname}.${site.domain}${mountPath}`,
      installRoot: path.posix.join(APPS_ROOT, app.repoKey),
      serviceName: app.service.name,
      ref: resolvedRef,
      status: 'planned',
      plannedAt: new Date().toISOString(),
      managedBy: 'executor',
    },
  };
}

module.exports = { appManagement, buildExecutorInstallAction, buildExecutorInstallRecord, executorManagesApp, siteFor, transportFor };
