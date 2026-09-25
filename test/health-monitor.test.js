const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HealthMonitor,
  evaluateRuntimeState,
  buildAppHealthRecord,
  joinExternalUrlPath,
  readOnboardingReadyValue,
  defaultProbeUnits,
  isSafeSystemdUnitName,
  listHelperUnits,
  parseSystemctlShow,
} = require('../src/services/health-monitor');

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

test('evaluateRuntimeState marks helper-failing when helper units fail', () => {
  const runtime = evaluateRuntimeState({
    install: { status: 'installed' },
    healthConfig: { readinessPath: '/api/ready' },
    serviceProbe: { state: 'active', ok: true, message: 'Service active' },
    livenessProbe: { status: 'ok', ok: true },
    readinessProbe: { status: 'ok', ok: true },
    onboarding: { status: 'ready', ok: true, message: 'Onboarding complete' },
    helperUnits: [
      { unitName: 'family-pulse-notifications.timer', state: 'active', ok: true, message: 'Service active' },
      { unitName: 'family-pulse-notifications.service', state: 'failed', ok: false, message: 'Unit is in failed state' },
    ],
  });

  assert.equal(runtime.runtimeStatus, 'helper-failing');
  assert.equal(runtime.severity, 'warning');
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

test('readOnboardingReadyValue supports fallback to bootstrap.ready', () => {
  assert.equal(readOnboardingReadyValue({ household_initialized: true }, 'household_initialized'), true);
  assert.equal(readOnboardingReadyValue({ bootstrap: { ready: true } }, 'household_initialized'), true);
  assert.equal(readOnboardingReadyValue({ bootstrap: { ready: false } }, 'household_initialized'), false);
  assert.equal(readOnboardingReadyValue({}, 'household_initialized'), null);
});

test('buildAppHealthRecord uses bootstrap.ready when readyWhen key is missing', async () => {
  const record = await buildAppHealthRecord({
    install: {
      appId: 'family-dinner',
      status: 'installed',
      serviceName: 'family-dinner',
      port: 3000,
      externalUrl: 'https://test.example.ts.net/dinner',
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
        setupPath: '/setup',
        readyWhen: 'household_initialized',
      },
    },
    probeServiceState: () => ({ state: 'active', ok: true, message: 'Service active' }),
    probeHttp: async () => ({ status: 'ok', ok: true, statusCode: 200, message: 'HTTP 200' }),
    probeHttpJson: async () => ({ status: 'ok', ok: true, payload: { bootstrap: { ready: true } } }),
    nowIso: '2026-04-18T12:00:00.000Z',
  });

  assert.equal(record.onboarding.status, 'ready');
  assert.equal(record.runtimeStatus, 'healthy');
});

function familyPulseInstall(overrides = {}) {
  return {
    appId: 'family-pulse',
    status: 'installed',
    serviceName: 'family-pulse',
    port: 3003,
    externalUrl: 'https://test.example.ts.net/pulse',
    ...overrides,
  };
}

const familyPulseEntry = {
  network: { health: { livenessPath: '/api/health', readinessPath: '/api/health' } },
  sidecars: [{ name: 'family-pulse-mcp', description: 'Family Pulse MCP Server' }],
  timers: [
    {
      serviceName: 'family-pulse-notifications',
      description: 'Family Pulse notification runner',
      timerName: 'family-pulse-notifications.timer',
    },
  ],
};

function helperRecord({ install = familyPulseInstall(), units, probeUnits } = {}) {
  return buildAppHealthRecord({
    install,
    catalogEntry: familyPulseEntry,
    probeServiceState: () => ({ state: 'active', ok: true, message: 'Service active' }),
    probeUnits: probeUnits || (() => new Map(Object.entries(units))),
    probeHttp: async () => ({ status: 'ok', ok: true, statusCode: 200, message: 'HTTP 200' }),
    probeHttpJson: async () => ({ status: 'unknown', ok: false, payload: null }),
    nowIso: '2026-04-30T20:00:00.000Z',
  });
}

const allUnitsHealthy = {
  'family-pulse-mcp.service': { loadState: 'loaded', activeState: 'active' },
  'family-pulse-notifications.timer': { loadState: 'loaded', activeState: 'active' },
  'family-pulse-notifications.service': { loadState: 'loaded', activeState: 'inactive' },
};

test('buildAppHealthRecord captures helper timer and sidecar states in one probe', async () => {
  const probedBatches = [];
  const record = await helperRecord({
    probeUnits: (names) => {
      probedBatches.push(names);
      return new Map(Object.entries({
        ...allUnitsHealthy,
        'family-pulse-notifications.service': { loadState: 'loaded', activeState: 'failed' },
      }));
    },
  });

  assert.deepEqual(probedBatches, [[
    'family-pulse-mcp.service',
    'family-pulse-notifications.timer',
    'family-pulse-notifications.service',
  ]]);
  assert.equal(record.runtimeStatus, 'helper-failing');
  assert.equal(record.helperUnits.length, 3);
  const failed = record.helperUnits.find((unit) => unit.unitName === 'family-pulse-notifications.service');
  assert.equal(failed.ok, false);
  assert.match(record.recoveryHint, /family-pulse-notifications\.service/);
});

test('helper units are healthy when timers wait and oneshot runs are inactive', async () => {
  const record = await helperRecord({ units: allUnitsHealthy });
  assert.equal(record.runtimeStatus, 'healthy');
  assert.equal(record.helperUnits.every((unit) => unit.ok === true), true);
});

test('an inactive sidecar or stopped timer marks helper-failing', async () => {
  const record = await helperRecord({
    units: { ...allUnitsHealthy, 'family-pulse-notifications.timer': { loadState: 'loaded', activeState: 'inactive' } },
  });
  assert.equal(record.runtimeStatus, 'helper-failing');
});

test('catalog helpers the install never created are not-deployed, not failing', async () => {
  const record = await helperRecord({
    units: { ...allUnitsHealthy, 'family-pulse-mcp.service': { loadState: 'not-found', activeState: 'inactive' } },
  });
  const sidecar = record.helperUnits.find((unit) => unit.kind === 'sidecar-service');
  assert.equal(sidecar.state, 'not-deployed');
  assert.equal(sidecar.ok, null);
  assert.equal(record.runtimeStatus, 'healthy');
});

test('unprobeable helper units are unknown and neutral', async () => {
  const record = await helperRecord({ probeUnits: () => new Map() });
  assert.equal(record.helperUnits.every((unit) => unit.state === 'unknown' && unit.ok === null), true);
  assert.equal(record.runtimeStatus, 'healthy');
});

test('helper units are not probed for installs that are not installed', async () => {
  let probed = false;
  const record = await helperRecord({
    install: familyPulseInstall({ status: 'planned' }),
    probeUnits: () => { probed = true; return new Map(); },
  });
  assert.equal(probed, false);
  assert.deepEqual(record.helperUnits, []);
});

test('primary runtime failures outrank helper-failing', () => {
  const failingHelper = [{ unitName: 'x.service', ok: false }];
  const base = {
    install: { status: 'installed' },
    healthConfig: { livenessPath: '/api/health', readinessPath: '/api/ready' },
    serviceProbe: { state: 'active', ok: true },
    livenessProbe: { status: 'ok', ok: true },
    readinessProbe: { status: 'ok', ok: true },
    onboarding: { status: 'ready', ok: true },
    helperUnits: failingHelper,
  };
  assert.equal(evaluateRuntimeState({ ...base, serviceProbe: { state: 'inactive', ok: false } }).runtimeStatus, 'service-down');
  assert.equal(evaluateRuntimeState({ ...base, readinessProbe: { status: 'failed', ok: false } }).runtimeStatus, 'readiness-failing');
  assert.equal(evaluateRuntimeState({ ...base, onboarding: { status: 'needs-setup', ok: false } }).runtimeStatus, 'needs-setup');
  assert.equal(evaluateRuntimeState({ ...base, livenessProbe: { status: 'failed', ok: false } }).runtimeStatus, 'http-failing');
});

test('listHelperUnits derives the timer unit from serviceName and handles a missing catalog entry', () => {
  assert.deepEqual(listHelperUnits(null), []);
  const units = listHelperUnits({ timers: [{ serviceName: 'app-sync' }] });
  assert.deepEqual(units.map((unit) => unit.unitName), ['app-sync.timer', 'app-sync.service']);
});

test('isSafeSystemdUnitName rejects option-like and shell-unsafe names', () => {
  assert.equal(isSafeSystemdUnitName('family-pulse-notifications.timer'), true);
  assert.equal(isSafeSystemdUnitName('getty@tty1.service'), true);
  for (const bad of ['-Hevil', '--help', '.hidden', 'a;b', 'a b', '$(x)', 'a`b`', '']) {
    assert.equal(isSafeSystemdUnitName(bad), false, bad);
  }
  assert.equal(defaultProbeUnits(['-Hevil']).size, 0);
});

test('parseSystemctlShow keys blocks by requested name in argument order', () => {
  // Real erebor output shape: an alias argument prints its target's block in place.
  const stdout = 'LoadState=loaded\nActiveState=active\n\nLoadState=not-found\nActiveState=inactive\n\nLoadState=loaded\nActiveState=failed\n';
  const states = parseSystemctlShow(stdout, ['app-mcp-alias', 'gone.service', 'app-sync.service']);
  assert.deepEqual(states.get('app-mcp-alias'), { loadState: 'loaded', activeState: 'active' });
  assert.deepEqual(states.get('gone.service'), { loadState: 'not-found', activeState: 'inactive' });
  assert.deepEqual(states.get('app-sync.service'), { loadState: 'loaded', activeState: 'failed' });
});

test('parseSystemctlShow returns nothing when block count does not match', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(parseSystemctlShow('LoadState=loaded\nActiveState=active\n', ['a.service', 'b.service']).size, 0);
  } finally {
    console.warn = warn;
  }
});

test('masked and transitional helper units are neutral', async () => {
  const record = await helperRecord({
    units: {
      ...allUnitsHealthy,
      'family-pulse-mcp.service': { loadState: 'loaded', activeState: 'activating' },
      'family-pulse-notifications.timer': { loadState: 'masked', activeState: 'inactive' },
    },
  });
  const byName = Object.fromEntries(record.helperUnits.map((unit) => [unit.unitName, unit]));
  assert.equal(byName['family-pulse-mcp.service'].ok, null);
  assert.equal(byName['family-pulse-notifications.timer'].state, 'masked');
  assert.equal(record.runtimeStatus, 'healthy');
});
