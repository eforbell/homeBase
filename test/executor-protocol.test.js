const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { createExecutorServer } = require('../executor/server');
const { PROTOCOL_VERSION } = require('../executor/protocol');
const { hello, hostStatus, appUpdateStatus, runAction, planAction, sendRequest } = require('../src/executor/client');
const { digestOperationPlan } = require('../src/operations/digest');

const SITE = { hostname: 'homebase', domain: 'tailnet', householdTimezone: 'America/New_York' };
const DINNER_INSTALL = { action: 'install', appId: 'family-dinner', ref: 'main', transport: 'https', site: SITE };

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
    socket.on('end', () => resolve(JSON.parse(response.trim().split('\n').at(-1))));
    socket.on('error', reject);
  });
}

function line(fields) {
  return `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(), ...fields })}\n`;
}

test('executor hello reports protocol v2 actions and stays mutation-disabled by default', async () => {
  await withExecutor(async (socketPath) => {
    const response = await hello(socketPath);
    assert.equal(PROTOCOL_VERSION, 2);
    assert.deepEqual(response.capabilities.protocolVersions, [2]);
    assert.equal(response.capabilities.mutationsEnabled, false);
    assert.deepEqual(response.capabilities.actions, ['bootstrap', 'install']);
    assert.deepEqual(response.capabilities.installableApps, ['family-dinner']);
  });
});

test('plan-action returns the executor-compiled plan without mutating', async () => {
  await withExecutor(async (socketPath) => {
    const { plan, planDigest } = await planAction(socketPath, DINNER_INSTALL);
    assert.equal(plan.target, 'family-dinner');
    assert.equal(planDigest, digestOperationPlan(plan));
    assert.equal(plan.operations.find((operation) => operation.type === 'git.sync').repository, 'https://github.com/eforbell/familyDinner.git');
    const ssh = await planAction(socketPath, { ...DINNER_INSTALL, transport: 'ssh' });
    assert.equal(ssh.plan.operations.find((operation) => operation.type === 'git.sync').repository, 'ssh://git@github.com/eforbell/familyDinner.git');
    const bootstrap = await planAction(socketPath, { action: 'bootstrap' });
    assert.equal(bootstrap.plan.kind, 'host-bootstrap');
  });
});

test('callers can no longer submit plans, operations, or secrets', async () => {
  await withExecutor(async (socketPath) => {
    const { plan } = await planAction(socketPath, DINNER_INSTALL);
    for (const type of ['execute-plan', 'validate-plan']) {
      const response = await rawRequest(socketPath, line({ type, plan, planDigest: digestOperationPlan(plan) }));
      assert.equal(response.code, 'INVALID_REQUEST', type);
    }
    const smuggled = [
      { plan },
      { secretBindings: { familyDinnerDatabasePassword: 'attacker-chosen' } },
      { operations: [] },
      { command: 'id' },
    ];
    for (const extra of smuggled) {
      const response = await rawRequest(socketPath, line({ type: 'run-action', jobId: '1', actor: { kind: 'homebase-admin-session', auditRef: 'x' }, issuedAt: new Date().toISOString(), ...DINNER_INSTALL, ...extra }));
      assert.equal(response.code, 'INVALID_REQUEST', JSON.stringify(Object.keys(extra)));
    }
  }, { runAction: async () => { throw new Error('must not run'); }, mutationsEnabled: true });
});

test('action fields are validated against the catalog and per-action shape', async () => {
  await withExecutor(async (socketPath) => {
    const bad = [
      { ...DINNER_INSTALL, action: 'uninstall' },
      { ...DINNER_INSTALL, site: { ...SITE, hostname: 'bad\nhost' } },
      { ...DINNER_INSTALL, site: { ...SITE, extra: 'x' } },
      { ...DINNER_INSTALL, site: undefined },
      { action: 'bootstrap', appId: 'family-dinner' },
      { ...DINNER_INSTALL, appId: '../../etc' },
      { ...DINNER_INSTALL, ref: '--upload-pack=/bin/sh' },
      { ...DINNER_INSTALL, transport: 'file' },
      { action: 'install', appId: 'family-dinner', ref: 'main', site: SITE },
    ];
    for (const fields of bad) {
      const response = await rawRequest(socketPath, line({ type: 'plan-action', ...fields }));
      assert.equal(response.code, 'INVALID_REQUEST', JSON.stringify(fields));
    }
    const notYet = await rawRequest(socketPath, line({ type: 'plan-action', ...DINNER_INSTALL, appId: 'helm' }));
    assert.equal(notYet.code, 'POLICY_DENIED');
  });
});

