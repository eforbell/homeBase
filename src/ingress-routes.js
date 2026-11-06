const { getAdminStatus, requireAdminForExecute } = require('./admin-auth');
const { getExecutorCapabilities, canExecuteMutations } = require('./executor/capabilities');
const { createIngressControl, currentIngress, setupSheet } = require('./services/ingress-control');
const { HOMEBASE_SERVICE } = require('./operations/ingress-layout');
const { createTailscaleApi } = require('./services/tailscale-api');
const { appsInTailnetMode } = require('./operations/compilers/ingress');
const { getAppById } = require('./catalog');

// Feature-10 SID-001 admin routes: cut the host over to socket ingress, confirm or verify each service's
// hosts (D23), publish services one at a time, and roll back. Every change runs as a typed executor action;
// these routes only decide whether to ask.
//
//   GET  /api/ingress                          status per service (administrator only)
//   POST /api/ingress/cutover                  { confirm: 'CUTOVER' }
//   POST /api/ingress/services/:key/confirm    { hostNodeId }  (no API credential: the console check)
//   POST /api/ingress/services/:key/publish    { confirm: 'PUBLISH' }
//   POST /api/ingress/rollback                 { confirm: 'ROLLBACK' }
//   POST /api/ingress/apps/:id/tailnet-mode    { confirm: 'TAILNET' }  (SID-007: the app trusts the directory)
//   POST /api/ingress/apps/:id/local-mode      { confirm: 'LOCAL' }    (back to the app's own sign-in)
//
// handle.checkServices() is D23's daily check: an approval added after a publish shows up within a day.

const API_RECHECK_MS = 60_000;

