const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { createExecutorServer } = require('../executor/server');
const { hello, validatePlan } = require('../src/executor/client');
const { buildDinnerInstallPlan } = require('../src/operations/compilers/install');
const { digestOperationPlan } = require('../src/operations/digest');

async function withExecutor(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-executor-'));
  const socketPath = path.join(root, 'executor.sock');
  const server = createExecutorServer({ logger: { info() {} } });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try { await run(socketPath); } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
}

function rawRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => resolve(JSON.parse(response)));
    socket.on('error', reject);
  });
}

test('executor hello returns a versioned, mutation-disabled capability response', async () => {
  await withExecutor(async (socketPath) => {
    const response = await hello(socketPath);
    assert.equal(response.capabilities.mutationsEnabled, false);
    assert.deepEqual(response.capabilities.protocolVersions, [1]);
    assert.ok(response.capabilities.supportedOperationTypes.includes('runtime.run-npm'));
  });
});

test('executor validates the same typed plan digest it receives without mutating', async () => {
  await withExecutor(async (socketPath) => {
    const plan = buildDinnerInstallPlan({ generatedAt: '2026-09-20T14:00:00.000Z' });
    const response = await validatePlan(socketPath, plan);
    assert.equal(response.valid, true);
    assert.equal(response.planDigest, digestOperationPlan(plan));
    assert.equal(response.mutationsEnabled, false);
  });
});

test('executor rejects malformed, extra-field, unsupported-version, and digest-mismatch requests', async () => {
  await withExecutor(async (socketPath) => {
    const malformed = await rawRequest(socketPath, '{ nope\n');
    assert.equal(malformed.code, 'INVALID_REQUEST');
    const extra = await rawRequest(socketPath, `${JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), type: 'hello', command: 'id' })}\n`);
    assert.equal(extra.code, 'INVALID_REQUEST');
    const unsupportedId = crypto.randomUUID();
    const version = await rawRequest(socketPath, `${JSON.stringify({ protocolVersion: 2, requestId: unsupportedId, type: 'hello' })}\n`);
    assert.equal(version.code, 'UNSUPPORTED_PROTOCOL');
    assert.equal(version.requestId, unsupportedId);
    const plan = buildDinnerInstallPlan({ generatedAt: '2026-09-20T14:00:00.000Z' });
    const mismatch = await rawRequest(socketPath, `${JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), type: 'validate-plan', planDigest: 'sha256:'.concat('0'.repeat(64)), plan })}\n`);
    assert.equal(mismatch.code, 'PLAN_DIGEST_MISMATCH');
  });
});

test('executor accepts exactly one request per connection and replays duplicate terminal results', async () => {
  await withExecutor(async (socketPath) => {
    const duplicateId = crypto.randomUUID();
    const first = await rawRequest(socketPath, `${JSON.stringify({ protocolVersion: 1, requestId: duplicateId, type: 'hello' })}\n`);
    const second = await rawRequest(socketPath, `${JSON.stringify({ protocolVersion: 1, requestId: duplicateId, type: 'hello' })}\n`);
    assert.deepEqual(second, first);
    const multiple = await rawRequest(socketPath, `${JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), type: 'hello' })}\n${JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), type: 'hello' })}\n`);
    assert.equal(multiple.code, 'INVALID_REQUEST');
  });
});