test('run-action requires a job, a bounded actor, and a fresh issuedAt', async () => {
  await withExecutor(async (socketPath) => {
    const base = { type: 'run-action', jobId: '7', actor: { kind: 'homebase-admin-session', auditRef: 'x' }, issuedAt: new Date().toISOString(), ...DINNER_INSTALL };
    const cases = [
      { ...base, jobId: 'abc' },
      { ...base, actor: { kind: 'root' , auditRef: 'x' } },
      { ...base, actor: { kind: 'homebase-admin-session', auditRef: 'x', extra: true } },
      { ...base, issuedAt: '2020-01-01T00:00:00.000Z' },
    ];
    for (const fields of cases) {
      const response = await rawRequest(socketPath, line(fields));
      assert.equal(response.code, 'INVALID_REQUEST', JSON.stringify(fields));
    }
  }, { runAction: async () => ({}), mutationsEnabled: true });
});

test('run-action hands the executor only the normalized action and streams its events', async () => {
  const received = [];
  await withExecutor(async (socketPath) => {
    const events = [];
    const result = await runAction(socketPath, { jobId: 3, ...DINNER_INSTALL }, { onEvent: (event) => events.push(event) });
    assert.deepEqual(received, [DINNER_INSTALL]);
    assert.deepEqual(events.map((event) => event.eventType), ['plan.accepted', 'operation.started']);
    assert.ok(events.every((event) => event.protocolVersion === PROTOCOL_VERSION));
    assert.equal(events[0].jobId, '3');
    assert.equal(result.planDigest, 'sha256:x');
  }, {
    mutationsEnabled: true,
    runAction: async (spec, { emit }) => {
      received.push(spec);
      emit({ eventType: 'plan.accepted', planDigest: 'sha256:x' });
      emit({ eventType: 'operation.started', operationId: 'ensure-sovereign-root' });
      return { planDigest: 'sha256:x', completedOperationIds: ['ensure-sovereign-root'] };
    },
  });
});

