const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { createExecutorServer } = require('../executor/server');
const { hello, validatePlan, executePlan } = require('../src/executor/client');
const { buildDinnerInstallPlan } = require('../src/operations/compilers/install');
const { digestOperationPlan } = require('../src/operations/digest');

async function withExecutor(run, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-executor-'));
  const socketPath = path.join(root, 'executor.sock');
  const server = createExecutorServer({ logger: { info() {} }, ...options });
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


test('executor serializes typed execute requests and streams only redacted structured events', async () => {
  await withExecutor(async (socketPath) => {
    const plan = buildDinnerInstallPlan({ generatedAt: '2026-09-20T14:00:00.000Z' });
    const result = await executePlan(socketPath, { jobId: 1, plan, secretBindings: { familyDinnerDatabasePassword: 'canary-secret' } });
    assert.deepEqual(result.completedOperationIds, [plan.operations[0].id]);
  }, {
    executePlan: async (request, { emit }) => {
      emit({ eventType: 'operation.started', operationId: request.plan.operations[0].id });
      return { completedOperationIds: [request.plan.operations[0].id] };
    },
  });
});

test('executor keeps execute-plan disabled without an explicit trusted dispatcher', async () => {
  await withExecutor(async (socketPath) => {
    const plan = buildDinnerInstallPlan({ generatedAt: '2026-09-20T14:00:00.000Z' });
    await assert.rejects(() => executePlan(socketPath, { jobId: 1, plan, secretBindings: { familyDinnerDatabasePassword: 'canary-secret' } }), (error) => error.code === 'POLICY_DENIED');
  });
});


test('explicitly enabled executor reports mutation capability while default remains safe', async () => {
  await withExecutor(async (socketPath) => {
    const response = await hello(socketPath);
    assert.equal(response.capabilities.mutationsEnabled, true);
    assert.equal(response.capabilities.gitDeployKey, 'present');
    assert.ok(response.capabilities.supportedOperationTypes.includes('nginx.ensure-gateway'));
  }, { mutationsEnabled: true, probeDeployKey: () => 'present', executePlan: async () => ({ completedOperationIds: [] }) });
});

test('accepted plans outlive the pre-acceptance idle deadline and stream events before completion', async () => {
  let releasePlan;
  const eventsBeforeCompletion = [];
  let completedAt = null;
  await withExecutor(async (socketPath) => {
    const plan = buildDinnerInstallPlan({ generatedAt: '2026-09-20T14:00:00.000Z' });
    const result = await executePlan(socketPath, { jobId: 1, plan, secretBindings: { familyDinnerDatabasePassword: 'canary-secret' } }, {
      timeoutMs: 5000,
      onEvent: (event) => {
        if (completedAt === null) eventsBeforeCompletion.push(event.eventType);
        // Stay silent well past the 50ms pre-acceptance deadline, like a long apt-get install.
        setTimeout(() => releasePlan(), 200);
      },
    });
    completedAt = Date.now();
    assert.deepEqual(result.completedOperationIds, [plan.operations[0].id]);
  }, {
    requestTimeoutMs: 50,
    executePlan: async (request, { emit }) => {
      emit({ eventType: 'operation.started', operationId: request.plan.operations[0].id });
      await new Promise((resolve) => { releasePlan = resolve; });
      return { completedOperationIds: [request.plan.operations[0].id] };
    },
  });
  assert.deepEqual(eventsBeforeCompletion, ['operation.started']);
});
