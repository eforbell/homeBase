const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { getCatalog, getAppById } = require('./catalog');
const { manifestSchema, validateManifestEntry } = require('./manifest-schema');
const { SqliteStateStore } = require('./state/sqlite-store');
const { buildBootstrapPlan } = require('./services/bootstrap-planner');
const { buildInstallPlan } = require('./services/install-planner');
const { buildExecutorInstallAction } = require('./services/executor-install');
const { buildBackupPlan } = require('./services/backup-planner');
const { listBackupsFromDisk } = require('./services/backup-inventory');
const { BACKUP_ROOT } = require('./operations/paths');
const { buildRestorePlan } = require('./services/restore-planner');
const { buildUninstallPlan } = require('./services/uninstall-planner');
const { buildHomeBaseRuntimePlan } = require('./services/homebase-runtime-planner');
const { buildHomeBaseUpdatePlan } = require('./services/homebase-update-planner');
const { JobRunner } = require('./services/job-runner');
const { runPreflightChecks } = require('./services/preflight');
const { getTailscalePublishingReadiness } = require('./services/tailscale-readiness');
const { getTailscalePublishPlan } = require('./services/tailscale-publisher');
const { getTailscalePublishVerification } = require('./services/tailscale-verify');
const {
  mergeHomeBaseConfig,
  toClientHomeBaseConfig,
  validateHomeBaseConfigPatch,
} = require('./homebase-config');
const { scheduleAutoBootstrap } = require('./auto-bootstrap');
const { HealthMonitor } = require('./services/health-monitor');
const { HealthAlertNotifier } = require('./services/notifications');
const { AppUpdateMonitor } = require('./services/app-update-monitor');
const { normalizePathname } = require('./setup-gate');
const { getExecutorCapabilities, canExecuteMutations } = require('./executor/capabilities');
const { hostStatus: requestExecutorHostStatus, planAction: requestExecutorPlan } = require('./executor/client');
const {
  getAdminStatus,
  setupAdmin,
  unlockAdmin,
  lockAdmin,
  rotateAdmin,
  requireAdminForExecute,
  EXECUTION_MODE_UPGRADE_HINT,
} = require('./admin-auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PUBLIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};
const ALLOWED_PUBLIC_EXTENSIONS = new Set(Object.keys(PUBLIC_MIME_TYPES));

const DEFAULT_SOVEREIGN_FONT_SANS_CSS_URL = 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap';
const DEFAULT_SOVEREIGN_FONT_MONO_CSS_URL = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap';

function buildSovereignFontsCss() {
  const configuredSource = String(process.env.SOVEREIGN_FONT_SOURCE || 'auto').trim().toLowerCase();
  const sharedAssetsRoot = process.env.HOME_BASE_ASSETS_ROOT || '/opt/sovereign-home/assets';
  const localFontDir = path.join(sharedAssetsRoot, 'fonts');
  const localFontsAvailable = fs.existsSync(path.join(localFontDir, 'source-sans-3.css'))
    && fs.existsSync(path.join(localFontDir, 'jetbrains-mono.css'));
  const mountPath = String(process.env.SOVEREIGN_FONT_MOUNT_PATH || '/_sovereign/fonts/').endsWith('/')
    ? String(process.env.SOVEREIGN_FONT_MOUNT_PATH || '/_sovereign/fonts/')
    : `${String(process.env.SOVEREIGN_FONT_MOUNT_PATH || '/_sovereign/fonts/')}/`;

  const source = configuredSource === 'auto'
    ? (localFontsAvailable ? 'local' : 'google')
    : configuredSource;
  if (source === 'off') return '/* Sovereign fonts disabled via SOVEREIGN_FONT_SOURCE=off */\n';

  const isLocal = source === 'local';
  const sansUrl = (isLocal ? process.env.SOVEREIGN_FONT_SANS_CSS_URL_LOCAL : process.env.SOVEREIGN_FONT_SANS_CSS_URL)
    || (isLocal ? `${mountPath}source-sans-3.css` : DEFAULT_SOVEREIGN_FONT_SANS_CSS_URL);
  const monoUrl = (isLocal ? process.env.SOVEREIGN_FONT_MONO_CSS_URL_LOCAL : process.env.SOVEREIGN_FONT_MONO_CSS_URL)
    || (isLocal ? `${mountPath}jetbrains-mono.css` : DEFAULT_SOVEREIGN_FONT_MONO_CSS_URL);

  return [
    '/* Generated from environment: /sovereign-fonts.css */',
    `@import url('${sansUrl}');`,
    `@import url('${monoUrl}');`,
    '',
  ].join('\n');
}

function resolveSovereignFontAssetPath(requestPathname) {
  const configuredMount = String(process.env.SOVEREIGN_FONT_MOUNT_PATH || '/_sovereign/fonts/');
  const normalizedConfiguredMount = configuredMount.endsWith('/') ? configuredMount : `${configuredMount}/`;
  const candidatePrefixes = [
    normalizedConfiguredMount,
    '/_sovereign/fonts/',
    '/sovereign/fonts/',
  ];
  const matchedPrefix = candidatePrefixes.find((prefix) => requestPathname.startsWith(prefix));
  if (!matchedPrefix) return null;

  const suffix = requestPathname.slice(matchedPrefix.length);
  if (!suffix || suffix.includes('\0') || suffix.includes('..')) return null;
  const ext = path.extname(suffix).toLowerCase();
  if (!['.css', '.woff2', '.woff', '.ttf'].includes(ext)) return null;

  const sharedAssetsRoot = process.env.HOME_BASE_ASSETS_ROOT || '/opt/sovereign-home/assets';
  const fontDir = path.join(sharedAssetsRoot, 'fonts');
  const absolute = path.resolve(fontDir, suffix);
  if (!absolute.startsWith(`${fontDir}${path.sep}`)) return null;
  return absolute;
}


function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, {
    location,
    'cache-control': 'no-store',
  });
  res.end();
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

function sendNotFoundText(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function resolvePublicAsset(requestPath) {
  if (!requestPath || requestPath.includes('\0')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch (_error) {
    return null;
  }
  const sanitized = decoded.replace(/^\/+/, '');
  if (!sanitized) return null;
  const ext = path.extname(sanitized).toLowerCase();
  if (!ALLOWED_PUBLIC_EXTENSIONS.has(ext)) return null;
  const resolved = path.resolve(PUBLIC_DIR, sanitized);
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
  return resolved;
}

function serveStaticFile(res, absolutePath) {
  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = PUBLIC_MIME_TYPES[ext];
  if (!contentType) {
    sendNotFoundText(res);
    return;
  }
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch (_error) {
    sendNotFoundText(res);
    return;
  }
  if (!stat.isFile()) {
    sendNotFoundText(res);
    return;
  }
  const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=300';
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': cacheControl,
  });
  fs.createReadStream(absolutePath).pipe(res);
}

function servePublicPage(res, pageName) {
  serveStaticFile(res, path.join(PUBLIC_DIR, pageName));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

// Routes that still build legacy sudo/shell plans must never execute in executor mode. Refuse explicitly
// rather than relying on which preflight checks happen to be absent there.
function rejectLegacyExecution(res) {
  return sendJson(res, 409, {
    error: 'This operation has not been converted to the typed executor yet, so it cannot run in executor mode. Dry-run plans remain available.',
    code: 'TYPED_EXECUTION_NOT_SUPPORTED',
  });
}

// Resolves the restore archive by name only: the web process never reads backup directories (they
// belong to sovereign and may not be listable by homebase). The executor verifies the archive exists.
function resolveRestoreBackupId({ appId, backupDir, stateStore }) {
  const pattern = /^[0-9]{8}T[0-9]{6}[0-9]{0,3}Z$/;
  if (backupDir) {
    const requested = String(backupDir);
    const name = path.posix.basename(requested);
    if (!pattern.test(name)) return null;
    if (requested.includes('/') && path.posix.normalize(requested) !== `${BACKUP_ROOT}/${appId}/${name}`) return null;
    return name;
  }
  const names = stateStore.listBackups(appId).map((record) => path.posix.basename(record.archiveDir)).filter((name) => pattern.test(name)).sort();
  return names.at(-1) || null;
}

// Dry-runs in executor mode preview the plan the executor would actually run (never the legacy sudo plan).
async function startExecutorPreview({ res, effectiveConfig, appId, kind, action, jobRunner }) {
  let capabilities;
  try { capabilities = await getExecutorCapabilities(effectiveConfig.homeBaseExecutorSocket); } catch {
    return sendJson(res, 503, { error: 'Home Base executor is unavailable.', code: 'EXECUTOR_UNAVAILABLE' });
  }
  if (!capabilities?.installableApps?.includes(appId)) return sendJson(res, 409, { error: `The executor does not manage ${appId} yet.`, code: 'TYPED_EXECUTION_NOT_SUPPORTED' });
  const jobId = jobRunner.startTypedPreviewJob({ kind, target: appId, action });
  return sendJson(res, 202, { ok: true, jobId, appId, dryRun: true });
}

// Starts an executor lifecycle job after the same capability checks installs use.
async function startExecutorLifecycle({ res, effectiveConfig, stateStore, appId, auditAction, auth, start }) {
  let capabilities;
  try { capabilities = await getExecutorCapabilities(effectiveConfig.homeBaseExecutorSocket); } catch {
    return sendJson(res, 503, { error: 'Home Base executor is unavailable.', code: 'EXECUTOR_UNAVAILABLE' });
  }
  if (!canExecuteMutations(capabilities)) return sendJson(res, 409, { error: 'Home Base executor is incompatible or mutations are disabled.', code: 'EXECUTOR_INCOMPATIBLE' });
  if (!capabilities.installableApps?.includes(appId)) return sendJson(res, 409, { error: `The executor does not manage ${appId} yet.`, code: 'TYPED_EXECUTION_NOT_SUPPORTED' });
  const jobId = start();
  recordAdminAudit(stateStore, { action: auditAction, target: appId, dryRun: false, outcome: 'queued', jobId, sessionTokenHash: auth?.sessionTokenHash });
  return sendJson(res, 202, { ok: true, jobId, appId, dryRun: false });
}

function missingCheckIds(preflight, ids) {
  return ids.filter((id) => !preflight.checks.find((check) => check.id === id && check.ok === true));
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/$/, '');
}

