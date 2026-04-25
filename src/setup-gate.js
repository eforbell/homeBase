const PAGE_BOOTSTRAP_TARGETS = new Set(['/', '/apps', '/jobs', '/status']);

function normalizePathname(pathname) {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function isOperationallyReady({ state, preflight }) {
  const installations = state && state.installations ? Object.keys(state.installations) : [];
  if (installations.length > 0) return true;
  const criticalFailures = (preflight?.checks || []).some((check) => check.severity === 'critical' && !check.ok);
  return !criticalFailures;
}

function shouldRedirectToSetup({ pathname, state, preflight }) {
  const normalized = normalizePathname(pathname);
  if (!PAGE_BOOTSTRAP_TARGETS.has(normalized)) return false;
  return !isOperationallyReady({ state, preflight });
}

module.exports = {
  PAGE_BOOTSTRAP_TARGETS,
  normalizePathname,
  isOperationallyReady,
  shouldRedirectToSetup,
};
