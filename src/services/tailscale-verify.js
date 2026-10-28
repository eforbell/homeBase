const { getTailscalePublishPlan } = require('./tailscale-publisher');
const { runCommand } = require('./tailscale-readiness');
const { DEFAULT_MANAGED_SERVICE_ID, normalizeManagedServiceId } = require('./tailscale-policy');
const fs = require('fs');
const { SERVE_SOCKET_DIR, ingressServices, serveTarget, serviceSocket } = require('../operations/ingress-layout');
const { catalog, catalogPorts } = require('../catalog');

function safeJsonParse(value) {
  try {
    return JSON.parse(String(value || '{}'));
  } catch (_error) {
    return null;
  }
}

// Socket ingress (Feature-10 SID-001) replaces "nginx listens on tcp:443" with: nothing but tailscaled
// answers 80/443 (Serve itself listens on this host's tailnet addresses), the socket directory is
// root-only, every published service targets its own socket, and nginx is listening on each of those
// sockets. Readable without root: ss lists bound unix sockets from /proc/net/unix, whatever the directory.
function getIngressVerification({ instance, domain, run = runCommand, statFn = (target) => fs.statSync(target) }) {
  const status = safeJsonParse(run('tailscale status --json --peers=false').stdout);
  const ownAddresses = new Set((status?.Self?.TailscaleIPs || []).map((value) => String(value).toLowerCase()));
  // ss's header row proves the listing ran; without it (ss missing or failing) nothing here is known.
  const listing = run('ss -lnt 2>/dev/null');
  const listingRows = String(listing?.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const listenersKnown = Boolean(listing?.ok) && /^State\s/.test(listingRows[0] || '');
  const listeners = listenersKnown ? listingRows.slice(1).map((row) => row.split(/\s+/)[3]).filter(Boolean) : [];
  const suiteTcp = listeners.filter((address) => {
    const match = /^\[?(.+?)\]?:(\d+)$/.exec(address);
    return match && ['80', '443'].includes(match[2]) && !ownAddresses.has(match[1].toLowerCase());
  });
  let dir = null;
  try { dir = statFn(SERVE_SOCKET_DIR); } catch { dir = null; }
  const rootOnly = Boolean(dir && dir.isDirectory() && dir.uid === 0 && (dir.mode & 0o077) === 0);
  const serve = safeJsonParse(run('tailscale serve get-config --all').stdout);
  const configured = serve?.services || {};
  const services = ingressServices({ instance, domain, apps: catalog });
  const published = services.filter((service) => configured[service.name]);
  // App ports (SID-002): an app or sidecar listening beyond loopback is reachable from the tailnet without
  // nginx, so identity headers sent straight to it would never be normalized.
  const appPorts = new Map(catalog.flatMap((app) => catalogPorts(app).map((port) => [String(port), app.id])));
  const loopback = (address) => /^(127\.|::1$|::ffff:127\.)/.test(address);
  const exposedApps = listeners.flatMap((address) => {
    const match = /^\[?(.+?)\]?:(\d+)$/.exec(address);
    return match && appPorts.has(match[2]) && !loopback(match[1].toLowerCase()) ? [`${appPorts.get(match[2])} on ${address}`] : [];
  });
  const listening = new Set(String(run('ss -lxn 2>/dev/null').stdout || '').split(/\s+/).filter((token) => token.startsWith(`${SERVE_SOCKET_DIR}/`)));
  const silent = published.filter((service) => !listening.has(serviceSocket(service.key)));
  const wrongTargets = published.filter((service) => {
    const endpoints = configured[service.name]?.endpoints || {};
    return Object.keys(endpoints).length !== 1 || endpoints['tcp:443'] !== `https://${serveTarget(service.key)}`;
  });
  const tcpTargets = Object.entries(configured).filter(([, value]) => Object.values(value?.endpoints || {}).some((target) => /localhost:443|127\.0\.0\.1:443/.test(String(target)))).map(([name]) => name);
  const checks = [
    {
      id: 'no-suite-tcp-listener',
      title: 'Nothing but Tailscale Serve listens on 80/443',
      ok: listenersKnown && !suiteTcp.length,
      summary: !listenersKnown ? 'could not list TCP listeners (ss failed)' : (suiteTcp.length ? `TCP listeners outside Serve: ${suiteTcp.join(', ')} (nginx must listen only on its sockets)` : 'only tailscaled answers 80/443'),
    },
    {
      id: 'serve-sockets-root-only',
      title: `${SERVE_SOCKET_DIR} is root-only`,
      ok: rootOnly,
      summary: rootOnly ? 'root-owned, mode 0700' : (dir ? `owner uid ${dir.uid}, mode ${(dir.mode & 0o777).toString(8)}` : 'missing (run the ingress cutover)'),
    },
    {
      id: 'services-target-own-sockets',
      title: 'Each published service targets its own nginx socket',
      ok: published.length > 0 && !wrongTargets.length && !tcpTargets.length,
      summary: wrongTargets.length
        ? `${wrongTargets.map((service) => service.name).join(', ')} target something else`
        : (tcpTargets.length ? `${tcpTargets.join(', ')} still target nginx over TCP` : (published.length ? `${published.map((service) => service.name).join(', ')} on their sockets` : 'no socket-ingress service is published yet')),
    },
    {
      id: 'apps-loopback-only',
      title: 'Apps listen only on loopback or their sockets',
      ok: listenersKnown && !exposedApps.length,
      summary: !listenersKnown ? 'could not list TCP listeners (ss failed)' : (exposedApps.length
        ? `reachable from the tailnet without nginx: ${[...new Set(exposedApps)].join(', ')} (update the app so it honours HOST=127.0.0.1 or its socket)`
        : 'no app port answers beyond loopback'),
    },
    {
      id: 'service-sockets-listening',
      title: 'nginx listens on each published service\'s socket',
      ok: published.length > 0 && !silent.length,
      summary: silent.length
        ? `nothing listens on ${silent.map((service) => serviceSocket(service.key)).join(', ')} (is nginx running? sudo nginx -t && sudo systemctl restart nginx)`
        : (published.length ? `${published.length} socket${published.length === 1 ? '' : 's'} listening` : 'no socket-ingress service is published yet'),
    },
  ];
  const byKey = Object.fromEntries(services.map((service) => [service.key, service.hostname]));
  return { generatedAt: new Date().toISOString(), mode: 'sockets', checks, repairRequired: !checks.every((check) => check.ok), instance, recommendedUrls: { homebase: `https://${byKey.homebase}/`, appsBase: `https://${byKey.home}/` }, services: services.map((service) => ({ name: service.name, hostname: service.hostname, published: Boolean(configured[service.name]) })) };
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
  getIngressVerification,
  getTailscalePublishVerification,
};
