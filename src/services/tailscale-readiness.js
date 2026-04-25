const { spawnSync } = require('child_process');

const NOT_AUTHENTICATED_BACKEND_STATES = new Set(['NeedsLogin', 'NeedsMachineAuth', 'NoState']);

function runCommand(command) {
  const result = spawnSync('/bin/bash', ['-lc', command], {
    encoding: 'utf8',
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
  });

  if (result.error) {
    return {
      command,
      ok: false,
      exitCode: typeof result.status === 'number' ? result.status : 1,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || result.error.message || ''),
      error: result.error.message,
    };
  }

  return {
    command,
    ok: result.status === 0,
    exitCode: typeof result.status === 'number' ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(String(text || '{}')) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function normalizeStatusPayload(raw = {}) {
  if (raw && typeof raw === 'object' && raw.snapshot && typeof raw.snapshot === 'object') {
    return raw.snapshot;
  }
  return raw || {};
}

function summarizeServePayload(payload) {
  const services = payload && typeof payload === 'object' ? (payload.services || {}) : {};
  const serviceEntries = Object.entries(services).map(([id, value]) => {
    const endpoints = value && typeof value === 'object' ? (value.endpoints || {}) : {};
    return {
      id,
      endpointCount: Object.keys(endpoints).length,
      endpoints,
    };
  });

  const home = services['svc:home'] || {};
  const homeEndpoints = home.endpoints && typeof home.endpoints === 'object' ? home.endpoints : {};
  const tcp443Owners = serviceEntries
    .filter((entry) => Object.prototype.hasOwnProperty.call(entry.endpoints || {}, 'tcp:443'))
    .map((entry) => entry.id);

  return {
    serviceCount: serviceEntries.length,
    services: serviceEntries,
    managedHomeServicePresent: Boolean(services['svc:home']),
    managedHomeEndpoints: homeEndpoints,
    homeRecommendedReady:
      homeEndpoints['tcp:3080'] === 'http://127.0.0.1:3080'
      && homeEndpoints['tcp:443'] === 'https+insecure://localhost:443',
    tcp443Owners,
  };
}

function deriveReadiness({ installed, statusSummary, serveSummary }) {
  if (!installed) {
    return {
      state: 'not-installed',
      label: 'Not installed',
      summary: 'Install Tailscale to enable managed private publishing.',
      blockers: ['tailscale-cli-missing'],
    };
  }

  if (!statusSummary.authenticated) {
    return {
      state: 'not-authenticated',
      label: 'Not authenticated',
      summary: 'Tailscale is installed but this host is not authenticated to a tailnet.',
      blockers: ['tailscale-auth-required'],
    };
  }

  if (!serveSummary.homeRecommendedReady) {
    return {
      state: 'authenticated-unpublished',
      label: 'Authenticated, unpublished',
      summary: 'Tailscale is authenticated, but Home Base publishing is not fully configured yet.',
      blockers: ['homebase-serve-missing-or-stale'],
    };
  }

  return {
    state: 'published',
    label: 'Published',
    summary: 'Home Base managed publishing endpoints are present.',
    blockers: [],
  };
}

function buildTailscaleReadinessFromResults({
  commandResults,
  generatedAt = new Date().toISOString(),
} = {}) {
  const commandMap = commandResults || {};
  const installProbe = commandMap.installProbe || { command: 'command -v tailscale', ok: false, exitCode: 1, stdout: '', stderr: '' };
  const installed = installProbe.ok;

  const version = commandMap.version || null;
  const statusRaw = commandMap.status || null;
  const serveRaw = commandMap.serve || null;

  const response = {
    generatedAt,
    installed: {
      ok: installed,
      command: installProbe.command,
      exitCode: installProbe.exitCode,
      path: String(installProbe.stdout || '').trim() || null,
      error: installed ? null : (String(installProbe.stderr || '').trim() || 'tailscale command not found'),
    },
    version: null,
    status: null,
    serve: null,
    readiness: null,
  };

  if (!installed) {
    response.readiness = deriveReadiness({ installed: false, statusSummary: {}, serveSummary: {} });
    return response;
  }

  response.version = {
    command: version?.command || 'tailscale version',
    exitCode: version?.exitCode ?? null,
    ok: Boolean(version?.ok),
    summaryLine: String(version?.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)[0] || null,
  };

  const parsedStatus = statusRaw?.ok ? parseJson(statusRaw.stdout) : { ok: false, error: String(statusRaw?.stderr || '').trim() || 'status command failed' };
  const statusPayload = parsedStatus.ok ? normalizeStatusPayload(parsedStatus.value) : {};
  const backendState = String(statusPayload.BackendState || 'Unknown');
  const authenticated = !NOT_AUTHENTICATED_BACKEND_STATES.has(backendState);
  const daemonRunning = backendState === 'Running';

  response.status = {
    command: statusRaw?.command || 'tailscale status --json',
    exitCode: statusRaw?.exitCode ?? null,
    ok: Boolean(statusRaw?.ok),
    parseOk: parsedStatus.ok,
    parseError: parsedStatus.ok ? null : parsedStatus.error,
    backendState,
    daemonRunning,
    authenticated,
    nodeName: statusPayload?.Self?.HostName || null,
    dnsName: statusPayload?.Self?.DNSName || null,
    tailnetName: statusPayload?.CurrentTailnet?.Name || null,
    magicDnsSuffix: statusPayload?.MagicDNSSuffix || null,
    healthCount: Number(statusPayload.HealthCount || (Array.isArray(statusPayload.Health) ? statusPayload.Health.length : 0) || 0),
  };

  let serveSummary = {
    serviceCount: 0,
    services: [],
    managedHomeServicePresent: false,
    managedHomeEndpoints: {},
    homeRecommendedReady: false,
    tcp443Owners: [],
  };

  let serveParseError = null;
  if (serveRaw?.ok) {
    const parsedServe = parseJson(serveRaw.stdout);
    if (parsedServe.ok) {
      serveSummary = summarizeServePayload(parsedServe.value);
    } else {
      serveParseError = parsedServe.error;
    }
  }

  if (serveRaw?.stderr && /logged out/i.test(serveRaw.stderr)) {
    response.status.authenticated = false;
  }

  response.serve = {
    command: serveRaw?.command || 'tailscale serve get-config --all',
    exitCode: serveRaw?.exitCode ?? null,
    ok: Boolean(serveRaw?.ok),
    parseOk: Boolean(serveRaw?.ok) && !serveParseError,
    parseError: serveParseError,
    error: !serveRaw?.ok ? (String(serveRaw?.stderr || '').trim() || String(serveRaw?.stdout || '').trim() || 'serve config command failed') : null,
    ...serveSummary,
  };

  response.readiness = deriveReadiness({
    installed: true,
    statusSummary: response.status,
    serveSummary: response.serve,
  });

  return response;
}

function getTailscalePublishingReadiness({ run = runCommand } = {}) {
  const commandResults = {};
  commandResults.installProbe = run('command -v tailscale');

  if (!commandResults.installProbe.ok) {
    return buildTailscaleReadinessFromResults({ commandResults });
  }

  commandResults.version = run('tailscale version');
  commandResults.status = run('tailscale status --json');
  commandResults.serve = run('tailscale serve get-config --all');
  return buildTailscaleReadinessFromResults({ commandResults });
}

module.exports = {
  NOT_AUTHENTICATED_BACKEND_STATES,
  buildTailscaleReadinessFromResults,
  deriveReadiness,
  getTailscalePublishingReadiness,
  parseJson,
  runCommand,
  summarizeServePayload,
};
