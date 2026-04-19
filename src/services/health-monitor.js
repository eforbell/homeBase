const { spawnSync } = require('child_process');
const http = require('http');
const https = require('https');

function asTrimmedString(value, fallback = '') {
  const next = String(value == null ? '' : value).trim();
  return next || fallback;
}

function statusFromHttpCode(statusCode) {
  if (!Number.isFinite(statusCode)) return 'unknown';
  return statusCode >= 200 && statusCode < 400 ? 'ok' : 'failed';
}

function defaultProbeServiceState(serviceName) {
  const safeName = asTrimmedString(serviceName);
  if (!safeName) {
    return {
      state: 'unknown',
      ok: false,
      message: 'No service name configured',
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

function evaluateRuntimeState({ install, healthConfig, serviceProbe, livenessProbe, readinessProbe, onboarding }) {
  const deploymentStatus = asTrimmedString(install?.status, 'unknown');
  const service = serviceProbe || { state: 'unknown', ok: false, message: 'Service probe unavailable' };
  const liveness = livenessProbe || { status: 'unknown', ok: false, message: 'No liveness probe configured' };
  const readiness = readinessProbe || { status: 'unknown', ok: false, message: 'No readiness probe configured' };
  const onboardingState = onboarding || { status: 'unknown', ok: false, message: 'No onboarding status configured', setupUrl: null };

  if (deploymentStatus !== 'installed') {
    return {
      runtimeStatus: 'not-installed',
      severity: 'info',
      recoveryHint: 'Install this app to enable runtime health checks.',
      service,
      liveness,
      readiness,
      onboarding: onboardingState,
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
  };
}

async function buildAppHealthRecord({ install, catalogEntry, probeServiceState, probeHttp, probeHttpJson = defaultProbeHttpJson, nowIso }) {
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

  const runtime = evaluateRuntimeState({
    install,
    healthConfig,
    serviceProbe,
    livenessProbe,
    readinessProbe,
    onboarding,
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
  constructor({ catalogById = new Map(), probeServiceState = defaultProbeServiceState, probeHttp = defaultProbeHttp, probeHttpJson = defaultProbeHttpJson, ttlMs = 15000, now = () => Date.now() } = {}) {
    this.catalogById = catalogById;
    this.probeServiceState = probeServiceState;
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
  defaultProbeHttp,
  defaultProbeHttpJson,
  evaluateRuntimeState,
  joinExternalUrlPath,
  readOnboardingReadyValue,
};
