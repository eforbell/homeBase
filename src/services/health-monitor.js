const { spawnSync } = require('child_process');
const http = require('http');
const https = require('https');

function asTrimmedString(value, fallback = '') {
  const next = String(value == null ? '' : value).trim();
  return next || fallback;
}

// First character excludes '-' and '.' so a name can never be parsed as a systemctl option.
function isSafeSystemdUnitName(value) {
  return /^[A-Za-z0-9@_][A-Za-z0-9@%:_.-]*$/.test(String(value || ''));
}

function statusFromHttpCode(statusCode) {
  if (!Number.isFinite(statusCode)) return 'unknown';
  return statusCode >= 200 && statusCode < 400 ? 'ok' : 'failed';
}

function defaultProbeServiceState(serviceName) {
  const safeName = asTrimmedString(serviceName);
  if (!safeName || !isSafeSystemdUnitName(safeName)) {
    return {
      state: 'unknown',
      ok: false,
      message: 'Invalid or missing service name',
    };
  }

  const cmd = `command -v systemctl >/dev/null 2>&1 && systemctl is-active ${safeName} || true`;
  const result = spawnSync('/bin/bash', ['-lc', cmd], {
    encoding: 'utf8',
    timeout: 3000,
  });
  const state = asTrimmedString(result.stdout, 'unknown');
  const ok = state === 'active';
  const message = ok ? 'Service active' : (state === 'unknown' ? 'Service state unavailable' : `Service ${state}`);

  return {
    state,
    ok,
    message,
  };
}

const UNIT_TYPE_SUFFIX = /\.(service|timer|socket|target|path|mount|slice|scope)$/;

// Returns Map<unitName, { loadState, activeState }> from one `systemctl show` call.
// Units missing from the map could not be probed (no systemctl, timeout, bad name).
function defaultProbeUnits(unitNames) {
  const names = (unitNames || []).map((name) => asTrimmedString(name)).filter(isSafeSystemdUnitName);
  const states = new Map();
  if (!names.length) return states;

  const result = spawnSync('systemctl', ['show', '--property=LoadState,ActiveState', '--', ...names], {
    encoding: 'utf8',
    timeout: 3000,
  });
  if (result.error || result.status !== 0) {
    console.warn(`[health] systemctl show failed for helper units: ${result.error?.message || `exit ${result.status}`}`);
    return states;
  }
  return parseSystemctlShow(result.stdout, names);
}

// systemctl prints one blank-line-separated block per argument, in argument order,
// so blocks are keyed by the requested name (aliases resolve under the catalog name).
function parseSystemctlShow(stdout, names) {
  const states = new Map();
  const blocks = String(stdout || '').trim().split(/\n\s*\n/);
  if (blocks.length !== names.length) {
    console.warn(`[health] systemctl show returned ${blocks.length} blocks for ${names.length} units; helper states unknown`);
    return states;
  }
  blocks.forEach((block, index) => {
    const props = {};
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    if (props.LoadState && props.ActiveState) {
      states.set(names[index], { loadState: props.LoadState, activeState: props.ActiveState });
    }
  });
  return states;
}

