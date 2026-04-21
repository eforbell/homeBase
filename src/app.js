const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { getCatalog, getAppById } = require('./catalog');
const { manifestSchema, validateManifestEntry } = require('./manifest-schema');
const { SqliteStateStore } = require('./state/sqlite-store');
const { buildBootstrapPlan } = require('./services/bootstrap-planner');
const { buildInstallPlan } = require('./services/install-planner');
const { buildBackupPlan } = require('./services/backup-planner');
const { listBackupsFromDisk } = require('./services/backup-inventory');
const { buildRestorePlan } = require('./services/restore-planner');
const { buildHomeBaseRuntimePlan } = require('./services/homebase-runtime-planner');
const { buildHomeBaseUpdatePlan } = require('./services/homebase-update-planner');
const { JobRunner } = require('./services/job-runner');
const { runPreflightChecks } = require('./services/preflight');
const {
  mergeHomeBaseConfig,
  toClientHomeBaseConfig,
  validateHomeBaseConfigPatch,
} = require('./homebase-config');
const { scheduleAutoBootstrap } = require('./auto-bootstrap');
const { HealthMonitor } = require('./services/health-monitor');
const { HealthAlertNotifier } = require('./services/notifications');
const { normalizePathname } = require('./setup-gate');
const {
  getAdminStatus,
  setupAdmin,
  unlockAdmin,
  lockAdmin,
  rotateAdmin,
  requireAdminForExecute,
} = require('./admin-auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PUBLIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const ALLOWED_PUBLIC_EXTENSIONS = new Set(Object.keys(PUBLIC_MIME_TYPES));

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
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

function missingCheckIds(preflight, ids) {
  return ids.filter((id) => !preflight.checks.find((check) => check.id === id && check.ok));
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

function getHomeBaseStatus(config) {
  const fs = require('fs');
  const { spawnSync } = require('child_process');
  const runtimeUser = config.homeBaseRuntimeUser || 'homebase';
  const appDir = config.homeBaseAppDir || '/opt/sovereign-home/homebase';
  const stateDir = config.homeBaseStateDir || '/var/lib/sovereign-home/homebase';
  const envFile = config.homeBaseEnvFile || '/etc/sovereign-home/homebase.env';
  const stateDbPath = config.stateDbPath || `${stateDir}/home-base.sqlite3`;
  const serviceFile = '/etc/systemd/system/homebase.service';
  const sudoersFile = '/etc/sudoers.d/homebase';
  const status = {
    runtimeUser,
    appDir,
    stateDir,
    stateDbPath,
    envFile,
    serviceName: 'homebase',
    privilegedJobsEnabled: config.homeBaseEnablePrivilegedJobs !== false,
    paths: {
      appDirExists: fs.existsSync(appDir),
      stateDirExists: fs.existsSync(stateDir),
      stateDbExists: fs.existsSync(stateDbPath),
      envFileExists: fs.existsSync(envFile),
      serviceFileExists: fs.existsSync(serviceFile),
      sudoersFileExists: fs.existsSync(sudoersFile),
    },
  };

  const systemctl = spawnSync('/bin/bash', ['-lc', 'command -v systemctl >/dev/null 2>&1 && systemctl is-active homebase || true'], {
    encoding: 'utf8',
  });
  status.systemd = {
    active: (systemctl.stdout || '').trim() || 'unknown',
  };
  status.ok = true;
  return status;
}

function buildRestartPlan({ app, install }) {
  const serviceName = install?.serviceName || app?.service?.name;
  const readinessPath = app?.network?.health?.readinessPath || app?.network?.health?.livenessPath || '/api/health';
  const port = install?.port || app?.network?.preferredPort;
  const healthUrl = port ? `http://127.0.0.1:${port}${readinessPath}` : null;
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
    commands: [
      `sudo systemctl restart ${serviceName}`,
      healthUrl
        ? `for attempt in $(seq 1 20); do curl --fail --silent --show-error ${healthUrl} && exit 0; sleep 1; done; echo \"Timed out waiting for ${healthUrl}\" >&2; exit 1`
        : `echo \"Service restarted; no health URL configured for ${serviceName}\"`,
    ],
  };
}

function createApp(config) {
  const stateStore = new SqliteStateStore(config.stateDbPath);
  stateStore.init();
  const jobRunner = new JobRunner(stateStore);
  const catalog = getCatalog();
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  const preflightCache = {
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

  function getPreflight(effectiveConfig, { force = false } = {}) {
    const now = Date.now();
    const cacheKey = JSON.stringify({
      gitTransport: effectiveConfig.gitTransport || 'https',
      gitSshKeyPath: effectiveConfig.gitSshKeyPath || '',
      serviceUser: effectiveConfig.serviceUser || 'sovereign',
    });
    if (!force && preflightCache.value && preflightCache.key === cacheKey && preflightCache.expiresAt > now) {
      return preflightCache.value;
    }
    const value = runPreflightChecks(effectiveConfig);
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
        if (normalizedPath === '/settings') return servePublicPage(res, 'settings.html');
        if (/^\/apps\/[^/]+$/.test(normalizedPath)) return servePublicPage(res, 'app.html');
        if (/^\/jobs\/\d+$/.test(normalizedPath)) return servePublicPage(res, 'job.html');
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
      if (method === 'POST' && pathname === '/api/alerts/test') {
        try {
          await healthAlertNotifier.sendTestAlert(effectiveConfig);
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, error.code ? 409 : 500, { error: error.message || 'Unable to send test alert' });
        }
      }
      if (method === 'GET' && pathname === '/api/preflight') {
        return sendJson(res, 200, getPreflight(effectiveConfig, {
          force: url.searchParams.get('refresh') === '1',
        }));
      }
      if (method === 'GET' && pathname === '/api/jobs') {
        return sendJson(res, 200, { jobs: state.jobs || [] });
      }
      const jobMatch = pathname.match(/^\/api\/jobs\/(\d+)$/);
      if (method === 'GET' && jobMatch) {
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
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          return sendJson(res, 400, { error: 'Real execution requires confirm=EXECUTE' });
        }
        if (body.dryRun === false) {
          const auth = await requireAdminForExecute(req, stateStore);
          if (!auth.ok) return sendJson(res, auth.statusCode, auth.payload);
        }
        const plan = buildHomeBaseUpdatePlan(effectiveConfig, body);
        const jobId = jobRunner.startHomeBaseUpdateJob(plan, {
          dryRun: body.dryRun !== false,
        });
        return sendJson(res, 202, { ok: true, jobId, dryRun: body.dryRun !== false });
      }
      if (method === 'POST' && pathname === '/api/homebase/install-self') {
        const body = await parseBody(req);
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          const auth = await requireAdminForExecute(req, stateStore);
          if (!auth.ok) return sendJson(res, auth.statusCode, auth.payload);
        }
        if (body.dryRun === false) {
          const preflight = getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'systemd', 'node']);
          if (missing.length) {
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
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          const auth = await requireAdminForExecute(req, stateStore);
          if (!auth.ok) return sendJson(res, auth.statusCode, auth.payload);
        }
        if (body.dryRun === false) {
          const preflight = getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'systemd']);
          if (missing.length) {
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
        return sendJson(res, 202, {
          ok: true,
          jobId,
          dryRun: body.dryRun !== false,
        });
      }

      const appActionsMatch = pathname.match(/^\/api\/apps\/([^/]+)\/actions$/);
      if (method === 'GET' && appActionsMatch) {
        const appId = appActionsMatch[1];
        if (!getAppById(appId)) return notFound(res);
        const installation = (state.installations || {})[appId] || null;
        return sendJson(res, 200, {
          appId,
          actions: {
            install: true,
            backup: true,
            restore: true,
            update: false,
            restart: Boolean(installation),
          },
          note: 'Update is not a separate API action yet; use install execute for deploy operations.',
        });
      }

      const installPlanMatch = pathname.match(/^\/api\/apps\/([^/]+)\/install-plan$/);
      if (method === 'POST' && installPlanMatch) {
        const body = await parseBody(req);
        const plan = buildInstallPlan({ appId: installPlanMatch[1], state, options: body, config: effectiveConfig });
        return sendJson(res, 200, plan);
      }

      const installMatch = pathname.match(/^\/api\/apps\/([^/]+)\/install$/);
      if (method === 'POST' && installMatch) {
        const body = await parseBody(req);
        const appId = installMatch[1];
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
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          const auth = await requireAdminForExecute(req, stateStore);
          if (!auth.ok) return sendJson(res, auth.statusCode, auth.payload);
        }
        if (body.dryRun === false) {
          const app = getAppById(executeInstallMatch[1]);
          const required = ['os', 'sudo', 'systemd', 'git', 'psql', 'nginx', 'postgres-service', 'nginx-config'];
          if (app?.runtime?.kind === 'node') required.push('node');
          if (app?.runtime?.kind === 'python') required.push('python3');
          const preflight = getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, required);
          if (missing.length) {
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real install execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }

        const appId = executeInstallMatch[1];
        const plan = buildInstallPlan({ appId, state, options: body, config: effectiveConfig });
        const jobId = jobRunner.startInstallJob(plan, {
          dryRun: body.dryRun !== false,
        });
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
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          const auth = await requireAdminForExecute(req, stateStore);
          if (!auth.ok) return sendJson(res, auth.statusCode, auth.payload);
        }
        const appId = restartExecuteMatch[1];
        const app = getAppById(appId);
        if (!app) return notFound(res);
        const install = (state.installations || {})[appId];
        if (!install) {
          return sendJson(res, 409, {
            error: `App ${appId} must be installed before restart is available.`,
          });
        }
        if (body.dryRun === false) {
          const preflight = getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'systemd']);
          if (missing.length) {
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real restart execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }
        const plan = buildRestartPlan({ app, install });
        const jobId = jobRunner.startRestartJob(plan, {
          dryRun: body.dryRun !== false,
        });
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
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          const auth = await requireAdminForExecute(req, stateStore);
          if (!auth.ok) return sendJson(res, auth.statusCode, auth.payload);
        }
        if (body.dryRun === false) {
          const preflight = getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'psql']);
          if (missing.length) {
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real backup execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }
        const plan = buildBackupPlan({ appId: backupExecuteMatch[1], state, config: effectiveConfig });
        const jobId = jobRunner.startBackupJob(plan, {
          dryRun: body.dryRun !== false,
        });
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
      const restoreExecuteMatch = pathname.match(/^\/api\/apps\/([^/]+)\/restore\/execute$/);
      if (method === 'POST' && restoreExecuteMatch) {
        const body = await parseBody(req);
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          const auth = await requireAdminForExecute(req, stateStore);
          if (!auth.ok) return sendJson(res, auth.statusCode, auth.payload);
        }
        if (body.dryRun === false) {
          const preflight = getPreflight(effectiveConfig, { force: true });
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'psql']);
          if (missing.length) {
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real restore execution: ${missing.join(', ')}`,
              missing,
            });
          }
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
        INVALID_GIT_REF: 400,
        GIT_SSH_KEY_PATH_REQUIRED: 400,
      };
      return sendJson(res, statusByCode[error.code] || 500, {
        error: error.message || 'Unexpected error',
      });
    }
  });

  return {
    server,
    listen() {
      server.listen(config.port, () => {
        console.log(`Home Base listening on http://127.0.0.1:${config.port}`);
      });
    },
  };
}

module.exports = {
  createApp,
};