test('run-action is disabled without an explicit trusted dispatcher and serializes with other mutations', async () => {
  await withExecutor(async (socketPath) => {
    await assert.rejects(() => runAction(socketPath, { jobId: 1, ...DINNER_INSTALL }), (error) => error.code === 'POLICY_DENIED');
  });
  let release;
  await withExecutor(async (socketPath) => {
    const first = runAction(socketPath, { jobId: 1, action: 'bootstrap' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(() => runAction(socketPath, { jobId: 2, action: 'bootstrap' }), (error) => error.code === 'EXECUTOR_BUSY');
    await assert.rejects(() => appUpdateStatus(socketPath, { appId: 'family-dinner', transport: 'https', ref: 'main' }), (error) => error.code === 'EXECUTOR_BUSY');
    release();
    await first;
  }, {
    mutationsEnabled: true,
    checkAppUpdateStatus: async () => ({}),
    runAction: () => new Promise((resolve) => { release = () => resolve({ completedOperationIds: [] }); }),
  });
});

test('executor rejects malformed, extra-field, and unsupported-version requests', async () => {
  await withExecutor(async (socketPath) => {
    const malformed = await rawRequest(socketPath, '{ nope\n');
    assert.equal(malformed.code, 'INVALID_REQUEST');
    const extra = await rawRequest(socketPath, line({ type: 'hello', command: 'id' }));
    assert.equal(extra.code, 'INVALID_REQUEST');
    const unsupportedId = crypto.randomUUID();
    const version = await rawRequest(socketPath, `${JSON.stringify({ protocolVersion: 1, requestId: unsupportedId, type: 'hello' })}\n`);
    assert.equal(version.code, 'UNSUPPORTED_PROTOCOL');
    assert.equal(version.requestId, unsupportedId);
  });
});

test('executor accepts exactly one request per connection and replays duplicate terminal results', async () => {
  await withExecutor(async (socketPath) => {
    const duplicateId = crypto.randomUUID();
    const payload = `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId: duplicateId, type: 'hello' })}\n`;
    const first = await rawRequest(socketPath, payload);
    const second = await rawRequest(socketPath, payload);
    assert.deepEqual(second, first);
    const multiple = await rawRequest(socketPath, `${line({ type: 'hello' })}${line({ type: 'hello' })}`);
    assert.equal(multiple.code, 'INVALID_REQUEST');
  });
});

test('explicitly enabled executor reports mutation capability and deploy-key state', async () => {
  await withExecutor(async (socketPath) => {
    const response = await hello(socketPath);
    assert.equal(response.capabilities.mutationsEnabled, true);
    assert.equal(response.capabilities.gitDeployKey, 'present');
    assert.ok(response.capabilities.supportedOperationTypes.includes('nginx.ensure-gateway'));
  }, { mutationsEnabled: true, probeDeployKey: () => 'present', runAction: async () => ({ completedOperationIds: [] }) });
});

test('accepted actions outlive the pre-acceptance deadline and stream events before completion', async () => {
  let releasePlan;
  const eventsBeforeCompletion = [];
  let completedAt = null;
  await withExecutor(async (socketPath) => {
    const result = await runAction(socketPath, { jobId: 1, ...DINNER_INSTALL }, {
      timeoutMs: 5000,
      onEvent: (event) => {
        if (completedAt === null) eventsBeforeCompletion.push(event.eventType);
        // Stay silent well past the 50ms pre-acceptance deadline, like a long apt-get install.
        setTimeout(() => releasePlan(), 200);
      },
    });
    completedAt = Date.now();
    assert.deepEqual(result.completedOperationIds, ['ensure-sovereign-root']);
  }, {
    requestTimeoutMs: 50,
    mutationsEnabled: true,
    runAction: async (spec, { emit }) => {
      emit({ eventType: 'operation.started', operationId: 'ensure-sovereign-root' });
      await new Promise((resolve) => { releasePlan = resolve; });
      return { completedOperationIds: ['ensure-sovereign-root'] };
    },
  });
  assert.deepEqual(eventsBeforeCompletion, ['operation.started']);
});

test('host-status is a fixed, argument-free read request', async () => {
  await withExecutor(async (socketPath) => {
    const status = await hostStatus(socketPath);
    assert.equal(status.checks['nginx-config'].ok, true);
    await assert.rejects(() => sendRequest(socketPath, { protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(), type: 'host-status', path: '/etc/shadow' }), (error) => error.code === 'INVALID_REQUEST');
  }, { collectHostStatus: async () => ({ checks: { 'nginx-config': { ok: true } } }) });
  await withExecutor(async (socketPath) => {
    await assert.rejects(() => hostStatus(socketPath), (error) => error.code === 'POLICY_DENIED');
  });
});

test('app-update-status accepts only a catalog app, a transport enum, and main or a SHA', async () => {
  const seen = [];
  await withExecutor(async (socketPath) => {
    const status = await appUpdateStatus(socketPath, { appId: 'family-dinner', transport: 'https', ref: 'main' });
    assert.equal(status.behindCount, 2);
    assert.deepEqual(seen, [{ appId: 'family-dinner', transport: 'https', ref: 'main' }]);
    const bad = [
      { appId: '../../etc', transport: 'https', ref: 'main' },
      { appId: 'family-dinner', transport: 'file', ref: 'main' },
      { appId: 'family-dinner', transport: 'https', ref: '--upload-pack=/bin/sh' },
    ];
    for (const fields of bad) {
      await assert.rejects(() => appUpdateStatus(socketPath, fields), (error) => error.code === 'INVALID_REQUEST');
    }
    await assert.rejects(() => sendRequest(socketPath, { protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(), type: 'app-update-status', appId: 'family-dinner', transport: 'https', ref: 'main', path: '/tmp' }), (error) => error.code === 'INVALID_REQUEST');
    assert.equal(seen.length, 1);
  }, { checkAppUpdateStatus: async (fields) => { seen.push(fields); return { behindCount: 2 }; } });
});

test('an oversized response still produces a terminal error line instead of hanging', async () => {
  await withExecutor(async (socketPath) => {
    await assert.rejects(() => planAction(socketPath, DINNER_INSTALL, { timeoutMs: 3000 }), (error) => error.code === 'RESPONSE_TOO_LARGE');
  }, { planAction: () => ({ blob: 'x'.repeat(70 * 1024) }) });
});
