const {
  runCommand,
  parseJson,
  buildTailscaleReadinessFromResults,
} = require('./tailscale-readiness');
const {
  DEFAULT_MANAGED_SERVICE_ID,
  REQUIRED_MANAGED_ENDPOINTS,
  normalizeManagedServiceId,
} = require('./tailscale-policy');

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseServeConfigFromCommandResult(serveResult = {}) {
  if (!serveResult.ok) {
    return {
      ok: false,
      config: null,
      error: String(serveResult.stderr || serveResult.stdout || 'Unable to read tailscale serve config').trim() || 'Unable to read tailscale serve config',
    };
  }
  const parsed = parseJson(serveResult.stdout || '{}');
  if (!parsed.ok) {
    return {
      ok: false,
      config: null,
      error: `Invalid JSON from tailscale serve get-config --all: ${parsed.error}`,
    };
  }
  const config = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
  return {
    ok: true,
    config: {
      version: config.version || '0.0.1',
      services: config.services && typeof config.services === 'object' ? config.services : {},
    },
    error: null,
  };
}

function detectEndpointConflicts(services = {}, desiredEndpoints = REQUIRED_MANAGED_ENDPOINTS, managedServiceId = DEFAULT_MANAGED_SERVICE_ID) {
  const conflicts = [];
  for (const [serviceId, serviceValue] of Object.entries(services || {})) {
    if (serviceId === managedServiceId) continue;
    const endpoints = serviceValue && typeof serviceValue === 'object' ? (serviceValue.endpoints || {}) : {};
    for (const [endpoint, desiredTarget] of Object.entries(desiredEndpoints)) {
      if (!Object.prototype.hasOwnProperty.call(endpoints, endpoint)) continue;
      conflicts.push({
        endpoint,
        ownerService: serviceId,
        ownerTarget: endpoints[endpoint],
        desiredService: managedServiceId,
        desiredTarget,
      });
    }
  }
  return conflicts;
}

function buildMergedServeConfig(currentConfig = {}, desiredEndpoints = REQUIRED_MANAGED_ENDPOINTS, managedServiceId = DEFAULT_MANAGED_SERVICE_ID) {
  const merged = deepClone(currentConfig || {});
  if (!merged.version) merged.version = '0.0.1';
  if (!merged.services || typeof merged.services !== 'object') merged.services = {};
  merged.services[managedServiceId] = {
    endpoints: { ...desiredEndpoints },
  };
  return merged;
}

function buildWriteConfigCommand(config) {
  const serialized = JSON.stringify(config).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return [
    "python3 - <<'PY'",
    'import json',
    `payload = json.loads('${serialized}')`,
    "path = '/tmp/homebase-serve-home.json'",
    "with open(path, 'w', encoding='utf-8') as fh:",
    "    fh.write(json.dumps(payload, indent=2) + '\\n')",
    "print(path)",
    'PY',
  ].join('\n');
}

