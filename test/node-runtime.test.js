const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NODE_MIN_MAJOR, NODE_PROVISION_MAJOR } = require('../src/node-runtime');
const { runPreflightChecks } = require('../src/services/preflight');

const root = path.join(__dirname, '..');

// A directory whose `node` is this Node.js reporting `version`, for PATH-based version checks.
function nodeStubDir(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-node-stub-'));
  const stub = path.join(__dirname, 'fixtures', 'node-version-stub.js');
  fs.writeFileSync(path.join(dir, 'node'), [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo v${version}; exit 0; fi`,
    `NODE_STUB_VERSION=${version} exec "${process.execPath}" --require "${stub}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return dir;
}

test('install.sh carries the same Node.js floor and provisioned line as src/node-runtime.js', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.equal(Number(installer.match(/^NODE_MIN_MAJOR=(\d+)$/m)?.[1]), NODE_MIN_MAJOR);
  assert.equal(Number(installer.match(/^NODE_PROVISION_MAJOR=(\d+)$/m)?.[1]), NODE_PROVISION_MAJOR);
  assert.ok(NODE_PROVISION_MAJOR >= NODE_MIN_MAJOR);
  assert.match(installer, /^NODESOURCE_KEY_SHA256='[a-f0-9]{64}'$/m, 'the NodeSource key is pinned by checksum');
  assert.match(installer, /signed-by=%s\] https:\/\/deb\.nodesource\.com\/node_%s\.x nodistro main/);
});

test('package.json engines matches the Node.js floor', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, `>=${NODE_MIN_MAJOR}`);
});

test('preflight fails a host whose Node.js is below the floor and passes one at it', () => {
  const nodeCheck = (version) => {
    const stubDir = nodeStubDir(version);
    const result = runPreflightChecks({}, {
      runCommand(command) {
        if (!command.includes('node --version')) return { ok: true, exitCode: 0, stdout: 'ok', stderr: '' };
        const { spawnSync } = require('child_process');
        const run = spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` } });
        return { ok: run.status === 0, exitCode: run.status, stdout: run.stdout.trim(), stderr: run.stderr.trim() };
      },
    });
    return result.checks.find((check) => check.id === 'node');
  };
  const old = nodeCheck('18.19.1');
  assert.equal(old.ok, false);
  assert.match(old.summary, /v18\.19\.1/);
  assert.match(old.hint, new RegExp(`Node\\.js ${NODE_MIN_MAJOR}\\+`));
  assert.equal(nodeCheck(`${NODE_MIN_MAJOR}.0.0`).ok, true);
});