function joinExternalPath(baseUrl, mountPath) {
  return `${trimTrailingSlash(baseUrl)}${String(mountPath || '/').startsWith('/') ? '' : '/'}${String(mountPath || '/')}`;
}

function projectInstallationsWithCurrentUrls(installations = {}, config = {}) {
  const hostname = config.defaultHostname || 'homebase';
  const domain = config.defaultDomain || 'tailnet';
  const publicBase = `https://${hostname}.${domain}`;
  return Object.fromEntries(Object.entries(installations).map(([appId, record]) => [
    appId,
    {
      ...record,
      externalUrl: joinExternalPath(publicBase, record.mountPath),
    },
  ]));
}

function projectStateForClient(state, config) {
  return {
    ...state,
    installations: projectInstallationsWithCurrentUrls(state.installations || {}, config),
  };
}


async function requireAdminForJobRead(req, stateStore) {
  const status = await getAdminStatus(req, stateStore);
  if (!status.configured) {
    return { ok: false, statusCode: 409, payload: { error: 'Admin setup is required before viewing job history.' } };
  }
  if (!status.unlocked) {
    return { ok: false, statusCode: 401, payload: { error: 'Admin unlock is required to view job history.' } };
  }
  return { ok: true };
}

function getHomeBaseStatus(config) {
  const fs = require('fs');
  const { spawnSync } = require('child_process');
  const runtimeUser = config.homeBaseRuntimeUser || 'homebase';
  const appDir = config.homeBaseAppDir || '/opt/sovereign-home/homebase';
  const stateDir = config.homeBaseStateDir || '/var/lib/sovereign-home/homebase';
  const envFile = config.homeBaseEnvFile || '/etc/sovereign-home/homebase.env';
  const stateDbPath = config.stateDbPath || `${stateDir}/home-base.sqlite3`;
  const serviceFile = '/etc/systemd/system/homebase.service';
  const sudoersFile = config.homeBaseSudoersFile || '/etc/sudoers.d/homebase';
  const sharedAssetsRoot = config.homeBaseAssetsRoot || '/opt/sovereign-home/assets';
  const fontDir = path.join(sharedAssetsRoot, 'fonts');
  const sansCssPath = path.join(fontDir, 'source-sans-3.css');
  const monoCssPath = path.join(fontDir, 'jetbrains-mono.css');
  const configuredSource = String(process.env.SOVEREIGN_FONT_SOURCE || 'auto').trim().toLowerCase();
  const mountPath = String(config.sovereignFontMountPath || '/_sovereign/fonts/');
  const sudoersFileExists = fs.existsSync(sudoersFile);
  let sudoersPolicyStatus = sudoersFileExists ? 'unknown' : 'absent';
  if (sudoersFileExists) {
    try {
      const escapedRuntimeUser = runtimeUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const legacyBroadPattern = new RegExp(`^[\\t ]*${escapedRuntimeUser}[\\t ]+.*NOPASSWD:[\\t ]*ALL(?:[\\t ]|$)`, 'm');
      sudoersPolicyStatus = legacyBroadPattern.test(fs.readFileSync(sudoersFile, 'utf8'))
        ? 'legacy-broad'
        : 'present';
    } catch (_error) {
      sudoersPolicyStatus = 'unknown';
    }
  }
  const legacyBroadSudoersDetected = sudoersPolicyStatus === 'legacy-broad';
  const privilegedJobsEnabled = config.homeBaseEnablePrivilegedJobs === true;
  const status = {
    runtimeUser,
    appDir,
    stateDir,
    stateDbPath,
    envFile,
    serviceName: 'homebase',
    bindHost: config.bindHost || '127.0.0.1',
    executionMode: config.homeBaseExecutionMode || 'plan-only',
    privilegedJobsEnabled,
    legacyBroadSudoersDetected,
    sudoersPolicyStatus,
    sovereignFonts: {
      configuredSource,
      mountPath,
      assetDir: fontDir,
      files: {
        sourceSansCss: sansCssPath,
        jetbrainsMonoCss: monoCssPath,
      },
      availability: {
        sourceSansCss: fs.existsSync(sansCssPath),
        jetbrainsMonoCss: fs.existsSync(monoCssPath),
      },
    },
    paths: {
      appDirExists: fs.existsSync(appDir),
      stateDirExists: fs.existsSync(stateDir),
      stateDbExists: fs.existsSync(stateDbPath),
      envFileExists: fs.existsSync(envFile),
      serviceFileExists: fs.existsSync(serviceFile),
      sudoersFileExists,
    },
  };

  const systemctl = spawnSync('/bin/bash', ['-lc', 'command -v systemctl >/dev/null 2>&1 && systemctl is-active homebase || true'], {
    encoding: 'utf8',
  });
  status.systemd = {
    active: (systemctl.stdout || '').trim() || 'unknown',
  };
  status.sovereignFonts.available = Boolean(
    status.sovereignFonts.availability.sourceSansCss
    && status.sovereignFonts.availability.jetbrainsMonoCss
  );
  status.ok = true;
  return status;
}

function buildRestartPlan({ app, install }) {
  const serviceName = install?.serviceName || app?.service?.name;
  const readinessPath = app?.network?.health?.readinessPath || app?.network?.health?.livenessPath || '/api/health';
  const port = install?.port || app?.network?.preferredPort;
  const healthUrl = port ? `http://127.0.0.1:${port}${readinessPath}` : null;
  const commands = [`sudo systemctl restart ${serviceName}`];
  if (Array.isArray(app.sidecars)) {
    for (const sidecar of app.sidecars) {
      commands.push(`sudo systemctl restart ${sidecar.name}`);
    }
  }
  if (Array.isArray(app.timers)) {
    for (const timer of app.timers) {
      commands.push(`sudo systemctl restart ${timer.timerName}`);
    }
  }
  commands.push(
    healthUrl
      ? `for attempt in $(seq 1 20); do curl --fail --silent --show-error ${healthUrl} && exit 0; sleep 1; done; echo \"Timed out waiting for ${healthUrl}\" >&2; exit 1`
      : `echo \"Service restarted; no health URL configured for ${serviceName}\"`,
  );
  return {
    kind: 'restart',
    generatedAt: new Date().toISOString(),
    app: {
      id: app.id,
      name: app.name,
    },
    restart: {
      serviceName,
      port,
      readinessPath,
    },
    commands,
  };
}

function recordAdminAudit(stateStore, record = {}) {
  try {
    stateStore.createAdminAudit({
      createdAt: new Date().toISOString(),
      action: String(record.action || 'unknown'),
      target: String(record.target || 'unknown'),
      dryRun: Boolean(record.dryRun),
      outcome: String(record.outcome || 'unknown'),
      reason: record.reason ? String(record.reason) : null,
      jobId: record.jobId != null ? Number(record.jobId) : null,
      sessionTokenHash: record.sessionTokenHash || null,
    });
  } catch (_error) {
    // Never block API flow on audit write failures.
  }
}

function executionBlockOutcome(auth) {
  return auth?.payload?.code === 'PRIVILEGED_EXECUTION_DISABLED'
    ? 'blocked-execution-mode'
    : 'blocked-auth';
}

