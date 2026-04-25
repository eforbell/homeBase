const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  HOME_SERVICE_ID,
  REQUIRED_HOME_ENDPOINTS,
  buildMergedServeConfig,
  buildTailscalePublishPlan,
  detectEndpointConflicts,
  parseServeConfigFromCommandResult,
} = require('../src/services/tailscale-publisher');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'tailscale');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function serveResult(name) {
  const fixture = readJson(name);
  return {
    command: fixture.commandString,
    ok: fixture.exitCode === 0,
    exitCode: fixture.exitCode,
    stdout: fixture.stdout || '',
    stderr: fixture.stderr || '',
  };
}

test('parse serve envelope returns normalized config for successful command', () => {
  const parsed = parseServeConfigFromCommandResult(serveResult('serve-config-all-rivendell.json'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.version, '0.0.1');
  assert.ok(parsed.config.services['svc:transmission']);
});

test('detectEndpointConflicts reports non-home owners for required endpoints', () => {
  const parsed = parseServeConfigFromCommandResult(serveResult('serve-config-all-numenor.json'));
  const conflicts = detectEndpointConflicts(parsed.config.services, REQUIRED_HOME_ENDPOINTS);
  assert.equal(conflicts.length >= 1, true);
  assert.equal(conflicts.some((c) => c.ownerService === 'svc:bitcoin' && c.endpoint === 'tcp:443'), true);
});

test('buildMergedServeConfig only mutates svc:home and preserves unrelated services', () => {
  const parsed = parseServeConfigFromCommandResult(serveResult('serve-config-all-numenor.json'));
  const merged = buildMergedServeConfig(parsed.config, REQUIRED_HOME_ENDPOINTS);

  assert.ok(merged.services['svc:bitcoin']);
  assert.ok(merged.services['svc:lightning']);
  assert.deepEqual(merged.services[HOME_SERVICE_ID].endpoints, REQUIRED_HOME_ENDPOINTS);
});

test('publish plan is executable when no ownership conflicts exist', () => {
  const plan = buildTailscalePublishPlan({
    serveResult: serveResult('serve-config-all-rivendell.json'),
    readiness: { readiness: { state: 'authenticated-unpublished' } },
    hostname: 'homebase',
    domain: 'tailnet',
  });

  assert.equal(plan.canExecute, true);
  assert.equal(plan.blockedReason, null);
  assert.equal(Array.isArray(plan.executionSteps), true);
  assert.equal(plan.executionSteps.length > 0, true);
  assert.equal(plan.mergedConfig.services['svc:transmission'] != null, true);
});

test('publish plan is blocked when required endpoint is owned by non-home service', () => {
  const plan = buildTailscalePublishPlan({
    serveResult: serveResult('serve-config-all-numenor.json'),
    readiness: { readiness: { state: 'authenticated-unpublished' } },
    hostname: 'homebase',
    domain: 'tailnet',
  });

  assert.equal(plan.canExecute, false);
  assert.equal(plan.blockedReason, 'endpoint-ownership-conflict');
  assert.equal(plan.conflicts.length >= 1, true);
  assert.equal(plan.executionSteps.length, 0);
});

test('publish plan is blocked when serve config cannot be read', () => {
  const plan = buildTailscalePublishPlan({
    serveResult: serveResult('serve-config-all-sh-test-1-needs-login.json'),
    readiness: { readiness: { state: 'not-authenticated' } },
    hostname: 'homebase',
    domain: 'tailnet',
  });

  assert.equal(plan.canExecute, false);
  assert.equal(plan.blockedReason, 'serve-config-unavailable');
  assert.match(plan.summary, /cannot plan publish changes/i);
});