function createIngressRoutes({
  stateStore, jobRunner, sendJson, parseBody, recordAdminAudit, executionBlockOutcome,
  controlFactory = createIngressControl, apiFactory = createTailscaleApi, now = Date.now,
  adminStatus = getAdminStatus, requireAdmin = requireAdminForExecute, executorCapabilities = getExecutorCapabilities,
  homeBaseOnSocket = () => false, appBlock = () => null, lifecycleState = () => 'none',
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
  // A credential that exists but can't be loaded fails closed: no automatic check, and no confirmations.
  // The household directory's state decides what may be published and what may enter tailnet mode (D16, D23).
  const controlFor = (config) => { const client = apiFor(config); return controlFactory({ config, api: client, apiProblem: client ? null : apiProblem, lifecycleState }); };

  // executes: false for a record that runs nothing on the host (a confirmation): an unlocked admin session is
  // enough, even on a plan-only host. duringBootstrap: allowed while the household directory is in setup,
  // which needs the cutover and Home Base's own service (runbook 2.5); everything else waits for active.
  async function authorize(req, res, config, { action, target, executes = true, duringBootstrap = false }) {
    // What was authorized depends on the state (setup takes the passphrase, active the hardware key), so a request
    // starts only if the state is the same when it starts (startAction).
    const lifecycle = lifecycleState();
    const auth = await requireAdmin(req, stateStore, executes
      ? { privilegedJobsEnabled: config.homeBaseEnablePrivilegedJobs === true, executionModeMissing: config.homeBaseExecutionModeMissing === true, duringBootstrap }
      : { privilegedJobsEnabled: true, duringBootstrap });
    if (!auth.ok) {
      recordAdminAudit(stateStore, { action, target, dryRun: false, outcome: executionBlockOutcome(auth), reason: auth.payload?.error, sessionTokenHash: auth.sessionTokenHash });
      sendJson(res, auth.statusCode, auth.payload);
      return null;
    }
    return { ...auth, lifecycle };
  }

  function refuse(res, { action, target, auth, statusCode = 409, error, code }) {
    recordAdminAudit(stateStore, { action, target, dryRun: false, outcome: 'blocked-policy', reason: error, sessionTokenHash: auth?.sessionTokenHash });
    return sendJson(res, statusCode, { error, code });
  }

  // beforeStart runs synchronously right before the job starts; if it throws, nothing starts.
  async function startAction(res, config, { auth, auditAction, target, kind, action, onComplete, beforeStart }) {
    if (config.homeBaseExecutionMode !== 'executor') return refuse(res, { action: auditAction, target, auth, error: 'Socket ingress changes run only through the root executor.', code: 'EXECUTOR_REQUIRED' });
    let capabilities;
    try { capabilities = await executorCapabilities(config.homeBaseExecutorSocket); } catch {
      return sendJson(res, 503, { error: 'Home Base executor is unavailable.', code: 'EXECUTOR_UNAVAILABLE' });
    }
    if (!canExecuteMutations(capabilities) || !capabilities.actions?.includes(action.action)) {
      return sendJson(res, 409, { error: `The executor does not support ${action.action} yet; update it with install.sh --repair.`, code: 'EXECUTOR_INCOMPATIBLE' });
    }
    // Everything above waits (the admin check, Tailscale, the executor); Home Base may have been activated or
    // entered recovery meanwhile, and what authorized this request may no longer be enough. Checked last, with no
    // wait before the job starts.
    if (auth?.lifecycle !== undefined && lifecycleState() !== auth.lifecycle) {
      return refuse(res, { action: auditAction, target, auth, error: `Not started: Home Base moved from ${auth.lifecycle} to ${lifecycleState()} while this request was checked; try again.`, code: 'STATE_CHANGED' });
    }
    if (beforeStart) {
      try { beforeStart(); } catch (error) { return refuse(res, { action: auditAction, target, auth, error: `Not started: ${error.message}.`, code: error.code || 'NOT_STARTED' }); }
    }
    let jobId = null;
    jobId = jobRunner.startTypedActionJob({ kind, target, action, onComplete: onComplete ? () => onComplete(jobId) : null });
    recordAdminAudit(stateStore, { action: auditAction, target, dryRun: false, outcome: 'queued', jobId, sessionTokenHash: auth?.sessionTokenHash });
    return sendJson(res, 202, { ok: true, jobId });
  }

  // Every published service must still be verified (or confirmed and in date). Null when not cut over.
  let lastCheck = null;
  async function checkServices(config, state) {
    if (!currentIngress(state.ingressJobs, config)) return null;
    const status = await controlFor(config).status();
    const problems = (status.services || [])
      .filter((entry) => entry.published && !['verified', 'confirmed'].includes(entry.verification?.state))
      .map((entry) => ({ service: entry.name, reason: entry.verification?.reason || null, detail: entry.verification?.detail || 'not verified' }));
    if (!status.configured) problems.push({ service: null, reason: 'not-configured', detail: status.problem });
    // Without Serve's config (or this host's identity) nothing looks published, so the check is incomplete,
    // never clean.
    for (const error of status.errors || []) problems.push({ service: null, reason: 'check-incomplete', detail: `the check could not finish: ${error}` });
    const homebase = (status.services || []).find((entry) => entry.key === 'homebase');
    lastCheck = { checkedAt: new Date(now()).toISOString(), problems, errors: status.errors || [], networkUrl: homebase ? `https://${homebase.hostname}/network` : null };
    return lastCheck;
  }

  // Returns true when it handled the request.
  async function handle({ req, res, method, pathname, config, state }) {
    if (!pathname.startsWith('/api/ingress')) return false;

    if (method === 'GET' && pathname === '/api/ingress') {
      const admin = await adminStatus(req, stateStore);
      if (!admin.unlocked) {
        sendJson(res, 401, { error: 'Admin unlock is required to see ingress status.' });
        return true;
      }
      const status = await controlFor(config).status();
      const installedAppIds = Object.keys(state.installations || {});
      const services = (status.services || []).map((entry) => ({
        ...entry,
        installed: entry.key === 'home' || entry.key === 'homebase' || entry.apps.some((id) => installedAppIds.includes(id)),
        // SID-007: which identity each installed app on the service trusts, and whether it can trust the directory.
        identity: entry.apps.filter((id) => installedAppIds.includes(id)).map((id) => ({
          appId: id,
          name: getAppById(id)?.name || id,
          mode: state.installations[id].identityMode === 'tailnet' ? 'tailnet' : 'local',
          supportsTailnet: getAppById(id)?.runtime?.identity === 'tailnet',
        })),
      }));
      sendJson(res, 200, {
        ...status,
        services,
        cutOver: Boolean(currentIngress(state.ingressJobs, config)),
        // SID-006: where nginx, as it runs, reaches Home Base ('socket', or 'tcp' on a host cut over before
        // it), and what the loopback port does once it is the socket.
        homeBase: currentIngress(state.ingressJobs, config) ? (homeBaseOnSocket() ? 'socket' : 'tcp') : null,
        loopback: config.loopback === 'off' ? 'off' : 'redirect',
        apiCredential: apiFor(config) ? 'configured' : (apiProblem ? `unusable: ${apiProblem}` : 'none'),
        dailyCheck: lastCheck,
        setup: status.configured ? setupSheet({ instance: status.instance, services, installedAppIds, administratorLogin: config.administratorLogin }) : null,
      });
      return true;
    }

    if (method === 'POST' && pathname === '/api/ingress/cutover') {
      const body = await parseBody(req);
      const target = 'local-host';
      if (body.confirm !== 'CUTOVER') { sendJson(res, 400, { error: 'The ingress cutover requires confirm=CUTOVER.' }); return true; }
      const auth = await authorize(req, res, config, { action: 'ingress-cutover', target, duringBootstrap: true });
      if (!auth) return true;
      const control = controlFor(config);
      const setup = control.configured();
      if (!setup.ok) { refuse(res, { action: 'ingress-cutover', target, auth, error: `Cannot cut over: ${setup.problem}.`, code: 'INGRESS_NOT_CONFIGURED' }); return true; }
      const status = await control.status();
      if (!status.self?.tagged) { refuse(res, { action: 'ingress-cutover', target, auth, error: 'This host is user-owned (untagged); tag it with its own host tag before the cutover (D2, D14).', code: 'HOST_UNTAGGED' }); return true; }
      // Moving Home Base retires :3080, so the address that replaces it has to answer first (bugBase #157). With an
      // API credential Home Base asks that address itself; without one, the administrator has opened it.
      const moveHomeBase = body.moveHomeBase === true;
      if (moveHomeBase) {
        const entry = (status.services || []).find((candidate) => candidate.key === HOMEBASE_SERVICE);
        const notYet = (error, code) => refuse(res, { action: 'ingress-cutover', target, auth, error, code });
        if (!currentIngress(state.ingressJobs, config)) { notYet('Run the cutover first: Home Base can only move to its socket after it.', 'NOT_CUT_OVER'); return true; }
        if (!entry?.published) { notYet(`Publish ${entry?.name || 'Home Base\'s service'} first: port 3080 stays until the address that replaces it answers.`, 'HOMEBASE_NOT_PUBLISHED'); return true; }
        const reached = await control.warmUp(HOMEBASE_SERVICE);
        if (reached.skipped) {
          if (body.reachedConfirmed !== true) { notYet(`Open https://${entry.hostname}/ and check that it loads first: port 3080 stays until it does.`, 'HOMEBASE_NOT_CONFIRMED'); return true; }
        } else if (!reached.ok) {
          notYet(`Home Base's new address doesn't answer yet, so port 3080 stays: ${reached.detail}. Check that this host is approved for ${entry.name} in the Tailscale console, then try again.`, 'HOMEBASE_UNREACHABLE');
          return true;
        }
      }
      await startAction(res, config, {
        auth, auditAction: 'ingress-cutover', target, kind: 'ingress-cutover',
        action: { action: 'ingress-cutover', instance: status.instance, domain: status.domain, ...(status.legacyServicePresent ? { legacyService: status.legacyService } : {}), ...(moveHomeBase ? { moveHomeBase: true } : {}) },
      });
      return true;
    }

    const confirmMatch = pathname.match(/^\/api\/ingress\/services\/([a-z0-9-]+)\/confirm$/);
    if (method === 'POST' && confirmMatch) {
      const body = await parseBody(req);
      const key = confirmMatch[1];
      const auth = await authorize(req, res, config, { action: 'ingress-confirm', target: key, executes: false, duringBootstrap: key === 'homebase' });
      if (!auth) return true;
      if (apiFor(config) || apiProblem) { refuse(res, { action: 'ingress-confirm', target: key, auth, error: apiProblem ? `The Tailscale API credential is configured but unusable (${apiProblem}); fix it, or remove it to confirm hosts by hand.` : 'An API credential is configured, so service hosts are verified automatically.', code: 'CONFIRMATION_NOT_USED' }); return true; }
      try {
        // In active Home Base this route is a privileged plan, so the administrator taps their hardware key for it
        // (route matrix). Recorded from that proof, never from the state now: one authorized in setup may finish
        // after activation.
        const assurance = auth.confirmation ? 'hardware-key' : 'passphrase-session';
        const record = await controlFor(config).confirm(key, { hostNodeId: String(body.hostNodeId || ''), confirmedBy: config.administratorLogin || null, assurance });
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
      const auth = await authorize(req, res, config, { action: 'service-publish', target: key, duringBootstrap: key === 'homebase' });
      if (!auth) return true;
      const control = controlFor(config);
      const { all, entry } = await control.service(key);
      if (!entry) { refuse(res, { action: 'service-publish', target: key, auth, statusCode: 404, error: `${key} is not a service this host can serve.`, code: 'NOT_FOUND' }); return true; }
      // The gate below was decided in this state; startAction checks it is still the one authorized.
      if (all.lifecycleState !== auth.lifecycle) { refuse(res, { action: 'service-publish', target: entry.name, auth, error: 'Not started: Home Base changed state while this request was checked; try again.', code: 'STATE_CHANGED' }); return true; }
      if (!entry.gates.publish.allowed) { refuse(res, { action: 'service-publish', target: entry.name, auth, error: `Cannot publish ${entry.name}: ${entry.gates.publish.reason}.`, code: 'SERVICE_GATE' }); return true; }
      await startAction(res, config, {
        auth, auditAction: 'service-publish', target: entry.name, kind: 'service-publish',
        action: { action: 'service-publish', serviceKey: key },
        beforeStart: entry.verification.state === 'confirmed' ? () => control.claimConfirmation(key, entry.verification.confirmedAt) : null,
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

    // SID-007: an installed app trusts members' tailnet identity, or goes back to its own sign-in. Tailnet mode
    // needs the app's support, the cutover, a tagged host, and its service published and verified (D23) with
    // Home Base active; the executor checks the app, its socket, the cutover and the snapshot again.
    const tailnetMatch = pathname.match(/^\/api\/ingress\/apps\/([^/]+)\/tailnet-mode$/);
    const localMatch = pathname.match(/^\/api\/ingress\/apps\/([^/]+)\/local-mode$/);
    if (method === 'POST' && (tailnetMatch || localMatch)) {
      const body = await parseBody(req);
      const appId = (tailnetMatch || localMatch)[1];
      const mode = tailnetMatch ? 'tailnet' : 'local';
      const app = getAppById(appId);
      if (!app) { sendJson(res, 404, { error: 'Not found' }); return true; }
      const word = mode === 'tailnet' ? 'TAILNET' : 'LOCAL';
      if (body.confirm !== word) { sendJson(res, 400, { error: `Changing ${app.name}'s identity mode requires confirm=${word}.` }); return true; }
      const auditAction = `app-${mode}-mode`;
      const auth = await authorize(req, res, config, { action: auditAction, target: appId });
      if (!auth) return true;
      const blocked = appBlock(config, state, appId);
      if (blocked) { refuse(res, { action: auditAction, target: appId, auth, error: blocked.error, code: blocked.code }); return true; }
      let beforeStart = null;
      if (mode === 'tailnet') {
        const cannot = (reason, code) => refuse(res, { action: auditAction, target: appId, auth, error: `${app.name} can't trust tailnet identity: ${reason}.`, code });
        if (app.runtime?.identity !== 'tailnet') { cannot('this version does not support it', 'TAILNET_UNSUPPORTED'); return true; }
        if (!currentIngress(state.ingressJobs, config)) { cannot('this host is not cut over to socket ingress', 'NOT_CUT_OVER'); return true; }
        const status = await controlFor(config).status();
        if (status.lifecycleState !== auth.lifecycle) { cannot('Home Base changed state while this request was checked; try again', 'STATE_CHANGED'); return true; }
        if (!status.self?.tagged) { cannot('this host is user-owned (untagged) (D2)', 'HOST_UNTAGGED'); return true; }
        const entry = (status.services || []).find((candidate) => candidate.apps.includes(appId));
        if (!entry) { cannot('no service on this host serves it', 'NOT_FOUND'); return true; }
        if (!entry.published) { cannot(`${entry.name} is not published yet`, 'SERVICE_NOT_PUBLISHED'); return true; }
        if (!entry.gates.tailnetMode.allowed) { cannot(entry.gates.tailnetMode.reason, 'SERVICE_GATE'); return true; }
        // Recorded before the switch starts, so an ingress rollback is refused from that moment, even if the
        // switch fails part way; switching back to local clears it.
        // The checks above wait on Tailscale; Home Base may have entered recovery meanwhile, so check again last.
        beforeStart = () => {
          const now = lifecycleState();
          if (now !== 'active') throw Object.assign(new Error(`Home Base is in ${now}; apps enter tailnet mode only once it is active`), { code: 'SERVICE_GATE' });
          stateStore.setIdentityMode(appId, 'tailnet');
        };
      }
      await startAction(res, config, { auth, auditAction, target: appId, kind: 'identity-mode', action: { action: 'identity-mode', appId, mode }, beforeStart });
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  }
  handle.checkServices = checkServices;
  return handle;
}

module.exports = { createIngressRoutes };
