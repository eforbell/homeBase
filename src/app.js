const http = require('http');
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
const { JobRunner } = require('./services/job-runner');
const { runPreflightChecks } = require('./services/preflight');
const { renderHomePage, renderJobPage } = require('./ui');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
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

function createApp(config) {
  const stateStore = new SqliteStateStore(config.stateDbPath);
  stateStore.init();
  const jobRunner = new JobRunner(stateStore);
  const catalog = getCatalog();
  const validationErrors = catalog.flatMap((entry) =>
    validateManifestEntry(entry).map((error) => `${entry.id}: ${error}`)
  );

  if (validationErrors.length) {
    throw new Error(`Catalog validation failed:\n${validationErrors.join('\n')}`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method || 'GET';
      const state = stateStore.loadState();
      const preflight = runPreflightChecks();
      const viewState = { ...state, preflight };

      if (method === 'GET' && pathname === '/') {
        return sendHtml(res, 200, renderHomePage({ catalog, state: viewState, config }));
      }
      const jobPageMatch = pathname.match(/^\/jobs\/(\d+)$/);
      if (method === 'GET' && jobPageMatch) {
        const job = stateStore.getJob(Number(jobPageMatch[1]));
        if (!job) return notFound(res);
        return sendHtml(res, 200, renderJobPage({ job, appName: config.appName }));
      }
      if (method === 'GET' && pathname === '/api/catalog') {
        return sendJson(res, 200, { apps: catalog });
      }
      if (method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, viewState);
      }
      if (method === 'GET' && pathname === '/api/preflight') {
        return sendJson(res, 200, preflight);
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
      if (method === 'GET' && pathname === '/api/homebase/status') {
        return sendJson(res, 200, getHomeBaseStatus(config));
      }
      if (method === 'GET' && pathname === '/api/homebase/health') {
        return sendJson(res, 200, {
          status: 'ok',
          timestamp: new Date().toISOString(),
          homebase: getHomeBaseStatus(config),
        });
      }
      if (method === 'POST' && pathname === '/api/homebase/runtime-plan') {
        const body = await parseBody(req);
        return sendJson(res, 200, buildHomeBaseRuntimePlan(config, body));
      }
      if (method === 'POST' && pathname === '/api/homebase/install-self') {
        const body = await parseBody(req);
        if (body.dryRun === false && body.confirm !== 'EXECUTE') {
          return sendJson(res, 400, {
            error: 'Real execution requires confirm=EXECUTE',
          });
        }
        if (body.dryRun === false) {
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'systemd', 'node']);
          if (missing.length) {
            return sendJson(res, 409, {
              error: `Preflight checks must pass before Home Base self-install: ${missing.join(', ')}`,
              missing,
            });
          }
        }
        const plan = buildHomeBaseRuntimePlan(config, body);
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
          serviceUser: body.serviceUser || config.serviceUser,
          baseInstallDir: body.baseInstallDir || config.baseInstallDir,
          baseBackupDir: body.baseBackupDir || config.baseBackupDir,
          baseConfigDir: config.baseConfigDir,
        });
        stateStore.addBootstrapPlan({
          generatedAt: plan.generatedAt,
          serviceUser: body.serviceUser || config.serviceUser,
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
          serviceUser: body.serviceUser || config.serviceUser,
          baseInstallDir: body.baseInstallDir || config.baseInstallDir,
          baseBackupDir: body.baseBackupDir || config.baseBackupDir,
          baseConfigDir: config.baseConfigDir,
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

      const installPlanMatch = pathname.match(/^\/api\/apps\/([^/]+)\/install-plan$/);
      if (method === 'POST' && installPlanMatch) {
        const body = await parseBody(req);
        const plan = buildInstallPlan({ appId: installPlanMatch[1], state, options: body, config });
        return sendJson(res, 200, plan);
      }

      const installMatch = pathname.match(/^\/api\/apps\/([^/]+)\/install$/);
      if (method === 'POST' && installMatch) {
        const body = await parseBody(req);
        const appId = installMatch[1];
        const plan = buildInstallPlan({ appId, state, options: body, config });
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
          const app = getAppById(executeInstallMatch[1]);
          const required = ['os', 'sudo', 'systemd', 'git', 'psql', 'nginx', 'postgres-service', 'nginx-config'];
          if (app?.runtime?.kind === 'node') required.push('node');
          if (app?.runtime?.kind === 'python') required.push('python3');
          const missing = missingCheckIds(preflight, required);
          if (missing.length) {
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real install execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }

        const appId = executeInstallMatch[1];
        const plan = buildInstallPlan({ appId, state, options: body, config });
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
      const backupPlanMatch = pathname.match(/^\/api\/apps\/([^/]+)\/backup-plan$/);
      if (method === 'POST' && backupPlanMatch) {
        const plan = buildBackupPlan({ appId: backupPlanMatch[1], state, config });
        return sendJson(res, 200, plan);
      }
      const backupListMatch = pathname.match(/^\/api\/apps\/([^/]+)\/backups$/);
      if (method === 'GET' && backupListMatch) {
        const appId = backupListMatch[1];
        const dbBackups = stateStore.listBackups(appId);
        if (dbBackups.length) {
          return sendJson(res, 200, {
            app: getAppById(appId) ? { id: getAppById(appId).id, name: getAppById(appId).name } : { id: appId, name: appId },
            backupRoot: `${(config.baseBackupDir || '/var/lib/sovereign-home/backups').replace(/\/$/, '')}/${appId}`,
            backups: dbBackups.map((record) => ({
              name: record.archiveDir.split('/').pop(),
              archiveDir: record.archiveDir,
              generatedAt: record.generatedAt,
              status: record.status,
              includedFiles: record.includedFiles,
            })),
          });
        }
        return sendJson(res, 200, listBackupsFromDisk({ appId, config }));
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
          const missing = missingCheckIds(preflight, ['os', 'sudo', 'psql']);
          if (missing.length) {
            return sendJson(res, 409, {
              error: `Preflight checks must pass before real backup execution: ${missing.join(', ')}`,
              missing,
            });
          }
        }
        const plan = buildBackupPlan({ appId: backupExecuteMatch[1], state, config });
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
          config,
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
          config,
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

      return notFound(res);
    } catch (error) {
      return sendJson(res, error.code === 'APP_NOT_FOUND' ? 404 : 500, {
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