function createApp(config) {
  const stateStore = new SqliteStateStore(config.stateDbPath);
  stateStore.init();
  const jobRunner = new JobRunner(stateStore, { executorSocket: config.homeBaseExecutorSocket });
  try {
    jobRunner.reconcileStaleUpdateJobs();
    // Typed jobs that were in flight when Home Base stopped: the executor's journal has the outcome.
    if (config.homeBaseExecutionMode === 'executor') jobRunner.reconcileTypedJobs();
  } catch (error) {
    console.warn(`[homebase] stale update reconciliation failed: ${error.message}`);
  }
  const catalog = getCatalog();
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  const preflightCache = {
    key: '',
    expiresAt: 0,
    value: null,
  };
  const tailscaleReadinessCache = {
    expiresAt: 0,
    value: null,
  };
  const tailscalePublishPlanCache = {
    key: '',
    expiresAt: 0,
    value: null,
  };
  const tailscaleVerifyCache = {
    key: '',
    expiresAt: 0,
    value: null,
  };
  const validationErrors = catalog.flatMap((entry) =>
    validateManifestEntry(entry).map((error) => `${entry.id}: ${error}`)
  );

  if (validationErrors.length) {
    throw new Error(`Catalog validation failed:\n${validationErrors.join('\n')}`);
  }

  const initialHomeBaseConfigOverride = stateStore.getHomeBaseConfig() || {};
  const initialEffectiveConfig = mergeHomeBaseConfig(config, initialHomeBaseConfigOverride);
  const autoBootstrap = scheduleAutoBootstrap({
    stateStore,
    jobRunner,
    config: initialEffectiveConfig,
  });
  const healthMonitor = new HealthMonitor({ catalogById });
  const healthAlertNotifier = new HealthAlertNotifier({
    postJson: config.notificationsPostJson,
  });
  const appUpdateMonitor = new AppUpdateMonitor(stateStore, {
    serviceUser: initialEffectiveConfig.serviceUser || 'sovereign',
    gitTransport: initialEffectiveConfig.gitTransport || 'https',
    gitSshKeyPath: initialEffectiveConfig.gitSshKeyPath || '',
    gitSshKnownHostsPath: initialEffectiveConfig.gitSshKnownHostsPath || '',
    gitSshStrictHostKeyChecking: initialEffectiveConfig.gitSshStrictHostKeyChecking || 'accept-new',
    checkIntervalMs: config.appUpdateCheckIntervalMs,
    staleAfterMs: config.appUpdateStatusTtlMs,
    executionMode: initialEffectiveConfig.homeBaseExecutionMode,
    executorSocket: initialEffectiveConfig.homeBaseExecutorSocket,
    baseInstallDir: initialEffectiveConfig.baseInstallDir,
  });
  appUpdateMonitor.schedule({
    installationsProvider: () => Object.values(stateStore.loadState().installations || {}),
    gitConfigProvider: () => {
      const override = stateStore.getHomeBaseConfig() || {};
      const effective = mergeHomeBaseConfig(config, override);
      return {
        serviceUser: effective.serviceUser || 'sovereign',
        gitTransport: effective.gitTransport || 'https',
        gitSshKeyPath: effective.gitSshKeyPath || '',
        gitSshKnownHostsPath: effective.gitSshKnownHostsPath || '',
        gitSshStrictHostKeyChecking: effective.gitSshStrictHostKeyChecking || 'accept-new',
        executionMode: effective.homeBaseExecutionMode,
        executorSocket: effective.homeBaseExecutorSocket,
        baseInstallDir: effective.baseInstallDir,
      };
    },
  });

  function updateGitConfig(effective) {
    return {
      serviceUser: effective.serviceUser || 'sovereign',
      gitTransport: effective.gitTransport || 'https',
      gitSshKeyPath: effective.gitSshKeyPath || '',
      gitSshKnownHostsPath: effective.gitSshKnownHostsPath || '',
      gitSshStrictHostKeyChecking: effective.gitSshStrictHostKeyChecking || 'accept-new',
      executionMode: effective.homeBaseExecutionMode,
      executorSocket: effective.homeBaseExecutorSocket,
      baseInstallDir: effective.baseInstallDir,
    };
  }

  function getTailscaleReadiness(effectiveConfig, { force = false } = {}) {
    const now = Date.now();
    if (!force && tailscaleReadinessCache.value && tailscaleReadinessCache.expiresAt > now) {
      return tailscaleReadinessCache.value;
    }
    const value = getTailscalePublishingReadiness({
      run: effectiveConfig.tailscaleRunCommand,
      managedServiceId: effectiveConfig.tailscaleManagedServiceId,
      managedServiceId: effectiveConfig.tailscaleManagedServiceId,
    });
    tailscaleReadinessCache.value = value;
    tailscaleReadinessCache.expiresAt = now + 15_000;
    return value;
  }

  function getTailscalePublishPlanCached(effectiveConfig, { force = false } = {}) {
    const now = Date.now();
    const cacheKey = `${effectiveConfig.defaultHostname || 'homebase'}.${effectiveConfig.defaultDomain || 'tailnet'}|${effectiveConfig.tailscaleManagedServiceId || 'svc:home'}`;
    if (!force && tailscalePublishPlanCache.value && tailscalePublishPlanCache.key === cacheKey && tailscalePublishPlanCache.expiresAt > now) {
      return tailscalePublishPlanCache.value;
    }
    const value = getTailscalePublishPlan({
      hostname: effectiveConfig.defaultHostname || 'homebase',
      domain: effectiveConfig.defaultDomain || 'tailnet',
      run: effectiveConfig.tailscaleRunCommand,
      managedServiceId: effectiveConfig.tailscaleManagedServiceId,
    });
    tailscalePublishPlanCache.key = cacheKey;
    tailscalePublishPlanCache.value = value;
    tailscalePublishPlanCache.expiresAt = now + 15_000;
    return value;
  }

  function getTailscaleVerificationCached(effectiveConfig, { force = false } = {}) {
    const now = Date.now();
    const cacheKey = `${effectiveConfig.defaultHostname || 'homebase'}.${effectiveConfig.defaultDomain || 'tailnet'}|${effectiveConfig.tailscaleManagedServiceId || 'svc:home'}`;
    if (!force && tailscaleVerifyCache.value && tailscaleVerifyCache.key === cacheKey && tailscaleVerifyCache.expiresAt > now) {
      return tailscaleVerifyCache.value;
    }
    const lastPublishedJob = stateStore.getLatestCompletedRealJobByKind('tailscale-publish');
    const value = getTailscalePublishVerification({
      hostname: effectiveConfig.defaultHostname || 'homebase',
      domain: effectiveConfig.defaultDomain || 'tailnet',
      run: effectiveConfig.tailscaleRunCommand,
      managedServiceId: effectiveConfig.tailscaleManagedServiceId,
      lastPublishedJob,
    });
    tailscaleVerifyCache.key = cacheKey;
    tailscaleVerifyCache.value = value;
    tailscaleVerifyCache.expiresAt = now + 15_000;
    return value;
  }

  // The web service cannot inspect protected host state itself; the executor answers a fixed set of
  // read-only questions. Refreshed asynchronously so synchronous preflight gates use the latest facts.
  const executorStatusCache = { value: null, expiresAt: 0, inFlight: null };
  function refreshExecutorStatus(effectiveConfig, { force = false } = {}) {
    if (effectiveConfig.homeBaseExecutionMode !== 'executor') return Promise.resolve(null);
    if (!force && executorStatusCache.value && executorStatusCache.expiresAt > Date.now()) return Promise.resolve(executorStatusCache.value);
    // Concurrent callers share one probe instead of each opening a socket.
    if (!executorStatusCache.inFlight) {
      executorStatusCache.inFlight = probeExecutorStatus(effectiveConfig).finally(() => { executorStatusCache.inFlight = null; });
    }
    return executorStatusCache.inFlight;
  }

  async function probeExecutorStatus(effectiveConfig) {
    const socket = effectiveConfig.homeBaseExecutorSocket;
    let value;
    try {
      const capabilities = await getExecutorCapabilities(socket, { timeoutMs: 3000 });
      let host = null;
      try { host = await requestExecutorHostStatus(socket, { timeoutMs: 8000 }); } catch { host = null; }
      value = { reachable: true, capabilities, host };
    } catch (error) {
      value = { reachable: false, error: error.code === 'ENOENT' ? 'Executor socket is missing.' : (error.message || 'Executor unavailable.') };
    }
    executorStatusCache.value = value;
    executorStatusCache.expiresAt = Date.now() + 30_000;
    return value;
  }

  async function getPreflight(effectiveConfig, { force = false } = {}) {
    const previousExecutorStatus = executorStatusCache.value;
    const executorStatus = await refreshExecutorStatus(effectiveConfig, { force });
    // New executor facts invalidate the host-check cache even when the caller did not force.
    if (executorStatus !== previousExecutorStatus) force = true;
    const now = Date.now();
    const cacheKey = JSON.stringify({
      gitTransport: effectiveConfig.gitTransport || 'https',
      gitSshKeyPath: effectiveConfig.gitSshKeyPath || '',
      serviceUser: effectiveConfig.serviceUser || 'sovereign',
    });
    if (!force && preflightCache.value && preflightCache.key === cacheKey && preflightCache.expiresAt > now) {
      return preflightCache.value;
    }
    const value = runPreflightChecks(effectiveConfig, { executorStatus });
    preflightCache.key = cacheKey;
    preflightCache.value = value;
    preflightCache.expiresAt = now + 30_000;
    return value;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method || 'GET';
      const state = stateStore.loadState();
      const homeBaseConfigOverride = stateStore.getHomeBaseConfig() || {};
      const effectiveConfig = mergeHomeBaseConfig(config, homeBaseConfigOverride);
      const normalizedPath = normalizePathname(pathname);

      if (method === 'GET') {
        if (normalizedPath === '/') return servePublicPage(res, 'index.html');
        if (normalizedPath === '/apps') return servePublicPage(res, 'apps.html');
        if (normalizedPath === '/jobs') return servePublicPage(res, 'jobs.html');
        if (normalizedPath === '/setup') return servePublicPage(res, 'setup.html');
        if (normalizedPath === '/settings') return redirect(res, '/config');
        if (normalizedPath === '/status') return servePublicPage(res, 'status.html');
        if (normalizedPath === '/admin') return servePublicPage(res, 'admin.html');
        if (normalizedPath === '/config') return servePublicPage(res, 'config.html');
        if (normalizedPath === '/network') return servePublicPage(res, 'network.html');
        if (/^\/apps\/[^/]+$/.test(normalizedPath)) return servePublicPage(res, 'app.html');
        if (/^\/jobs\/\d+$/.test(normalizedPath)) return servePublicPage(res, 'job.html');
      }
      if (method === 'GET' && pathname === '/sovereign-fonts.css') {
        res.writeHead(200, {
          'content-type': 'text/css; charset=utf-8',
          'cache-control': 'public, max-age=300',
        });
        res.end(buildSovereignFontsCss());
        return;
      }
      if (method === 'GET') {
        const sovereignFontAssetPath = resolveSovereignFontAssetPath(pathname);
        if (sovereignFontAssetPath) {
          return serveStaticFile(res, sovereignFontAssetPath);
        }
      }

      if (method === 'GET' && pathname === '/api/catalog') {
        return sendJson(res, 200, { apps: catalog });
      }
      if (method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, projectStateForClient(state, effectiveConfig));
      }
      if (method === 'GET' && pathname === '/api/apps/health') {
        const installations = Object.values(state.installations || {});
        const snapshot = await healthMonitor.getAppHealthSnapshot(installations, {
          force: url.searchParams.get('refresh') === '1',
        });
        try {
          await healthAlertNotifier.notifySnapshot(snapshot, effectiveConfig);
        } catch (error) {
          console.warn(`[homebase] health alert notify failed: ${error.message}`);
        }
        return sendJson(res, 200, snapshot);
      }
      if (method === 'GET' && pathname === '/api/apps/updates') {
        const installations = Object.values(state.installations || {});
        const snapshot = await appUpdateMonitor.getSnapshot(installations, {
          force: url.searchParams.get('refresh') === '1',
          gitConfig: {
            serviceUser: effectiveConfig.serviceUser || 'sovereign',
            gitTransport: effectiveConfig.gitTransport || 'https',
            gitSshKeyPath: effectiveConfig.gitSshKeyPath || '',
            gitSshKnownHostsPath: effectiveConfig.gitSshKnownHostsPath || '',
            gitSshStrictHostKeyChecking: effectiveConfig.gitSshStrictHostKeyChecking || 'accept-new',
            executionMode: effectiveConfig.homeBaseExecutionMode,
            executorSocket: effectiveConfig.homeBaseExecutorSocket,
            baseInstallDir: effectiveConfig.baseInstallDir,
          },
        });
        return sendJson(res, 200, {
          byAppId: snapshot,
        });
      }
      if (method === 'POST' && pathname === '/api/alerts/test') {
        try {
          await healthAlertNotifier.sendTestAlert(effectiveConfig);
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, error.code ? 409 : 500, { error: error.message || 'Unable to send test alert' });
        }
      }
      if (method === 'GET' && pathname === '/api/preflight') {
        return sendJson(res, 200, await getPreflight(effectiveConfig, { force: url.searchParams.get('refresh') === '1' }));
      }
      if (method === 'GET' && pathname === '/api/network/tailscale') {
        return sendJson(res, 200, getTailscaleReadiness(effectiveConfig, {
          force: url.searchParams.get('refresh') === '1',
        }));
      }
      if (method === 'GET' && pathname === '/api/network/tailscale/publish-plan') {
        return sendJson(res, 200, getTailscalePublishPlanCached(effectiveConfig, {
          force: url.searchParams.get('refresh') === '1',
        }));
      }
      if (method === 'GET' && pathname === '/api/network/tailscale/verify') {
        return sendJson(res, 200, getTailscaleVerificationCached(effectiveConfig, {
          force: url.searchParams.get('refresh') === '1',
        }));
      }
      if (method === 'GET' && pathname === '/api/jobs') {
        const auth = await requireAdminForJobRead(req, stateStore);
        if (!auth.ok) return sendJson(res, auth.statusCode, auth.payload);
        return sendJson(res, 200, { jobs: state.jobs || [] });
      }
      const jobMatch = pathname.match(/^\/api\/jobs\/(\d+)$/);
      if (method === 'GET' && jobMatch) {
        const auth = await requireAdminForJobRead(req, stateStore);
        if (!auth.ok) return sendJson(res, auth.statusCode, auth.payload);
        const job = stateStore.getJob(Number(jobMatch[1]));
        if (!job) return notFound(res);
        return sendJson(res, 200, job);
      }
      if (method === 'GET' && pathname === '/api/manifest/schema') {
        return sendJson(res, 200, manifestSchema);
      }
      if (method === 'GET' && pathname === '/api/homebase/config') {
        return sendJson(res, 200, toClientHomeBaseConfig(config, homeBaseConfigOverride));
      }
      if (method === 'GET' && pathname === '/api/admin/status') {
        return sendJson(res, 200, await getAdminStatus(req, stateStore));
      }
      if (method === 'POST' && pathname === '/api/admin/setup') {
        const body = await parseBody(req);
        const result = await setupAdmin(req, res, body, stateStore);
        return sendJson(res, result.statusCode, result.payload);
      }
      if (method === 'POST' && pathname === '/api/admin/unlock') {
        const body = await parseBody(req);
        const result = await unlockAdmin(req, res, body, stateStore);
        return sendJson(res, result.statusCode, result.payload);
      }
      if (method === 'POST' && pathname === '/api/admin/lock') {
        const result = await lockAdmin(req, res, stateStore);
        return sendJson(res, result.statusCode, result.payload);
      }
      if (method === 'POST' && pathname === '/api/admin/rotate') {
        const body = await parseBody(req);
        const result = await rotateAdmin(req, res, body, stateStore);
        return sendJson(res, result.statusCode, result.payload);
      }
      if (method === 'GET' && pathname === '/api/admin/audit') {
        const status = await getAdminStatus(req, stateStore);
        if (!status.configured) return sendJson(res, 409, { error: 'Admin credential is not configured yet.' });
        if (!status.unlocked) return sendJson(res, 401, { error: 'Admin unlock is required to view audit history.' });
        const limitRaw = Number(url.searchParams.get('limit') || 50);
        const parsedLimit = Number.isFinite(limitRaw) ? limitRaw : 50;
        const limit = Math.min(200, Math.max(1, Math.trunc(parsedLimit)));
        return sendJson(res, 200, { entries: stateStore.listAdminAudit(limit) });
      }
      if (method === 'POST' && pathname === '/api/homebase/config') {
        const body = await parseBody(req);
        const current = toClientHomeBaseConfig(config, homeBaseConfigOverride);
        const parsed = validateHomeBaseConfigPatch(body, current);
        if (parsed.error) {
          return sendJson(res, 400, { error: parsed.error });
        }
        const persisted = {
          ...parsed.value,
          updatedAt: new Date().toISOString(),
        };
        stateStore.setHomeBaseConfig(persisted);
        const updatedConfig = mergeHomeBaseConfig(config, persisted);
        const updatedInstallations = projectInstallationsWithCurrentUrls(stateStore.loadState().installations || {}, updatedConfig);
        for (const installation of Object.values(updatedInstallations)) {
          stateStore.upsertInstallation({
            ...installation,
            updatedAt: persisted.updatedAt,
          });
        }
        return sendJson(res, 200, toClientHomeBaseConfig(config, persisted));
      }
      if (method === 'GET' && pathname === '/api/homebase/status') {
        return sendJson(res, 200, getHomeBaseStatus(effectiveConfig));
      }
      if (method === 'GET' && pathname === '/api/homebase/health') {
        return sendJson(res, 200, {
          status: 'ok',
          timestamp: new Date().toISOString(),
          homebase: getHomeBaseStatus(effectiveConfig),
        });
      }
      if (method === 'GET' && pathname === '/api/homebase/bootstrap-status') {
        return sendJson(res, 200, {
          autoBootstrap,
          latestBootstrapJob: stateStore.getLatestJobByKind('bootstrap'),
        });
      }
      if (method === 'POST' && pathname === '/api/homebase/runtime-plan') {
        const body = await parseBody(req);
        return sendJson(res, 200, buildHomeBaseRuntimePlan(effectiveConfig, body));
      }
      if (method === 'GET' && pathname === '/api/homebase/update-plan') {
        return sendJson(res, 200, buildHomeBaseUpdatePlan(effectiveConfig));
      }
      if (method === 'POST' && pathname === '/api/homebase/update-self') {
        const body = await parseBody(req);
        let auth = null;
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          recordAdminAudit(stateStore, {
            action: 'homebase-update-self',
            target: 'homebase',
            dryRun: false,
            outcome: 'blocked-confirm',
            reason: 'confirm-missing',
          });
          return sendJson(res, 400, { error: 'Real execution requires confirm=EXECUTE' });
        }
        // The legacy self-update chowns the checkout to the runtime user, which would undo the root
        // ownership the executor's own code depends on. Executor hosts update via install.sh --repair.
        if (body.dryRun === false && effectiveConfig.homeBaseExecutionMode === 'executor') return rejectLegacyExecution(res);
        if (body.dryRun === false) {
          auth = await requireAdminForExecute(req, stateStore, { privilegedJobsEnabled: effectiveConfig.homeBaseEnablePrivilegedJobs === true, executionModeMissing: effectiveConfig.homeBaseExecutionModeMissing === true });
          if (!auth.ok) {
            recordAdminAudit(stateStore, {
              action: 'homebase-update-self',
              target: 'homebase',
              dryRun: false,
              outcome: executionBlockOutcome(auth),
              reason: auth.payload?.error,
              sessionTokenHash: auth.sessionTokenHash,
            });
            return sendJson(res, auth.statusCode, auth.payload);
          }
        }
        const plan = buildHomeBaseUpdatePlan(effectiveConfig, body);
        const jobId = jobRunner.startHomeBaseUpdateJob(plan, {
          dryRun: body.dryRun !== false,
        });
        if (body.dryRun === false) {
          recordAdminAudit(stateStore, {
            action: 'homebase-update-self',
            target: 'homebase',
            dryRun: false,
            outcome: 'queued',
            jobId,
            sessionTokenHash: auth?.sessionTokenHash,
          });
        }
        return sendJson(res, 202, { ok: true, jobId, dryRun: body.dryRun !== false });
      }
      if (method === 'POST' && pathname === '/api/homebase/install-self') {
        const body = await parseBody(req);
        let auth = null;
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          recordAdminAudit(stateStore, {
            action: 'homebase-install-self',
            target: 'homebase',
            dryRun: false,
            outcome: 'blocked-confirm',
            reason: 'confirm-missing',
          });
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          auth = await requireAdminForExecute(req, stateStore, { privilegedJobsEnabled: effectiveConfig.homeBaseEnablePrivilegedJobs === true, executionModeMissing: effectiveConfig.homeBaseExecutionModeMissing === true });
          if (!auth.ok) {
            recordAdminAudit(stateStore, {
              action: 'homebase-install-self',
              target: 'homebase',
              dryRun: false,
              outcome: executionBlockOutcome(auth),
              reason: auth.payload?.error,
              sessionTokenHash: auth.sessionTokenHash,
            });
            return sendJson(res, auth.statusCode, auth.payload);
          }
        }
        if (body.dryRun === false) {
          if (effectiveConfig.homeBaseExecutionMode === 'executor') return rejectLegacyExecution(res);
          const preflight = await getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'systemd', 'node']);
          if (missing.length) {
            recordAdminAudit(stateStore, {
              action: 'homebase-install-self',
              target: 'homebase',
              dryRun: false,
              outcome: 'blocked-preflight',
              reason: missing.join(', '),
              sessionTokenHash: auth?.sessionTokenHash,
            });
            return sendJson(res, 409, {
              error: `Preflight checks must pass before Home Base self-install: ${missing.join(', ')}`,
              missing,
            });
          }
        }
        const plan = buildHomeBaseRuntimePlan(effectiveConfig, body);
        const jobId = jobRunner.startHomeBaseRuntimeJob(plan, {
          dryRun: body.dryRun !== false,
        });
        if (body.dryRun === false) {
          recordAdminAudit(stateStore, {
            action: 'homebase-install-self',
            target: 'homebase',
            dryRun: false,
            outcome: 'queued',
            jobId,
            sessionTokenHash: auth?.sessionTokenHash,
          });
        }
        return sendJson(res, 202, {
          ok: true,
          jobId,
          dryRun: body.dryRun !== false,
        });
      }
      if (method === 'POST' && pathname === '/api/bootstrap/plan') {
        const body = await parseBody(req);
        const plan = buildBootstrapPlan({
          ...body,
          serviceUser: body.serviceUser || effectiveConfig.serviceUser,
          baseInstallDir: body.baseInstallDir || effectiveConfig.baseInstallDir,
          baseBackupDir: body.baseBackupDir || effectiveConfig.baseBackupDir,
          baseConfigDir: effectiveConfig.baseConfigDir,
        });
        stateStore.addBootstrapPlan({
          generatedAt: plan.generatedAt,
          serviceUser: body.serviceUser || effectiveConfig.serviceUser,
        });
        return sendJson(res, 200, plan);
      }
      if (method === 'POST' && pathname === '/api/bootstrap/execute') {
        const body = await parseBody(req);
        let auth = null;
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          recordAdminAudit(stateStore, {
            action: 'bootstrap-execute',
            target: 'local-host',
            dryRun: false,
            outcome: 'blocked-confirm',
            reason: 'confirm-missing',
          });
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          auth = await requireAdminForExecute(req, stateStore, { privilegedJobsEnabled: effectiveConfig.homeBaseEnablePrivilegedJobs === true, executionModeMissing: effectiveConfig.homeBaseExecutionModeMissing === true });
          if (!auth.ok) {
            recordAdminAudit(stateStore, {
              action: 'bootstrap-execute',
              target: 'local-host',
              dryRun: false,
              outcome: executionBlockOutcome(auth),
              reason: auth.payload?.error,
              sessionTokenHash: auth.sessionTokenHash,
            });
            return sendJson(res, auth.statusCode, auth.payload);
          }
        }
        if (body.dryRun === false && effectiveConfig.homeBaseExecutionMode === 'executor') {
          try {
            const capabilities = await getExecutorCapabilities(effectiveConfig.homeBaseExecutorSocket);
            if (!canExecuteMutations(capabilities)) return sendJson(res, 409, { error: 'Home Base executor is incompatible or mutations are disabled.', code: 'EXECUTOR_INCOMPATIBLE' });
          } catch { return sendJson(res, 503, { error: 'Home Base executor is unavailable.', code: 'EXECUTOR_UNAVAILABLE' }); }
          const jobId = jobRunner.startTypedBootstrapJob();
          return sendJson(res, 202, { ok: true, jobId, dryRun: false });
        }
        if (body.dryRun === false) {
          const preflight = await getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'systemd']);
          if (missing.length) {
            recordAdminAudit(stateStore, {
              action: 'bootstrap-execute',
              target: 'local-host',
              dryRun: false,
              outcome: 'blocked-preflight',
              reason: missing.join(', '),
              sessionTokenHash: auth?.sessionTokenHash,
            });
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real bootstrap execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }

        const plan = buildBootstrapPlan({
          ...body,
          serviceUser: body.serviceUser || effectiveConfig.serviceUser,
          baseInstallDir: body.baseInstallDir || effectiveConfig.baseInstallDir,
          baseBackupDir: body.baseBackupDir || effectiveConfig.baseBackupDir,
          baseConfigDir: effectiveConfig.baseConfigDir,
        });
        const jobId = jobRunner.startBootstrapJob(plan, {
          dryRun: body.dryRun !== false,
        });
        if (body.dryRun === false) {
          recordAdminAudit(stateStore, {
            action: 'bootstrap-execute',
            target: 'local-host',
            dryRun: false,
            outcome: 'queued',
            jobId,
            sessionTokenHash: auth?.sessionTokenHash,
          });
        }
        return sendJson(res, 202, {
          ok: true,
          jobId,
          dryRun: body.dryRun !== false,
        });
      }

      if (method === 'POST' && pathname === '/api/network/tailscale/publish-execute') {
        const body = await parseBody(req);
        const dryRun = body.dryRun !== false;
        let auth = null;

        const plan = getTailscalePublishPlanCached(effectiveConfig, { force: true });
        if (!plan.canExecute) {
          if (!dryRun) {
            recordAdminAudit(stateStore, {
              action: 'tailscale-publish-execute',
              target: 'svc:home',
              dryRun: false,
              outcome: 'blocked-policy',
              reason: plan.blockedReason || 'plan-not-executable',
            });
          }
          return sendJson(res, 409, {
            error: plan.summary,
            blockedReason: plan.blockedReason,
            conflicts: plan.conflicts || [],
            canExecute: false,
          });
        }

        if (!dryRun && body.confirm !== 'EXECUTE') {
          recordAdminAudit(stateStore, {
            action: 'tailscale-publish-execute',
            target: 'svc:home',
            dryRun: false,
            outcome: 'blocked-confirm',
            reason: 'confirm-missing',
          });
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }

        if (!dryRun) {
          auth = await requireAdminForExecute(req, stateStore, { privilegedJobsEnabled: effectiveConfig.homeBaseEnablePrivilegedJobs === true, executionModeMissing: effectiveConfig.homeBaseExecutionModeMissing === true });
          if (!auth.ok) {
            recordAdminAudit(stateStore, {
              action: 'tailscale-publish-execute',
              target: 'svc:home',
              dryRun: false,
              outcome: executionBlockOutcome(auth),
              reason: auth.payload?.error,
              sessionTokenHash: auth.sessionTokenHash,
            });
            return sendJson(res, auth.statusCode, auth.payload);
          }

          if (effectiveConfig.homeBaseExecutionMode === 'executor') return rejectLegacyExecution(res);
          const preflight = await getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, ['tailscale', 'nginx', 'nginx-config', 'nginx-snippets-include']);
          if (missing.length) {
            recordAdminAudit(stateStore, {
              action: 'tailscale-publish-execute',
              target: 'svc:home',
              dryRun: false,
              outcome: 'blocked-preflight',
              reason: missing.join(', '),
              sessionTokenHash: auth?.sessionTokenHash,
            });
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real publish execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }

        const jobId = jobRunner.startTailscalePublishJob(plan, { dryRun });
        if (!dryRun) {
          recordAdminAudit(stateStore, {
            action: 'tailscale-publish-execute',
            target: 'svc:home',
            dryRun: false,
            outcome: 'queued',
            jobId,
            sessionTokenHash: auth?.sessionTokenHash,
          });
        }

        return sendJson(res, 202, {
          ok: true,
          dryRun,
          jobId,
        });
      }

      const appActionsMatch = pathname.match(/^\/api\/apps\/([^/]+)\/actions$/);
      if (method === 'GET' && appActionsMatch) {
        const appId = appActionsMatch[1];
        if (!getAppById(appId)) return notFound(res);
        const installation = (state.installations || {})[appId] || null;
        const planned = installation?.status === 'planned';
        return sendJson(res, 200, {
          appId,
          actions: {
            install: true,
            backup: true,
            restore: true,
            update: Boolean(installation) && !planned,
            restart: Boolean(installation) && !planned,
            uninstall: Boolean(installation) && !planned,
            discardPlan: planned,
          },
          note: planned
            ? 'This is a saved dry-run. Run a real install or discard the plan metadata; no app files were created by the dry-run.'
            : 'Update currently runs through install execute (same deployment pipeline).',
        });
      }

      const discardPlanMatch = pathname.match(/^\/api\/apps\/([^/]+)\/discard-plan$/);
      if (method === 'POST' && discardPlanMatch) {
        const body = await parseBody(req);
        const appId = discardPlanMatch[1];
        const installation = (state.installations || {})[appId] || null;
        if (!getAppById(appId)) return notFound(res);
        if (!installation || installation.status !== 'planned') {
          return sendJson(res, 409, { error: `App ${appId} does not have a discardable plan.` });
        }
        // Defense in depth: a "planned" record whose install root exists belongs to a real install.
        if (installation.installRoot && fs.existsSync(installation.installRoot)) {
          return sendJson(res, 409, { error: `App ${appId} has files at ${installation.installRoot}; uninstall it instead of discarding the plan.`, code: 'INSTALL_PRESENT' });
        }
        if (body.confirm !== 'DISCARD') {
          return sendJson(res, 400, { error: 'Discarding a saved plan requires confirm=DISCARD.' });
        }
        const adminStatus = await getAdminStatus(req, stateStore);
        if (!adminStatus.configured) return sendJson(res, 409, { error: 'Admin setup is required before discarding a saved plan.' });
        if (!adminStatus.unlocked) return sendJson(res, 401, { error: 'Admin unlock is required before discarding a saved plan.' });
        stateStore.deleteInstallation(appId);
        recordAdminAudit(stateStore, {
          action: 'app-plan-discard', target: appId, dryRun: false, outcome: 'completed', reason: 'planned-metadata-only',
        });
        return sendJson(res, 200, { ok: true, appId, discarded: true });
      }

      const installPlanMatch = pathname.match(/^\/api\/apps\/([^/]+)\/install-plan$/);
      if (method === 'POST' && installPlanMatch) {
        const body = await parseBody(req);
        if (effectiveConfig.homeBaseExecutionMode === 'executor') {
          const action = buildExecutorInstallAction({ appId: installPlanMatch[1], ref: body.ref, config: effectiveConfig });
          if (!action) return notFound(res);
          if (!action.ref) return sendJson(res, 409, { error: 'Executor installs track main or a pinned 40-character commit SHA.', code: 'POLICY_DENIED' });
          try {
            return sendJson(res, 200, { kind: 'executor-plan', action, ...(await requestExecutorPlan(effectiveConfig.homeBaseExecutorSocket, action)) });
          } catch (error) {
            return sendJson(res, error.code === 'ENOENT' ? 503 : 409, { error: error.message, code: error.code || 'EXECUTOR_UNAVAILABLE' });
          }
        }
        const plan = buildInstallPlan({ appId: installPlanMatch[1], state, options: body, config: effectiveConfig });
        return sendJson(res, 200, plan);
      }

      const installMatch = pathname.match(/^\/api\/apps\/([^/]+)\/install$/);
      if (method === 'POST' && installMatch) {
        const body = await parseBody(req);
        const appId = installMatch[1];
        // Saving a "planned" record from the legacy plan has no executor meaning; preview with a dry-run.
        if (effectiveConfig.homeBaseExecutionMode === 'executor') {
          return sendJson(res, 409, { error: 'In executor mode, preview an install with a dry-run (POST /api/apps/:id/execute with dryRun: true).', code: 'TYPED_EXECUTION_NOT_SUPPORTED' });
        }
        const plan = buildInstallPlan({ appId, state, options: body, config: effectiveConfig });
        const app = getAppById(appId);
        stateStore.upsertInstallation({
          ...plan.stateRecord,
          purpose: app ? app.purpose : '',
          updatedAt: new Date().toISOString(),
        });
        return sendJson(res, 200, plan);
      }
      const executeInstallMatch = pathname.match(/^\/api\/apps\/([^/]+)\/execute$/);
      if (method === 'POST' && executeInstallMatch) {
        const body = await parseBody(req);
        let auth = null;
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          recordAdminAudit(stateStore, {
            action: 'app-install-execute',
            target: executeInstallMatch[1],
            dryRun: false,
            outcome: 'blocked-confirm',
            reason: 'confirm-missing',
          });
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          auth = await requireAdminForExecute(req, stateStore, { privilegedJobsEnabled: effectiveConfig.homeBaseEnablePrivilegedJobs === true, executionModeMissing: effectiveConfig.homeBaseExecutionModeMissing === true });
          if (!auth.ok) {
            recordAdminAudit(stateStore, {
              action: 'app-install-execute',
              target: executeInstallMatch[1],
              dryRun: false,
              outcome: executionBlockOutcome(auth),
              reason: auth.payload?.error,
              sessionTokenHash: auth.sessionTokenHash,
            });
            return sendJson(res, auth.statusCode, auth.payload);
          }
        }
        if (body.dryRun === false && effectiveConfig.homeBaseExecutionMode !== 'executor') {
          const app = getAppById(executeInstallMatch[1]);
          const required = ['os', 'sudo', 'systemd', 'git', 'psql', 'nginx', 'postgres-service', 'nginx-config'];
          if (app?.runtime?.kind === 'node') required.push('node');
          if (app?.runtime?.kind === 'python') required.push('python3');
          const preflight = await getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, required);
          if (missing.length) {
            recordAdminAudit(stateStore, {
              action: 'app-install-execute',
              target: executeInstallMatch[1],
              dryRun: false,
              outcome: 'blocked-preflight',
              reason: missing.join(', '),
              sessionTokenHash: auth?.sessionTokenHash,
            });
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real install execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }

        const appId = executeInstallMatch[1];
        if (body.dryRun === false && effectiveConfig.homeBaseExecutionMode === 'executor') {
          let capabilities;
          try { capabilities = await getExecutorCapabilities(effectiveConfig.homeBaseExecutorSocket); } catch (error) {
            return sendJson(res, 503, { error: 'Home Base executor is unavailable.', code: 'EXECUTOR_UNAVAILABLE' });
          }
          if (!canExecuteMutations(capabilities)) return sendJson(res, 409, { error: 'Home Base executor is incompatible or mutations are disabled.', code: 'EXECUTOR_INCOMPATIBLE' });
          if (!capabilities.installableApps?.includes(appId)) return sendJson(res, 409, { error: `The executor cannot install ${appId} yet.`, code: 'TYPED_EXECUTION_NOT_SUPPORTED' });
          // Executor units, snippets, and env use the catalog's preferred port. Only a *different* app holding
          // it is a conflict; a reinstall keeps the port it already has.
          const catalogPort = getAppById(appId).network.preferredPort;
          const conflict = Object.values(state.installations || {}).find((entry) => entry.appId !== appId && entry.port === catalogPort);
          if (conflict) return sendJson(res, 409, { error: `Port ${catalogPort} is already assigned to ${conflict.appId}; executor installs use catalog ports.`, code: 'PORT_CONFLICT' });
          // Used only for Home Base's own installation record; the executor builds the real plan from the
          // catalog. Only the ref comes from the request so the record matches what the executor installs
          // (catalog mount path and port, standard install root), never caller-edited values.
          const action = buildExecutorInstallAction({ appId, ref: body.ref, config: effectiveConfig });
          if (!action.ref) return sendJson(res, 409, { error: 'Executor installs track main or a pinned 40-character commit SHA.', code: 'POLICY_DENIED' });
          const { transport } = action;
          if (transport === 'ssh' && capabilities.gitDeployKey !== 'present') {
            return sendJson(res, 409, {
              error: capabilities.gitDeployKey === 'insecure'
                ? 'The executor deploy key must be a root-owned regular file with mode 0600. Re-run: sudo bash install.sh --repair --git-ssh-key <path>'
                : 'SSH git transport needs a deploy key. On the host run: sudo bash install.sh --repair --git-ssh-key <path-to-private-key>',
              code: 'GIT_DEPLOY_KEY_REQUIRED',
            });
          }
          // Database credentials are generated inside the executor; a caller-supplied dbPassword is ignored here.
          const jobId = jobRunner.startTypedInstallJob({
            appId,
            ref: action.ref,
            transport,
            // Non-secret site values the executor renders into the app env (hostname-derived URLs, timezone).
            site: action.site,
            onComplete: () => {
              const installed = (stateStore.loadState().installations || {})[appId];
              if (installed) void appUpdateMonitor.refreshInstalledApps([installed], { force: true, gitConfig: updateGitConfig(effectiveConfig) });
            },
          });
          return sendJson(res, 202, { ok: true, jobId, appId, dryRun: false });
        }
        if (effectiveConfig.homeBaseExecutionMode === 'executor') {
          // Preview only: the executor compiles the plan it would run. No legacy plan, .env, or record.
          const action = buildExecutorInstallAction({ appId, ref: body.ref, config: effectiveConfig });
          if (!action) return notFound(res);
          if (!action.ref) return sendJson(res, 409, { error: 'Executor installs track main or a pinned 40-character commit SHA.', code: 'POLICY_DENIED' });
          return startExecutorPreview({ res, effectiveConfig, appId, kind: 'install', action, jobRunner });
        }
        const plan = buildInstallPlan({ appId, state, options: body, config: effectiveConfig });
        const jobId = jobRunner.startInstallJob(plan, {
          dryRun: body.dryRun !== false,
          onComplete: body.dryRun === false
            ? () => {
                try {
                  const latestState = stateStore.loadState();
                  const installed = (latestState.installations || {})[appId];
                  if (!installed) return;
                  void appUpdateMonitor.refreshInstalledApps([installed], { force: true });
                } catch (error) {
                  console.warn(`[homebase] update status refresh failed for ${appId}: ${error.message}`);
                }
              }
            : null,
        });
        if (body.dryRun === false) {
          recordAdminAudit(stateStore, {
            action: 'app-install-execute',
            target: appId,
            dryRun: false,
            outcome: 'queued',
            jobId,
            sessionTokenHash: auth?.sessionTokenHash,
          });
        }
        return sendJson(res, 202, {
          ok: true,
          jobId,
          appId,
          dryRun: body.dryRun !== false,
        });
      }
      const restartExecuteMatch = pathname.match(/^\/api\/apps\/([^/]+)\/restart\/execute$/);
      if (method === 'POST' && restartExecuteMatch) {
        const body = await parseBody(req);
        let auth = null;
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          recordAdminAudit(stateStore, {
            action: 'app-restart-execute',
            target: restartExecuteMatch[1],
            dryRun: false,
            outcome: 'blocked-confirm',
            reason: 'confirm-missing',
          });
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          auth = await requireAdminForExecute(req, stateStore, { privilegedJobsEnabled: effectiveConfig.homeBaseEnablePrivilegedJobs === true, executionModeMissing: effectiveConfig.homeBaseExecutionModeMissing === true });
          if (!auth.ok) {
            recordAdminAudit(stateStore, {
              action: 'app-restart-execute',
              target: restartExecuteMatch[1],
              dryRun: false,
              outcome: executionBlockOutcome(auth),
              reason: auth.payload?.error,
              sessionTokenHash: auth.sessionTokenHash,
            });
            return sendJson(res, auth.statusCode, auth.payload);
          }
        }
        const appId = restartExecuteMatch[1];
        const app = getAppById(appId);
        if (!app) return notFound(res);
        const install = (state.installations || {})[appId];
        if (!install) {
          if (body.dryRun === false) {
            recordAdminAudit(stateStore, {
              action: 'app-restart-execute',
              target: appId,
              dryRun: false,
              outcome: 'blocked-state',
              reason: 'not-installed',
            });
          }
          return sendJson(res, 409, {
            error: `App ${appId} must be installed before restart is available.`,
          });
        }
        if (body.dryRun === false) {
          if (effectiveConfig.homeBaseExecutionMode === 'executor') {
            return startExecutorLifecycle({ res, effectiveConfig, stateStore, appId, auditAction: 'app-restart-execute', auth, start: () => jobRunner.startTypedRestartJob({ appId }) });
          }
          const preflight = await getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'systemd']);
          if (missing.length) {
            recordAdminAudit(stateStore, {
              action: 'app-restart-execute',
              target: appId,
              dryRun: false,
              outcome: 'blocked-preflight',
              reason: missing.join(', '),
              sessionTokenHash: auth?.sessionTokenHash,
            });
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real restart execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }
        if (effectiveConfig.homeBaseExecutionMode === 'executor') {
          return startExecutorPreview({ res, effectiveConfig, appId, kind: 'restart', action: { action: 'restart', appId }, jobRunner });
        }
        const plan = buildRestartPlan({ app, install });
        const jobId = jobRunner.startRestartJob(plan, {
          dryRun: body.dryRun !== false,
        });
        if (body.dryRun === false) {
          recordAdminAudit(stateStore, {
            action: 'app-restart-execute',
            target: appId,
            dryRun: false,
            outcome: 'queued',
            jobId,
            sessionTokenHash: auth?.sessionTokenHash,
          });
        }
        return sendJson(res, 202, {
          ok: true,
          jobId,
          appId,
          dryRun: body.dryRun !== false,
        });
      }
      const backupPlanMatch = pathname.match(/^\/api\/apps\/([^/]+)\/backup-plan$/);
      if (method === 'POST' && backupPlanMatch) {
        const plan = buildBackupPlan({ appId: backupPlanMatch[1], state, config: effectiveConfig });
        return sendJson(res, 200, plan);
      }
      const backupListMatch = pathname.match(/^\/api\/apps\/([^/]+)\/backups$/);
      if (method === 'GET' && backupListMatch) {
        const appId = backupListMatch[1];
        const dbBackups = stateStore.listBackups(appId);
        if (dbBackups.length) {
          return sendJson(res, 200, {
            app: getAppById(appId) ? { id: getAppById(appId).id, name: getAppById(appId).name } : { id: appId, name: appId },
            backupRoot: `${(effectiveConfig.baseBackupDir || '/var/lib/sovereign-home/backups').replace(/\/$/, '')}/${appId}`,
            backups: dbBackups.map((record) => ({
              name: record.archiveDir.split('/').pop(),
              archiveDir: record.archiveDir,
              generatedAt: record.generatedAt,
              status: record.status,
              includedFiles: record.includedFiles,
            })),
          });
        }
        return sendJson(res, 200, listBackupsFromDisk({ appId, config: effectiveConfig }));
      }
      const backupExecuteMatch = pathname.match(/^\/api\/apps\/([^/]+)\/backup\/execute$/);
      if (method === 'POST' && backupExecuteMatch) {
        const body = await parseBody(req);
        let auth = null;
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          recordAdminAudit(stateStore, {
            action: 'app-backup-execute',
            target: backupExecuteMatch[1],
            dryRun: false,
            outcome: 'blocked-confirm',
            reason: 'confirm-missing',
          });
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          auth = await requireAdminForExecute(req, stateStore, { privilegedJobsEnabled: effectiveConfig.homeBaseEnablePrivilegedJobs === true, executionModeMissing: effectiveConfig.homeBaseExecutionModeMissing === true });
          if (!auth.ok) {
            recordAdminAudit(stateStore, {
              action: 'app-backup-execute',
              target: backupExecuteMatch[1],
              dryRun: false,
              outcome: executionBlockOutcome(auth),
              reason: auth.payload?.error,
              sessionTokenHash: auth.sessionTokenHash,
            });
            return sendJson(res, auth.statusCode, auth.payload);
          }
        }
        if (body.dryRun === false) {
          if (effectiveConfig.homeBaseExecutionMode === 'executor') {
            const appId = backupExecuteMatch[1];
            return startExecutorLifecycle({ res, effectiveConfig, stateStore, appId, auditAction: 'app-backup-execute', auth, start: () => jobRunner.startTypedBackupJob({ appId }) });
          }
          const preflight = await getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'psql']);
          if (missing.length) {
            recordAdminAudit(stateStore, {
              action: 'app-backup-execute',
              target: backupExecuteMatch[1],
              dryRun: false,
              outcome: 'blocked-preflight',
              reason: missing.join(', '),
              sessionTokenHash: auth?.sessionTokenHash,
            });
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real backup execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }
        if (effectiveConfig.homeBaseExecutionMode === 'executor') {
          const appId = backupExecuteMatch[1];
          return startExecutorPreview({ res, effectiveConfig, appId, kind: 'backup', action: { action: 'backup', appId }, jobRunner });
        }
        const plan = buildBackupPlan({ appId: backupExecuteMatch[1], state, config: effectiveConfig });
        const jobId = jobRunner.startBackupJob(plan, {
          dryRun: body.dryRun !== false,
        });
        if (body.dryRun === false) {
          recordAdminAudit(stateStore, {
            action: 'app-backup-execute',
            target: backupExecuteMatch[1],
            dryRun: false,
            outcome: 'queued',
            jobId,
            sessionTokenHash: auth?.sessionTokenHash,
          });
        }
        return sendJson(res, 202, {
          ok: true,
          jobId,
          appId: backupExecuteMatch[1],
          dryRun: body.dryRun !== false,
        });
      }
      const restorePlanMatch = pathname.match(/^\/api\/apps\/([^/]+)\/restore-plan$/);
      if (method === 'POST' && restorePlanMatch) {
        const body = await parseBody(req);
        const plan = buildRestorePlan({
          appId: restorePlanMatch[1],
          backupDir: body.backupDir,
          state,
          config: effectiveConfig,
        });
        return sendJson(res, 200, plan);
      }
      const uninstallExecuteMatch = pathname.match(/^\/api\/apps\/([^/]+)\/uninstall\/execute$/);
      if (method === 'POST' && uninstallExecuteMatch) {
        const body = await parseBody(req);
        let auth = null;
        const appId = uninstallExecuteMatch[1];
        const app = getAppById(appId);
        if (!app) return notFound(res);
        const install = (state.installations || {})[appId];
        if (!install) {
          if (body.dryRun === false) {
            recordAdminAudit(stateStore, {
              action: 'app-uninstall-execute',
              target: appId,
              dryRun: false,
              outcome: 'blocked-state',
              reason: 'not-installed',
            });
          }
          return sendJson(res, 409, {
            error: `App ${appId} must be installed before uninstall is available.`,
          });
        }
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          recordAdminAudit(stateStore, {
            action: 'app-uninstall-execute',
            target: appId,
            dryRun: false,
            outcome: 'blocked-confirm',
            reason: 'confirm-missing',
          });
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          auth = await requireAdminForExecute(req, stateStore, { privilegedJobsEnabled: effectiveConfig.homeBaseEnablePrivilegedJobs === true, executionModeMissing: effectiveConfig.homeBaseExecutionModeMissing === true });
          if (!auth.ok) {
            recordAdminAudit(stateStore, {
              action: 'app-uninstall-execute',
              target: appId,
              dryRun: false,
              outcome: executionBlockOutcome(auth),
              reason: auth.payload?.error,
              sessionTokenHash: auth.sessionTokenHash,
            });
            return sendJson(res, auth.statusCode, auth.payload);
          }
        }
        if (body.dryRun === false) {
          const required = ['os', 'sudo', 'systemd', 'nginx'];
          if (app.database?.engine && app.database.engine.includes('postgres')) {
            required.push('psql', 'postgres-service');
          }
          if (effectiveConfig.homeBaseExecutionMode === 'executor') {
            return startExecutorLifecycle({ res, effectiveConfig, stateStore, appId, auditAction: 'app-uninstall-execute', auth, start: () => jobRunner.startTypedUninstallJob({ appId, keepBackups: body.keepBackups !== false }) });
          }
          const preflight = await getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, required);
          if (missing.length) {
            recordAdminAudit(stateStore, {
              action: 'app-uninstall-execute',
              target: appId,
              dryRun: false,
              outcome: 'blocked-preflight',
              reason: missing.join(', '),
              sessionTokenHash: auth?.sessionTokenHash,
            });
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real uninstall execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }
        if (effectiveConfig.homeBaseExecutionMode === 'executor') {
          return startExecutorPreview({ res, effectiveConfig, appId, kind: 'uninstall', action: { action: 'uninstall', appId, keepBackups: body.keepBackups !== false }, jobRunner });
        }
        const plan = buildUninstallPlan({
          appId,
          state,
          config: effectiveConfig,
          options: { keepBackups: body.keepBackups !== false },
        });
        const jobId = jobRunner.startUninstallJob(plan, {
          dryRun: body.dryRun !== false,
        });
        if (body.dryRun === false) {
          recordAdminAudit(stateStore, {
            action: 'app-uninstall-execute',
            target: appId,
            dryRun: false,
            outcome: 'queued',
            jobId,
            sessionTokenHash: auth?.sessionTokenHash,
          });
        }
        return sendJson(res, 202, {
          ok: true,
          jobId,
          appId,
          dryRun: body.dryRun !== false,
          keepBackups: body.keepBackups !== false,
        });
      }

      const restoreExecuteMatch = pathname.match(/^\/api\/apps\/([^/]+)\/restore\/execute$/);
      if (method === 'POST' && restoreExecuteMatch) {
        const body = await parseBody(req);
        let auth = null;
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          recordAdminAudit(stateStore, {
            action: 'app-restore-execute',
            target: restoreExecuteMatch[1],
            dryRun: false,
            outcome: 'blocked-confirm',
            reason: 'confirm-missing',
          });
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          auth = await requireAdminForExecute(req, stateStore, { privilegedJobsEnabled: effectiveConfig.homeBaseEnablePrivilegedJobs === true, executionModeMissing: effectiveConfig.homeBaseExecutionModeMissing === true });
          if (!auth.ok) {
            recordAdminAudit(stateStore, {
              action: 'app-restore-execute',
              target: restoreExecuteMatch[1],
              dryRun: false,
              outcome: executionBlockOutcome(auth),
              reason: auth.payload?.error,
              sessionTokenHash: auth.sessionTokenHash,
            });
            return sendJson(res, auth.statusCode, auth.payload);
          }
        }
        if (body.dryRun === false) {
          if (effectiveConfig.homeBaseExecutionMode === 'executor') {
            const appId = restoreExecuteMatch[1];
            const backupId = resolveRestoreBackupId({ appId, backupDir: body.backupDir, stateStore });
            if (!backupId) return sendJson(res, 409, { error: `No restorable backup found for ${appId}.`, code: 'BACKUP_NOT_FOUND' });
            return startExecutorLifecycle({ res, effectiveConfig, stateStore, appId, auditAction: 'app-restore-execute', auth, start: () => jobRunner.startTypedRestoreJob({ appId, backupId }) });
          }
          const preflight = await getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'psql']);
          if (missing.length) {
            recordAdminAudit(stateStore, {
              action: 'app-restore-execute',
              target: restoreExecuteMatch[1],
              dryRun: false,
              outcome: 'blocked-preflight',
              reason: missing.join(', '),
              sessionTokenHash: auth?.sessionTokenHash,
            });
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real restore execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }

        if (effectiveConfig.homeBaseExecutionMode === 'executor') {
          const appId = restoreExecuteMatch[1];
          const backupId = resolveRestoreBackupId({ appId, backupDir: body.backupDir, stateStore });
          if (!backupId) return sendJson(res, 409, { error: `No restorable backup found for ${appId}.`, code: 'BACKUP_NOT_FOUND' });
          return startExecutorPreview({ res, effectiveConfig, appId, kind: 'restore', action: { action: 'restore', appId, backupId }, jobRunner });
        }
        const plan = buildRestorePlan({
          appId: restoreExecuteMatch[1],
          backupDir: body.backupDir,
          state,
          config: effectiveConfig,
        });
        const jobId = jobRunner.startRestoreJob(plan, {
          dryRun: body.dryRun !== false,
        });
        if (body.dryRun === false) {
          recordAdminAudit(stateStore, {
            action: 'app-restore-execute',
            target: restoreExecuteMatch[1],
            dryRun: false,
            outcome: 'queued',
            jobId,
            sessionTokenHash: auth?.sessionTokenHash,
          });
        }
        return sendJson(res, 202, {
          ok: true,
          jobId,
          appId: restoreExecuteMatch[1],
          dryRun: body.dryRun !== false,
        });
      }

      if (method === 'GET') {
        const assetPath = resolvePublicAsset(pathname);
        if (assetPath) {
          return serveStaticFile(res, assetPath);
        }
      }

      return notFound(res);
    } catch (error) {
      const statusByCode = {
        APP_NOT_FOUND: 404,
        APP_NOT_INSTALLED: 409,
        INVALID_GIT_REF: 400,
        GIT_SSH_KEY_PATH_REQUIRED: 400,
        INVALID_RUNTIME_USER: 400,
        INVALID_RUNTIME_PATH: 400,
        INVALID_RUNTIME_VALUE: 400,
        INVALID_RUNTIME_PORT: 400,
        INVALID_BIND_HOST: 400,
        INVALID_GIT_TRANSPORT: 400,
        INVALID_AUTO_BOOTSTRAP_MODE: 400,
        INVALID_AUTO_BOOTSTRAP_DELAY: 400,
        UNSAFE_PRIVILEGED_CONFIGURATION: 409,
        UNSAFE_AUTO_BOOTSTRAP_CONFIGURATION: 409,
      };
      return sendJson(res, statusByCode[error.code] || 500, {
        error: error.message || 'Unexpected error',
      });
    }
  });

  return {
    server,
    listen(callback) {
      const bindHost = config.bindHost || '127.0.0.1';
      server.listen(config.port, bindHost, () => {
        const address = server.address();
        const activePort = address && typeof address === 'object' ? address.port : config.port;
        console.log(`Home Base listening on http://${bindHost}:${activePort}`);
        if (config.homeBaseExecutionModeMissing) console.warn(`[homebase] ${EXECUTION_MODE_UPGRADE_HINT}`);
        if (typeof callback === 'function') callback();
      });
    },
  };
}

module.exports = {
  createApp,
};
