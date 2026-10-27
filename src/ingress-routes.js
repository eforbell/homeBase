const { getAdminStatus, requireAdminForExecute } = require('./admin-auth');
const { getExecutorCapabilities, canExecuteMutations } = require('./executor/capabilities');
const { createIngressControl, currentIngress, setupSheet } = require('./services/ingress-control');
const { createTailscaleApi } = require('./services/tailscale-api');
const { appsInTailnetMode } = require('./operations/compilers/ingress');

// Feature-10 SID-001 admin routes: cut the host over to socket ingress, confirm or verify each service's
// hosts (D23), publish services one at a time, and roll back. Every change runs as a typed executor action;
// these routes only decide whether to ask.
//
//   GET  /api/ingress                          status per service (administrator only)
//   POST /api/ingress/cutover                  { confirm: 'CUTOVER' }
//   POST /api/ingress/services/:key/confirm    { hostNodeId }  (no API credential: the console check)
//   POST /api/ingress/services/:key/publish    { confirm: 'PUBLISH' }
//   POST /api/ingress/rollback                 { confirm: 'ROLLBACK' }

const API_RECHECK_MS = 60_000;

function createIngressRoutes({
  stateStore, jobRunner, sendJson, parseBody, recordAdminAudit, executionBlockOutcome,
  controlFactory = createIngressControl, apiFactory = createTailscaleApi, now = Date.now,
  adminStatus = getAdminStatus, requireAdmin = requireAdminForExecute, executorCapabilities = getExecutorCapabilities,
}) {
  // One API client per process, so its access token is reused; a credential added later is picked up.
  let api = null;
  let apiCheckedAt = -Infinity;
  let apiProblem = null;
  function apiFor(config) {
    if (!api && now() - apiCheckedAt > API_RECHECK_MS) {
      apiCheckedAt = now();
      try { api = apiFactory({ credentialPath: config.tailscaleApiCredentialPath }); apiProblem = null; } catch (error) { api = null; apiProblem = error.message; }
    }
    return api;
  }
  const controlFor = (config) => controlFactory({ config, api: apiFor(config) });

  // executes: false for a record that runs nothing on the host (a confirmation): an unlocked admin session is
  // enough, even on a plan-only host.
  async function authorize(req, res, config, { action, target, executes = true }) {
    const auth = await requireAdmin(req, stateStore, executes
      ? { privilegedJobsEnabled: config.homeBaseEnablePrivilegedJobs === true, executionModeMissing: config.homeBaseExecutionModeMissing === true }
      : { privilegedJobsEnabled: true });
    if (!auth.ok) {
      recordAdminAudit(stateStore, { action, target, dryRun: false, outcome: executionBlockOutcome(auth), reason: auth.payload?.error, sessionTokenHash: auth.sessionTokenHash });
      sendJson(res, auth.statusCode, auth.payload);
      return null;
    }
    return auth;
  }

  function refuse(res, { action, target, auth, statusCode = 409, error, code }) {
    recordAdminAudit(stateStore, { action, target, dryRun: false, outcome: 'blocked-policy', reason: error, sessionTokenHash: auth?.sessionTokenHash });
    return sendJson(res, statusCode, { error, code });
  }

  async function startAction(res, config, { auth, auditAction, target, kind, action, onComplete }) {
    if (config.homeBaseExecutionMode !== 'executor') return refuse(res, { action: auditAction, target, auth, error: 'Socket ingress changes run only through the root executor.', code: 'EXECUTOR_REQUIRED' });
    let capabilities;
    try { capabilities = await executorCapabilities(config.homeBaseExecutorSocket); } catch {
      return sendJson(res, 503, { error: 'Home Base executor is unavailable.', code: 'EXECUTOR_UNAVAILABLE' });
    }
    if (!canExecuteMutations(capabilities) || !capabilities.actions?.includes(action.action)) {
      return sendJson(res, 409, { error: `The executor does not support ${action.action} yet; update it with install.sh --repair.`, code: 'EXECUTOR_INCOMPATIBLE' });
    }
    let jobId = null;
    jobId = jobRunner.startTypedActionJob({ kind, target, action, onComplete: onComplete ? () => onComplete(jobId) : null });
    recordAdminAudit(stateStore, { action: auditAction, target, dryRun: false, outcome: 'queued', jobId, sessionTokenHash: auth?.sessionTokenHash });
    return sendJson(res, 202, { ok: true, jobId });
  }

  // Returns true when it handled the request.
  return async function handle({ req, res, method, pathname, config, state }) {
    if (!pathname.startsWith('/api/ingress')) return false;

    if (method === 'GET' && pathname === '/api/ingress') {
      const admin = await adminStatus(req, stateStore);
      if (!admin.unlocked) {
        sendJson(res, 401, { error: 'Admin unlock is required to see ingress status.' });
        return true;
      }
      const status = await controlFor(config).status();
      const installedAppIds = Object.keys(state.installations || {});
      const services = (status.services || []).map((entry) => ({ ...entry, installed: entry.key === 'home' || entry.key === 'homebase' || entry.apps.some((id) => installedAppIds.includes(id)) }));
      sendJson(res, 200, {
        ...status,
        services,
        cutOver: Boolean(currentIngress(state.jobs, config)),
        apiCredential: apiFor(config) ? 'configured' : (apiProblem ? `unusable: ${apiProblem}` : 'none'),
        setup: status.configured ? setupSheet({ instance: status.instance, services, installedAppIds, administratorLogin: config.administratorLogin }) : null,
      });
      return true;
    }

    if (method === 'POST' && pathname === '/api/ingress/cutover') {
      const body = await parseBody(req);
      const target = 'local-host';
      if (body.confirm !== 'CUTOVER') { sendJson(res, 400, { error: 'The ingress cutover requires confirm=CUTOVER.' }); return true; }
      const auth = await authorize(req, res, config, { action: 'ingress-cutover', target });
      if (!auth) return true;
      const control = controlFor(config);
      const setup = control.configured();
      if (!setup.ok) { refuse(res, { action: 'ingress-cutover', target, auth, error: `Cannot cut over: ${setup.problem}.`, code: 'INGRESS_NOT_CONFIGURED' }); return true; }
      const status = await control.status();
      if (!status.self?.tagged) { refuse(res, { action: 'ingress-cutover', target, auth, error: 'This host is user-owned (untagged); tag it with its own host tag before the cutover (D2, D14).', code: 'HOST_UNTAGGED' }); return true; }
      await startAction(res, config, {
        auth, auditAction: 'ingress-cutover', target, kind: 'ingress-cutover',
        action: { action: 'ingress-cutover', instance: status.instance, domain: status.domain, ...(status.legacyServicePresent ? { legacyService: status.legacyService } : {}) },
      });
      return true;
    }

    const confirmMatch = pathname.match(/^\/api\/ingress\/services\/([a-z0-9-]+)\/confirm$/);
    if (method === 'POST' && confirmMatch) {
      const body = await parseBody(req);
      const key = confirmMatch[1];
      const auth = await authorize(req, res, config, { action: 'ingress-confirm', target: key, executes: false });
      if (!auth) return true;
      if (apiFor(config)) { refuse(res, { action: 'ingress-confirm', target: key, auth, error: 'An API credential is configured, so service hosts are verified automatically.', code: 'CONFIRMATION_NOT_USED' }); return true; }
      try {
        const record = await controlFor(config).confirm(key, { hostNodeId: String(body.hostNodeId || ''), confirmedBy: config.administratorLogin || null });
        recordAdminAudit(stateStore, { action: 'ingress-confirm', target: record.service, dryRun: false, outcome: 'recorded', sessionTokenHash: auth.sessionTokenHash });
        sendJson(res, 200, { ok: true, confirmation: record });
      } catch (error) {
        refuse(res, { action: 'ingress-confirm', target: key, auth, statusCode: error.code === 'NOT_FOUND' ? 404 : 409, error: error.message, code: error.code });
      }
      return true;
    }

    const publishMatch = pathname.match(/^\/api\/ingress\/services\/([a-z0-9-]+)\/publish$/);
    if (method === 'POST' && publishMatch) {
      const body = await parseBody(req);
      const key = publishMatch[1];
      if (body.confirm !== 'PUBLISH') { sendJson(res, 400, { error: 'Publishing a service requires confirm=PUBLISH.' }); return true; }
      const auth = await authorize(req, res, config, { action: 'service-publish', target: key });
      if (!auth) return true;
      const control = controlFor(config);
      const { entry } = await control.service(key);
      if (!entry) { refuse(res, { action: 'service-publish', target: key, auth, statusCode: 404, error: `${key} is not a service this host can serve.`, code: 'NOT_FOUND' }); return true; }
      if (!entry.gates.publish.allowed) { refuse(res, { action: 'service-publish', target: entry.name, auth, error: `Cannot publish ${entry.name}: ${entry.gates.publish.reason}.`, code: 'SERVICE_GATE' }); return true; }
      await startAction(res, config, {
        auth, auditAction: 'service-publish', target: entry.name, kind: 'service-publish',
        action: { action: 'service-publish', serviceKey: key },
        // Certificates are issued on first use (35-40 s); warm it now so members never wait.
        onComplete: (jobId) => control.warmUp(key)
          .then((result) => stateStore.appendJobLog(jobId, `[ingress] certificate warm-up: ${result.detail}${result.ms != null ? ` after ${Math.round(result.ms / 1000)} s` : ''}\n`))
          .catch((error) => stateStore.appendJobLog(jobId, `[ingress] certificate warm-up failed: ${error.message}\n`)),
      });
      return true;
    }

    if (method === 'POST' && pathname === '/api/ingress/rollback') {
      const body = await parseBody(req);
      const target = 'local-host';
      if (body.confirm !== 'ROLLBACK') { sendJson(res, 400, { error: 'Rolling back ingress requires confirm=ROLLBACK.' }); return true; }
      const auth = await authorize(req, res, config, { action: 'ingress-rollback', target });
      if (!auth) return true;
      const trusting = appsInTailnetMode(state.installations);
      if (trusting.length) { refuse(res, { action: 'ingress-rollback', target, auth, error: `Return ${trusting.join(', ')} to local mode before restoring TCP ingress.`, code: 'APPS_IN_TAILNET_MODE' }); return true; }
      await startAction(res, config, { auth, auditAction: 'ingress-rollback', target, kind: 'ingress-rollback', action: { action: 'ingress-rollback' } });
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  };
}

module.exports = { createIngressRoutes };
