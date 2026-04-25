const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildTailscaleReadinessFromResults } = require('../src/services/tailscale-readiness');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'tailscale');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function installProbe(ok = true) {
  return {
    command: 'command -v tailscale',
    ok,
    exitCode: ok ? 0 : 1,
    stdout: ok ? '/usr/bin/tailscale\n' : '',
    stderr: ok ? '' : 'command not found',
  };
}

function versionResult() {
  const fixture = readJson('version-local-mac.json');
  return {
    command: fixture.commandString,
    ok: fixture.exitCode === 0,
    exitCode: fixture.exitCode,
    stdout: fixture.stdout,
    stderr: fixture.stderr,
  };
}

function statusResult(name) {
  const fixture = readJson(name);
  return {
    command: fixture.commandString,
    ok: fixture.exitCode === 0,
    exitCode: fixture.exitCode,
    stdout: JSON.stringify(fixture.snapshot || {}),
    stderr: '',
  };
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

test('readiness maps to published when svc:home recommended endpoints are present', () => {
  const readiness = buildTailscaleReadinessFromResults({
    commandResults: {
      installProbe: installProbe(true),
      version: versionResult(),
      status: statusResult('status-snapshot-erebor.json'),
      serve: serveResult('serve-config-all-erebor.json'),
    },
  });

  assert.equal(readiness.readiness.state, 'published');
  assert.equal(readiness.status.authenticated, true);
  assert.equal(readiness.serve.managedHomeServicePresent, true);
  assert.equal(readiness.serve.homeRecommendedReady, true);
});

test('readiness maps to authenticated-unpublished when authenticated but svc:home is absent', () => {
  const readiness = buildTailscaleReadinessFromResults({
    commandResults: {
      installProbe: installProbe(true),
      version: versionResult(),
      status: statusResult('status-snapshot-numenor.json'),
      serve: serveResult('serve-config-all-numenor.json'),
    },
  });

  assert.equal(readiness.readiness.state, 'authenticated-unpublished');
  assert.equal(readiness.status.authenticated, true);
  assert.equal(readiness.serve.managedHomeServicePresent, false);
  assert.deepEqual(readiness.serve.tcp443Owners.sort(), ['svc:bitcoin', 'svc:lightning']);
});

test('readiness maps to not-authenticated when backend state is NeedsLogin and serve returns logged-out', () => {
  const readiness = buildTailscaleReadinessFromResults({
    commandResults: {
      installProbe: installProbe(true),
      version: versionResult(),
      status: statusResult('status-snapshot-sh-test-1-needs-login.json'),
      serve: serveResult('serve-config-all-sh-test-1-needs-login.json'),
    },
  });

  assert.equal(readiness.readiness.state, 'not-authenticated');
  assert.equal(readiness.status.backendState, 'NeedsLogin');
  assert.equal(readiness.status.authenticated, false);
  assert.equal(readiness.serve.ok, false);
  assert.match(readiness.serve.error, /logged out/i);
});

test('readiness keeps authenticated-unpublished for stopped backend with no home publish config', () => {
  const readiness = buildTailscaleReadinessFromResults({
    commandResults: {
      installProbe: installProbe(true),
      version: versionResult(),
      status: statusResult('status-snapshot-sh-test-clean-stopped.json'),
      serve: serveResult('serve-config-all-local-mac.json'),
    },
  });

  assert.equal(readiness.status.backendState, 'Stopped');
  assert.equal(readiness.status.authenticated, true);
  assert.equal(readiness.status.daemonRunning, false);
  assert.equal(readiness.readiness.state, 'authenticated-unpublished');
});

test('readiness maps to not-installed when tailscale cli is missing', () => {
  const readiness = buildTailscaleReadinessFromResults({
    commandResults: {
      installProbe: installProbe(false),
    },
  });

  assert.equal(readiness.readiness.state, 'not-installed');
  assert.equal(readiness.installed.ok, false);
  assert.equal(readiness.status, null);
  assert.equal(readiness.serve, null);
});
