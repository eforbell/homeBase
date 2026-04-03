const http = require('http');
const { URL } = require('url');
const { getCatalog, getAppById } = require('./catalog');
const { manifestSchema, validateManifestEntry } = require('./manifest-schema');
const { SqliteStateStore } = require('./state/sqlite-store');
const { buildBootstrapPlan } = require('./services/bootstrap-planner');
const { buildInstallPlan } = require('./services/install-planner');
const { JobRunner } = require('./services/job-runner');
const { renderHomePage } = require('./ui');

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

      if (method === 'GET' && pathname === '/') {
        return sendHtml(res, 200, renderHomePage({ catalog, state, config }));
      }
      if (method === 'GET' && pathname === '/api/catalog') {
        return sendJson(res, 200, { apps: catalog });
      }
      if (method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, state);
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