function requestWithTimeout(url, { timeoutMs = 2500, parseJson = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    function done(payload) {
      if (settled) return;
      settled = true;
      resolve(payload);
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      done({
        status: 'unknown',
        ok: false,
        message: 'Invalid health URL',
      });
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const chunks = [];
    const req = lib.request(parsed, { method: 'GET' }, (res) => {
      const statusCode = Number(res.statusCode || 0);
      if (parseJson) {
        res.on('data', (chunk) => chunks.push(chunk));
      } else {
        res.resume();
      }
      res.on('end', () => {
        let payload = null;
        if (parseJson && chunks.length) {
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (_error) {
            payload = null;
          }
        }
        done({
          status: statusFromHttpCode(statusCode),
          ok: statusCode >= 200 && statusCode < 400,
          statusCode,
          message: statusCode >= 200 && statusCode < 400 ? `HTTP ${statusCode}` : `HTTP ${statusCode}`,
          payload,
        });
      });
    });

    req.on('error', (error) => {
      done({
        status: 'failed',
        ok: false,
        message: error.message || 'HTTP probe failed',
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

async function defaultProbeHttp(url) {
  return requestWithTimeout(url, { timeoutMs: 2500 });
}

async function defaultProbeHttpJson(url) {
  return requestWithTimeout(url, { timeoutMs: 2500, parseJson: true });
}

function toProbeUrl({ install, path }) {
  if (!install || !install.port || !path) return null;
  const normalized = String(path).startsWith('/') ? String(path) : `/${path}`;
  return `http://127.0.0.1:${String(install.port)}${normalized}`;
}

function joinExternalUrlPath(externalUrl, pathPart) {
  if (!externalUrl) return null;
  const base = String(externalUrl).replace(/\/+$/, '');
  const path = String(pathPart || '').trim();
  if (!path) return `${base}/`;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function readOnboardingReadyValue(payload, readyWhen) {
  if (!payload || typeof payload !== 'object') return null;
  const key = String(readyWhen || '').trim();
  if (key && Object.prototype.hasOwnProperty.call(payload, key)) {
    return Boolean(payload[key]);
  }
  if (payload.bootstrap && typeof payload.bootstrap === 'object' && typeof payload.bootstrap.ready === 'boolean') {
    return payload.bootstrap.ready;
  }
  if (typeof payload.ready === 'boolean') {
    return payload.ready;
  }
  return null;
}

function listHelperUnits(catalogEntry) {
  const sidecars = Array.isArray(catalogEntry?.sidecars) ? catalogEntry.sidecars : [];
  const timers = Array.isArray(catalogEntry?.timers) ? catalogEntry.timers : [];
  const units = [];

  for (const sidecar of sidecars) {
    const name = asTrimmedString(sidecar?.name);
    if (!name) continue;
    units.push({
      kind: 'sidecar-service',
      unitName: UNIT_TYPE_SUFFIX.test(name) ? name : `${name}.service`,
      label: sidecar?.description || name,
    });
  }

  for (const timer of timers) {
    const timerUnitName = asTrimmedString(timer?.timerName || (timer?.serviceName ? `${timer.serviceName}.timer` : ''));
    if (timerUnitName) {
      units.push({
        kind: 'timer-unit',
        unitName: timerUnitName,
        label: timer?.description ? `${timer.description} schedule` : timerUnitName,
      });
    }
    const serviceName = asTrimmedString(timer?.serviceName);
    if (serviceName) {
      units.push({
        kind: 'timer-service-result',
        unitName: `${serviceName}.service`,
        label: timer?.description ? `${timer.description} last run` : `${serviceName}.service`,
      });
    }
  }

  return units;
}

// Brief states during a start/restart/reload; not a verdict either way.
const TRANSITIONAL_STATES = new Set(['activating', 'deactivating', 'reloading']);

// ok: true = healthy, false = failing (drives helper-failing), null = no verdict
// (state unavailable, or the catalog names a unit this install never created).
function classifyHelperUnit(unit, probed) {
  if (!probed) {
    return { ...unit, state: 'unknown', ok: null, message: 'Unit state unavailable' };
  }
  if (probed.loadState === 'not-found') {
    return { ...unit, state: 'not-deployed', ok: null, message: 'Unit not installed yet; update or reinstall the app to create it' };
  }
  if (probed.loadState === 'masked') {
    return { ...unit, state: 'masked', ok: null, message: 'Unit masked by an operator' };
  }
  const state = probed.activeState;
  if (TRANSITIONAL_STATES.has(state)) {
    return { ...unit, state, ok: null, message: `Unit ${state}` };
  }
  if (unit.kind === 'timer-service-result') {
    return state === 'failed'
      ? { ...unit, state, ok: false, message: `Last run failed; see journalctl -u ${unit.unitName}` }
      : { ...unit, state, ok: true, message: 'No failed run reported' };
  }
  return state === 'active'
    ? { ...unit, state, ok: true, message: 'Active' }
    : { ...unit, state, ok: false, message: `Unit ${state}; see journalctl -u ${unit.unitName}` };
}

function buildHelperUnitProbes({ catalogEntry, probeUnits }) {
  const units = listHelperUnits(catalogEntry);
  if (!units.length) return [];
  const probed = probeUnits(units.map((unit) => unit.unitName)) || new Map();
  return units.map((unit) => classifyHelperUnit(unit, probed.get(unit.unitName)));
}

function evaluateRuntimeState({ install, healthConfig, serviceProbe, livenessProbe, readinessProbe, onboarding, helperUnits }) {
  const deploymentStatus = asTrimmedString(install?.status, 'unknown');
  const service = serviceProbe || { state: 'unknown', ok: false, message: 'Service probe unavailable' };
  const liveness = livenessProbe || { status: 'unknown', ok: false, message: 'No liveness probe configured' };
  const readiness = readinessProbe || { status: 'unknown', ok: false, message: 'No readiness probe configured' };
  const onboardingState = onboarding || { status: 'unknown', ok: false, message: 'No onboarding status configured', setupUrl: null };
  const helperUnitStates = Array.isArray(helperUnits) ? helperUnits : [];

  if (deploymentStatus !== 'installed') {
    return {
      runtimeStatus: 'not-installed',
      severity: 'info',
      recoveryHint: 'Install this app to enable runtime health checks.',
      service,
      liveness,
      readiness,
      onboarding: onboardingState,
      helperUnits: helperUnitStates,
    };
  }

  if (!service.ok) {
    return {
      runtimeStatus: 'service-down',
      severity: 'critical',
      recoveryHint: 'Service is not active. Open app detail or inspect jobs/logs to recover.',
      service,
      liveness,
      readiness,
      onboarding: onboardingState,
      helperUnits: helperUnitStates,
    };
  }

  if (onboardingState.status === 'needs-setup') {
    return {
      runtimeStatus: 'needs-setup',
      severity: 'warning',
      recoveryHint: 'App is installed and running, but setup is incomplete. Open Setup to finish onboarding.',
      service,
      liveness,
      readiness,
      onboarding: onboardingState,
      helperUnits: helperUnitStates,
    };
  }

  if (healthConfig && readiness.status !== 'unknown' && !readiness.ok) {
    return {
      runtimeStatus: 'readiness-failing',
      severity: 'high',
      recoveryHint: 'Service is running but readiness is failing. Open app detail for next-step actions.',
      service,
      liveness,
      readiness,
      onboarding: onboardingState,
      helperUnits: helperUnitStates,
    };
  }

  if (healthConfig && liveness.status !== 'unknown' && !liveness.ok) {
    return {
      runtimeStatus: 'http-failing',
      severity: 'high',
      recoveryHint: 'HTTP liveness check failed. Open app detail and review recent jobs.',
      service,
      liveness,
      readiness,
      onboarding: onboardingState,
      helperUnits: helperUnitStates,
    };
  }

  const failingHelpers = helperUnitStates.filter((unit) => unit && unit.ok === false);
  if (failingHelpers.length) {
    return {
      runtimeStatus: 'helper-failing',
      severity: 'warning',
      recoveryHint: `Helper unit failing: ${failingHelpers.map((unit) => unit.unitName).join(', ')}. Check journalctl for the unit. A failed timer run stays flagged until its next successful run or \`systemctl reset-failed\`.`,
      service,
      liveness,
      readiness,
      onboarding: onboardingState,
      helperUnits: helperUnitStates,
    };
  }

  if (!healthConfig) {
    return {
      runtimeStatus: 'service-active',
      severity: 'info',
      recoveryHint: 'Service is active. Add health metadata for HTTP probe coverage.',
      service,
      liveness,
      readiness,
      onboarding: onboardingState,
      helperUnits: helperUnitStates,
    };
  }

  return {
    runtimeStatus: 'healthy',
    severity: 'ok',
    recoveryHint: 'Runtime checks are passing.',
    service,
    liveness,
    readiness,
    onboarding: onboardingState,
    helperUnits: helperUnitStates,
  };
}

async function buildAppHealthRecord({ install, catalogEntry, probeServiceState, probeUnits = defaultProbeUnits, probeHttp, probeHttpJson = defaultProbeHttpJson, nowIso }) {
  const healthConfig = catalogEntry?.network?.health || null;
  const serviceProbe = probeServiceState(install?.serviceName);
  const onboardingConfig = catalogEntry?.onboarding || null;
  const setupPath = String(onboardingConfig?.setupPath || '/setup');
  const setupUrl = joinExternalUrlPath(install?.externalUrl, setupPath);

  let livenessProbe = { status: 'unknown', ok: false, message: 'No liveness probe configured' };
  let readinessProbe = { status: 'unknown', ok: false, message: 'No readiness probe configured' };
  let onboarding = { status: 'unknown', ok: false, message: 'No onboarding status configured', setupUrl };

  if (healthConfig?.livenessPath && install?.status === 'installed' && serviceProbe.ok) {
    livenessProbe = await probeHttp(toProbeUrl({ install, path: healthConfig.livenessPath }));
  }
  if (healthConfig?.readinessPath && install?.status === 'installed' && serviceProbe.ok) {
    readinessProbe = await probeHttp(toProbeUrl({ install, path: healthConfig.readinessPath }));
  }
  if (onboardingConfig?.statusPath && install?.status === 'installed' && serviceProbe.ok) {
    const onboardingProbe = await probeHttpJson(toProbeUrl({ install, path: onboardingConfig.statusPath }));
    const readyValue = readOnboardingReadyValue(onboardingProbe?.payload, onboardingConfig.readyWhen);
    onboarding = {
      status: readyValue == null ? 'unknown' : (readyValue ? 'ready' : 'needs-setup'),
      ok: readyValue === true,
      message: onboardingProbe.ok
        ? (readyValue == null ? 'Onboarding payload did not expose ready signal' : (readyValue ? 'Onboarding complete' : 'Setup still required'))
        : onboardingProbe.message || 'Onboarding probe failed',
      setupUrl,
    };
  }

  const helperUnits = install?.status === 'installed'
    ? buildHelperUnitProbes({ catalogEntry, probeUnits })
    : [];

  const runtime = evaluateRuntimeState({
    install,
    healthConfig,
    serviceProbe,
    livenessProbe,
    readinessProbe,
    onboarding,
    helperUnits,
  });

  return {
    appId: install?.appId,
    checkedAt: nowIso,
    deploymentStatus: asTrimmedString(install?.status, 'unknown'),
    runtimeStatus: runtime.runtimeStatus,
    severity: runtime.severity,
    recoveryHint: runtime.recoveryHint,
    service: runtime.service,
    liveness: runtime.liveness,
    readiness: runtime.readiness,
    onboarding: runtime.onboarding,
    helperUnits: runtime.helperUnits,
  };
}

function computeInstallationsKey(installations) {
  return JSON.stringify((installations || []).map((item) => ({
    appId: item.appId,
    status: item.status,
    serviceName: item.serviceName,
    port: item.port,
    updatedAt: item.updatedAt,
  })).sort((a, b) => a.appId.localeCompare(b.appId)));
}

class HealthMonitor {
  constructor({ catalogById = new Map(), probeServiceState = defaultProbeServiceState, probeUnits = defaultProbeUnits, probeHttp = defaultProbeHttp, probeHttpJson = defaultProbeHttpJson, ttlMs = 15000, now = () => Date.now() } = {}) {
    this.catalogById = catalogById;
    this.probeServiceState = probeServiceState;
    this.probeUnits = probeUnits;
    this.probeHttp = probeHttp;
    this.probeHttpJson = probeHttpJson;
    this.ttlMs = ttlMs;
    this.now = now;
    this.cache = {
      key: '',
      value: null,
      expiresAt: 0,
    };
  }

  async getAppHealthSnapshot(installations, { force = false } = {}) {
    const nextInstallations = Array.isArray(installations) ? installations : [];
    const nowMs = this.now();
    const key = computeInstallationsKey(nextInstallations);

    if (!force && this.cache.value && this.cache.key === key && nowMs < this.cache.expiresAt) {
      return this.cache.value;
    }

    const nowIso = new Date(nowMs).toISOString();
    const apps = await Promise.all(nextInstallations.map((install) => buildAppHealthRecord({
      install,
      catalogEntry: this.catalogById.get(install.appId) || null,
      probeServiceState: this.probeServiceState,
      probeUnits: this.probeUnits,
      probeHttp: this.probeHttp,
      probeHttpJson: this.probeHttpJson,
      nowIso,
    })));

    const snapshot = {
      checkedAt: nowIso,
      apps,
      byAppId: Object.fromEntries(apps.map((item) => [item.appId, item])),
    };

    this.cache = {
      key,
      value: snapshot,
      expiresAt: nowMs + this.ttlMs,
    };

    return snapshot;
  }
}

module.exports = {
  HealthMonitor,
  buildAppHealthRecord,
  defaultProbeServiceState,
  defaultProbeUnits,
  isSafeSystemdUnitName,
  listHelperUnits,
  parseSystemctlShow,
  defaultProbeHttp,
  defaultProbeHttpJson,
  evaluateRuntimeState,
  joinExternalUrlPath,
  readOnboardingReadyValue,
};
