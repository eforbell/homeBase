const test = require('node:test');
const assert = require('node:assert/strict');
const { HealthMonitor, evaluateRuntimeState, buildAppHealthRecord, joinExternalUrlPath } = require('../src/services/health-monitor');

test('evaluateRuntimeState marks service-down when service probe fails', () => {
  const runtime = evaluateRuntimeState({
    install: { status: 'installed' },
    healthConfig: { livenessPath: '/api/health' },
    serviceProbe: { state: 'inactive', ok: false, message: 'Service inactive' },
    livenessProbe: { status: 'unknown', ok: false },
    readinessProbe: { status: 'unknown', ok: false },
  });

  assert.equal(runtime.runtimeStatus, 'service-down');
  assert.equal(runtime.severity, 'critical');
});

test('evaluateRuntimeState marks needs-setup when onboarding is incomplete', () => {
  const runtime = evaluateRuntimeState({
    install: { status: 'installed' },
    healthConfig: { livenessPath: '/api/health' },
    serviceProbe: { state: 'active', ok: true, message: 'Service active' },
    livenessProbe: { status: 'ok', ok: true },
    readinessProbe: { status: 'ok', ok: true },
    onboarding: { status: 'needs-setup', ok: false, message: 'Setup still required' },
  });

  assert.equal(runtime.runtimeStatus, 'needs-setup');
  assert.equal(runtime.severity, 'warning');
});

test('evaluateRuntimeState prioritizes needs-setup over readiness-failing', () => {
  const runtime = evaluateRuntimeState({
    install: { status: 'installed' },
    healthConfig: { readinessPath: '/api/ready' },
    serviceProbe: { state: 'active', ok: true, message: 'Service active' },
    livenessProbe: { status: 'ok', ok: true },
    readinessProbe: { status: 'failed', ok: false },
    onboarding: { status: 'needs-setup', ok: false, message: 'Setup still required' },
  });

  assert.equal(runtime.runtimeStatus, 'needs-setup');
});

test('health monitor caches snapshots by installation key', async () => {
  let serviceProbeCalls = 0;
  let httpProbeCalls = 0;
  let currentNow = Date.UTC(2026, 3, 18, 12, 0, 0);

  const monitor = new HealthMonitor({
    catalogById: new Map([[
      'family-help',
      {
        network: {
          health: {
            livenessPath: '/api/health',
            readinessPath: '/api/ready',
          },
        },
      },
    ]]),
    ttlMs: 30_000,
    now: () => currentNow,
    probeServiceState: () => {
      serviceProbeCalls += 1;
      return { state: 'active', ok: true, message: 'Service active' };
    },
    probeHttp: async () => {
      httpProbeCalls += 1;
      return { status: 'ok', ok: true, statusCode: 200, message: 'HTTP 200' };
    },
  });

  const installations = [{
    appId: 'family-help',
    status: 'installed',
    serviceName: 'family-help',
    port: 3002,
    updatedAt: '2026-04-18T12:00:00.000Z',
  }];

  const first = await monitor.getAppHealthSnapshot(installations);
  const second = await monitor.getAppHealthSnapshot(installations);

  assert.equal(first.apps[0].runtimeStatus, 'healthy');
  assert.equal(second.apps[0].runtimeStatus, 'healthy');
  assert.equal(serviceProbeCalls, 1);
  assert.equal(httpProbeCalls, 2);

  currentNow += 31_000;
  await monitor.getAppHealthSnapshot(installations);
  assert.equal(serviceProbeCalls, 2);
});

test('joinExternalUrlPath always inserts one slash between base and path', () => {
  assert.equal(joinExternalUrlPath('https://app.test', 'setup'), 'https://app.test/setup');
  assert.equal(joinExternalUrlPath('https://app.test/', '/setup'), 'https://app.test/setup');
});

test('buildAppHealthRecord derives onboarding setupUrl from externalUrl and setupPath', async () => {
  const record = await buildAppHealthRecord({
    install: {
      appId: 'family-help',
      status: 'installed',
      serviceName: 'family-help',
      port: 3002,
      externalUrl: 'https://test.example.ts.net/help',
    },
    catalogEntry: {
      network: {
        health: {
          livenessPath: '/api/health',
          readinessPath: '/api/ready',
        },
      },
      onboarding: {
        statusPath: '/api/bootstrap',
        setupPath: 'setup',
        readyWhen: 'household_initialized',
      },
    },
    probeServiceState: () => ({ state: 'active', ok: true, message: 'Service active' }),
    probeHttp: async () => ({ status: 'ok', ok: true, statusCode: 200, message: 'HTTP 200' }),
    probeHttpJson: async () => ({ status: 'ok', ok: true, payload: { household_initialized: false } }),
    nowIso: '2026-04-18T12:00:00.000Z',
  });

  assert.equal(record.onboarding.status, 'needs-setup');
  assert.equal(record.onboarding.setupUrl, 'https://test.example.ts.net/help/setup');
});
