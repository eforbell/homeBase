const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePathname,
  isOperationallyReady,
  shouldRedirectToSetup,
} = require('../src/setup-gate');

test('normalizePathname strips trailing slash except root', () => {
  assert.equal(normalizePathname('/'), '/');
  assert.equal(normalizePathname('/apps/'), '/apps');
  assert.equal(normalizePathname('/settings'), '/settings');
});

test('isOperationallyReady treats installed apps as ready', () => {
  const ready = isOperationallyReady({
    state: { installations: { 'family-help': {} } },
    preflight: { checks: [{ id: 'os', severity: 'critical', ok: false }] },
  });
  assert.equal(ready, true);
});

test('shouldRedirectToSetup only for bootstrap targets with critical failures and no installs', () => {
  const preflight = {
    checks: [
      { id: 'os', severity: 'critical', ok: false },
      { id: 'tailscale', severity: 'warning', ok: false },
    ],
  };
  const state = { installations: {} };
  assert.equal(shouldRedirectToSetup({ pathname: '/', state, preflight }), true);
  assert.equal(shouldRedirectToSetup({ pathname: '/apps/', state, preflight }), true);
  assert.equal(shouldRedirectToSetup({ pathname: '/setup', state, preflight }), false);
  assert.equal(shouldRedirectToSetup({ pathname: '/api/state', state, preflight }), false);
});
