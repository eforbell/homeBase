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

function transportFor(config = {}) {
  return config.gitTransport === 'ssh' || config.gitTransport === 'ssh-key' ? 'ssh' : 'https';
}

function resolveRef(app, requested) {
  const ref = requested == null || String(requested).trim() === '' ? app.repository.defaultRef || 'main' : String(requested).trim();
  return REF_PATTERN.test(ref) ? ref : null;
}

// The install action Home Base sends; null ref means the request asked for something the executor refuses.
function buildExecutorInstallAction({ appId, ref, config = {} }) {
  const app = getAppById(appId);
  if (!app) return null;
  return { action: 'install', appId, ref: resolveRef(app, ref), transport: transportFor(config), site: siteFor(config) };
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
    },
  };
}

module.exports = { buildExecutorInstallAction, buildExecutorInstallRecord, siteFor, transportFor };
