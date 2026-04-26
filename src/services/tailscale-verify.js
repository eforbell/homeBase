const { getTailscalePublishPlan } = require('./tailscale-publisher');
const { runCommand } = require('./tailscale-readiness');
const { DEFAULT_MANAGED_SERVICE_ID, normalizeManagedServiceId } = require('./tailscale-policy');

function safeJsonParse(value) {
  try {
    return JSON.parse(String(value || '{}'));
  } catch (_error) {
    return null;
  }
}

function getTailscalePublishVerification({
  hostname = 'homebase',
  domain = 'tailnet',
  run = runCommand,
  managedServiceId = DEFAULT_MANAGED_SERVICE_ID,
  lastPublishedJob = null,
} = {}) {
  const normalizedManagedServiceId = normalizeManagedServiceId(managedServiceId);
  const plan = getTailscalePublishPlan({ hostname, domain, run, managedServiceId: normalizedManagedServiceId });
  const nginxListenResult = run(
    "ss -lnt 2>/dev/null | awk '{print $4}' | grep -E '(^|:)443$' | head -n 1"
  );

  const nginx443Listening = Boolean(nginxListenResult.ok);
  const serveHomeReady = plan.requiresChanges === false;

  let staleBecauseConfigChanged = false;
  let staleReason = null;
  let lastPublish = null;

  if (lastPublishedJob) {
    const result = safeJsonParse(lastPublishedJob.resultJson);
    const desiredHost = result?.desiredHost || null;
    const desiredDomain = result?.desiredDomain || null;
    lastPublish = {
      jobId: lastPublishedJob.id,
      finishedAt: lastPublishedJob.finishedAt || null,
      desiredHost,
      desiredDomain,
      homebaseUrl: result?.homebaseUrl || null,
      appsBaseUrl: result?.appsBaseUrl || null,
    };
    if (desiredHost && desiredDomain && (desiredHost !== hostname || desiredDomain !== domain)) {
      staleBecauseConfigChanged = true;
      staleReason = `Config now targets ${hostname}.${domain} but last real publish used ${desiredHost}.${desiredDomain}.`;
    }
  }

  const checks = [
    {
      id: 'nginx-listen-443',
      title: 'nginx listener on tcp:443',
      ok: nginx443Listening,
      summary: nginx443Listening
        ? String(nginxListenResult.stdout || '').trim() || 'listener detected'
        : String(nginxListenResult.stderr || '').trim() || 'no tcp:443 listener detected',
    },
    {
      id: 'serve-home-endpoints',
      title: `${normalizedManagedServiceId} endpoints match required topology`,
      ok: serveHomeReady,
      summary: serveHomeReady
        ? `${normalizedManagedServiceId} endpoints are in desired state.`
        : `${normalizedManagedServiceId} endpoints are missing/stale or blocked by conflicts.`,
    },
    {
      id: 'publish-config-freshness',
      title: 'Current hostname/domain matches last real publish',
      ok: !staleBecauseConfigChanged,
      summary: staleBecauseConfigChanged
        ? staleReason
        : 'Hostname/domain unchanged since last real publish or no real publish history yet.',
    },
  ];

  const repairRequired = !checks.every((check) => check.ok);

  return {
    generatedAt: new Date().toISOString(),
    checks,
    repairRequired,
    staleBecauseConfigChanged,
    staleReason,
    currentTarget: {
      hostname,
      domain,
      fullHost: `${hostname}.${domain}`,
    },
    lastPublish,
    recommendedUrls: {
      homebase: `https://${hostname}.${domain}:3080`,
      appsBase: `https://${hostname}.${domain}`,
    },
    managedServiceId: normalizedManagedServiceId,
    planSummary: {
      canExecute: plan.canExecute,
      conflicts: plan.conflicts || [],
      requiresChanges: plan.requiresChanges,
    },
  };
}

module.exports = {
  getTailscalePublishVerification,
};