function buildTailscalePublishPlan({
  readiness,
  serveResult,
  hostname = 'homebase',
  domain = 'tailnet',
  managedServiceId = DEFAULT_MANAGED_SERVICE_ID,
} = {}) {
  const normalizedManagedServiceId = normalizeManagedServiceId(managedServiceId);
  const publishHost = `${hostname}.${domain}`;
  const previewUrls = {
    homebase: `https://${publishHost}:3080`,
    appsBase: `https://${publishHost}`,
  };

  const parsedServe = parseServeConfigFromCommandResult(serveResult || {});
  const currentConfig = parsedServe.ok ? parsedServe.config : { version: '0.0.1', services: {} };
  const currentServices = currentConfig.services || {};
  const currentManagedEndpoints = currentServices[normalizedManagedServiceId]?.endpoints || {};
  const desiredEndpoints = { ...REQUIRED_MANAGED_ENDPOINTS };
  const conflicts = detectEndpointConflicts(currentServices, desiredEndpoints, normalizedManagedServiceId);
  const mergedConfig = buildMergedServeConfig(currentConfig, desiredEndpoints, normalizedManagedServiceId);

  const endpointDiff = Object.entries(desiredEndpoints).map(([endpoint, desired]) => ({
    endpoint,
    current: currentManagedEndpoints[endpoint] || null,
    desired,
    changed: currentManagedEndpoints[endpoint] !== desired,
  }));

  const allDesiredAlreadyPresent = endpointDiff.every((entry) => entry.changed === false);
  const canExecute = parsedServe.ok && conflicts.length === 0;
  const requiresChanges = !allDesiredAlreadyPresent;

  const executionSteps = canExecute
    ? [
      {
        id: 'snapshot-current-serve-config',
        title: 'Snapshot current tailscale serve config',
        run: ['tailscale serve get-config --all > /tmp/homebase-serve-config-before.json'],
      },
      {
        id: 'write-merged-homebase-serve-config',
        title: `Write merged config with managed ${normalizedManagedServiceId} endpoints`,
        run: [buildWriteConfigCommand(mergedConfig)],
      },
      {
        id: 'apply-merged-homebase-serve-config',
        title: 'Apply merged config via tailscale serve set-raw',
        run: ['tailscale serve set-raw < /tmp/homebase-serve-home.json'],
      },
      {
        id: 'verify-serve-config',
        title: 'Verify resulting tailscale serve config',
        run: ['tailscale serve get-config --all'],
      },
    ]
    : [];

  return {
    kind: 'tailscale-publish',
    generatedAt: new Date().toISOString(),
    policy: {
      managedServiceId: normalizedManagedServiceId,
      managedEndpoints: desiredEndpoints,
      preserveUnrelatedServices: true,
      refuseSilentOverwrite: true,
    },
    readiness: readiness?.readiness || null,
    source: {
      serveCommandOk: Boolean(serveResult?.ok),
      serveExitCode: serveResult?.exitCode ?? null,
      serveError: parsedServe.ok ? null : parsedServe.error,
    },
    current: {
      serviceCount: Object.keys(currentServices).length,
      homeServicePresent: Boolean(currentServices[normalizedManagedServiceId]),
      homeEndpoints: currentManagedEndpoints,
      tcp443Owners: Object.entries(currentServices)
        .filter(([, value]) => Object.prototype.hasOwnProperty.call((value?.endpoints || {}), 'tcp:443'))
        .map(([serviceId]) => serviceId),
    },
    conflicts,
    diff: endpointDiff,
    requiresChanges,
    canExecute,
    blockedReason: !parsedServe.ok
      ? 'serve-config-unavailable'
      : (conflicts.length ? 'endpoint-ownership-conflict' : null),
    summary: !parsedServe.ok
      ? `Cannot plan publish changes: ${parsedServe.error}`
      : (conflicts.length
        ? 'Publish plan blocked: one or more required endpoints are already owned by non-managed services.'
        : (requiresChanges
          ? `Publish plan ready: managed endpoints will be created/repaired under ${normalizedManagedServiceId}.`
          : `Publish plan ready: ${normalizedManagedServiceId} endpoints already match the required topology.`)),
    desiredHost: hostname,
    desiredDomain: domain,
    previewUrls,
    mergedConfig,
    executionSteps,
  };
}

function getTailscalePublishPlan({
  hostname = 'homebase',
  domain = 'tailnet',
  run = runCommand,
  managedServiceId = DEFAULT_MANAGED_SERVICE_ID,
} = {}) {
  const normalizedManagedServiceId = normalizeManagedServiceId(managedServiceId);
  const commandResults = {};
  commandResults.installProbe = run('command -v tailscale');
  if (!commandResults.installProbe.ok) {
    const readiness = buildTailscaleReadinessFromResults({
      commandResults,
      managedServiceId: normalizedManagedServiceId,
    });
    return buildTailscalePublishPlan({
      readiness,
      serveResult: { ok: false, exitCode: 1, stdout: '', stderr: 'tailscale command not found' },
      hostname,
      domain,
      managedServiceId: normalizedManagedServiceId,
    });
  }

  commandResults.version = run('tailscale version');
  commandResults.status = run('tailscale status --json');
  commandResults.serve = run('tailscale serve get-config --all');
  const readiness = buildTailscaleReadinessFromResults({
    commandResults,
    managedServiceId: normalizedManagedServiceId,
  });

  return buildTailscalePublishPlan({
    readiness,
    serveResult: commandResults.serve,
    hostname,
    domain,
    managedServiceId: normalizedManagedServiceId,
  });
}

module.exports = {
  HOME_SERVICE_ID: DEFAULT_MANAGED_SERVICE_ID,
  REQUIRED_HOME_ENDPOINTS: REQUIRED_MANAGED_ENDPOINTS,
  buildMergedServeConfig,
  buildTailscalePublishPlan,
  detectEndpointConflicts,
  getTailscalePublishPlan,
  parseServeConfigFromCommandResult,
};
