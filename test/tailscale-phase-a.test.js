const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'tailscale');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function readServeConfigFromEnvelope(name) {
  const envelope = readJson(name);
  assert.equal(typeof envelope.exitCode, 'number');
  if (envelope.exitCode !== 0) return { envelope, config: null };
  return { envelope, config: JSON.parse(String(envelope.stdout || '{}')) };
}

test('phase A fixture set includes local and remote serve/status captures', () => {
  const expected = [
    'status-snapshot-local-mac.json',
    'status-snapshot-erebor.json',
    'serve-config-all-local-mac.json',
    'serve-config-all-erebor.json',
    'serve-config-all-numenor.json',
    'serve-config-all-rivendell.json',
    'status-snapshot-sh-test-1-needs-login.json',
    'serve-config-all-sh-test-1-needs-login.json',
    'version-sh-test-1.json',
    'status-snapshot-sh-test-clean-stopped.json',
  ];
  for (const file of expected) {
    assert.ok(fs.existsSync(path.join(FIXTURE_DIR, file)), `missing fixture ${file}`);
  }
});

test('phase A includes an empty serve-config shape and populated multi-service shapes', () => {
  const local = readServeConfigFromEnvelope('serve-config-all-local-mac.json');
  assert.equal(local.envelope.exitCode, 0);
  assert.equal(local.config.version, '0.0.1');
  assert.ok(!local.config.services || Object.keys(local.config.services).length === 0);

  const erebor = readServeConfigFromEnvelope('serve-config-all-erebor.json');
  assert.equal(erebor.envelope.exitCode, 0);
  assert.ok(erebor.config.services);
  assert.ok(erebor.config.services['svc:home']);
  assert.equal(erebor.config.services['svc:home'].endpoints['tcp:3080'], 'http://127.0.0.1:3080');
  assert.equal(erebor.config.services['svc:home'].endpoints['tcp:443'], 'https+insecure://localhost:443');
});

test('phase A captures a real endpoint-ownership conflict case for policy enforcement', () => {
  const numenor = readServeConfigFromEnvelope('serve-config-all-numenor.json');
  assert.equal(numenor.envelope.exitCode, 0);
  assert.ok(numenor.config.services);
  assert.equal(numenor.config.services['svc:bitcoin'].endpoints['tcp:443'], 'https+insecure://localhost:443');
  assert.ok(!numenor.config.services['svc:home'], 'expected non-home tcp:443 ownership example');
});

test('phase A includes Linux not-logged-in fixtures for readiness and parser error paths', () => {
  const status = readJson('status-snapshot-sh-test-1-needs-login.json');
  assert.equal(status.exitCode, 0);
  assert.equal(status.snapshot.BackendState, 'NeedsLogin');
  assert.equal(status.snapshot.Self.OS, 'linux');
  assert.equal(status.snapshot.HealthCount, 1);

  const serve = readServeConfigFromEnvelope('serve-config-all-sh-test-1-needs-login.json');
  assert.notEqual(serve.envelope.exitCode, 0);
  assert.equal(serve.config, null);
  assert.match(serve.envelope.stderr, /Logged out\./);

  const version = readJson('version-sh-test-1.json');
  assert.equal(version.exitCode, 0);
  assert.match(version.stdout, /^1\.96\.4/m);
  assert.match(version.stdout, /long version: 1\.96\.4-t8cf541dfd-g62bc84ce7/);
});



test('phase A includes Linux stopped backend fixture for daemon-off readiness handling', () => {
  const stopped = readJson('status-snapshot-sh-test-clean-stopped.json');
  assert.equal(stopped.exitCode, 0);
  assert.equal(stopped.snapshot.BackendState, 'Stopped');
  assert.equal(stopped.snapshot.Self.OS, 'linux');
  assert.equal(stopped.snapshot.HealthCount, 2);
  assert.equal(stopped.snapshot.PeerCount, 18);
});

test('status snapshots are sanitized and include readiness-relevant metadata', () => {
  const local = readJson('status-snapshot-local-mac.json');
  const erebor = readJson('status-snapshot-erebor.json');
  for (const entry of [local, erebor]) {
    assert.equal(entry.exitCode, 0);
    assert.ok(entry.snapshot);
    assert.equal(entry.snapshot.BackendState, 'Running');
    assert.equal(typeof entry.snapshot.PeerCount, 'number');
    assert.ok(!('Peer' in entry.snapshot), 'snapshot should be sanitized');
    assert.ok(!('User' in entry.snapshot), 'snapshot should be sanitized');
  }
});
