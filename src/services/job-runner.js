const crypto = require('crypto');
const { spawn } = require('child_process');
const { runAction, planAction, actionStatus } = require('../executor/client');
const { buildExecutorInstallRecord } = require('./executor-install');
const { getAppById } = require('../catalog');
const { BACKUP_ROOT } = require('../operations/paths');
const { redactText } = require('../operations/redact');
const { digestOperationPlan } = require('../operations/digest');

function appendExecutorEventLog(stateStore, jobId, event, secretBindings = {}) {
  const operation = event.operationId ? ` ${event.operationId}` : '';
  stateStore.appendJobLog(jobId, `[executor] ${event.eventType}${operation}\n`);
  if (typeof event.output !== 'string' || !event.output.trim()) return;
  const output = redactText(event.output, Object.values(secretBindings));
  const truncated = event.truncated === true ? ' (truncated)' : '';
  stateStore.appendJobLog(jobId, `[executor] diagnostic output${operation}${truncated}:\n${output.trim()}\n`);
}

// Readiness is probed only on loopback, at the catalog's port and readiness path.
async function waitForAppReadiness({ app, fetchImpl = global.fetch, attempts = 30, delayMs = 1000 } = {}) {
  const port = app?.network?.preferredPort;
  const readinessPath = app?.network?.health?.readinessPath;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/[A-Za-z0-9/_-]*$/.test(readinessPath || '')) {
    throw Object.assign(new Error(`${app?.name || 'App'} has no usable readiness endpoint.`), { code: 'READINESS_FAILED' });
  }
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}${readinessPath}`);
      if (response.ok) return;
      lastError = new Error(`readiness returned HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const error = new Error(`${app.name} readiness failed: ${lastError?.message || 'unknown error'}`);
  error.code = 'READINESS_FAILED';
  throw error;
}

// Connection-level failures, as opposed to a terminal error the executor reported with a code.
function isTransportError(error) {
  return !error.code || ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOENT'].includes(error.code);
}

function parsePlanJson(planJson) {
  try { return JSON.parse(planJson || 'null'); } catch { return null; }
}

class JobRunner {
  constructor(stateStore, { executorSocket = '/run/homebase/executor.sock', runExecutorAction = runAction, planExecutorAction = planAction, executorActionStatus = actionStatus, busyRetry = { attempts: 6, delayMs: 10_000 }, reconcile = { intervalMs: 15_000, maxWaitMs: 3 * 60 * 60 * 1000 }, readinessOptions = {} } = {}) {
    this.stateStore = stateStore;
    this.executorSocket = executorSocket;
    this.runExecutorAction = runExecutorAction;
    this.planExecutorAction = planExecutorAction;
    this.executorActionStatus = executorActionStatus;
    this.reconcile = reconcile;
    this.readinessOptions = readinessOptions;
    this.busyRetry = busyRetry;
  }

  reconcileStaleUpdateJobs() {
    const jobs = this.stateStore.listRunningJobsByKind('homebase-update');
    for (const job of jobs) {
      if (job.dryRun) continue;
      if (job.currentStep !== 'restart-service') continue;
      if (!String(job.log || '').includes('systemctl restart homebase')) continue;

      this.stateStore.appendJobLog(job.id, '\n[reconcile] Home Base restarted successfully; marking update job completed during startup.\n');
      this.stateStore.updateJob(job.id, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        resultJson: JSON.stringify({
          dryRun: false,
          reconciledAfterRestart: true,
        }),
      });
    }
  }

  startBootstrapJob(plan, { dryRun = true } = {}) {
    return this.startPlanJob({
      kind: 'bootstrap',
      target: 'local-host',
      plan,
      steps: plan.steps,
      dryRun,
    });
  }

  startInstallJob(plan, { dryRun = true, onComplete = null } = {}) {
    return this.startPlanJob({
      kind: 'install',
      target: plan.app.id,
      plan,
      steps: plan.executionSteps || [],
      dryRun,
      onComplete: () => {
        // A dry-run must never downgrade a real installation to "planned": that status hides the
        // app's update/restart/uninstall actions and makes its record discardable.
        const existing = (this.stateStore.loadState().installations || {})[plan.app.id];
        if (dryRun && existing && existing.status !== 'planned') return;
        this.stateStore.upsertInstallation({
          ...plan.stateRecord,
          updatedAt: new Date().toISOString(),
          status: dryRun ? 'planned' : 'installed',
        });
        if (typeof onComplete === 'function') onComplete();
      },
    });
  }

  // Typed jobs name an action; the executor compiles the plan, generates any secrets, and streams
  // the accepted plan back so the job records exactly what ran. No plan or secret leaves Home Base.
  startTypedActionJob({ kind, target, action, onComplete = null }) {
    // The nonce is persisted before anything is sent, so reconciliation can prove a journal entry
    // belongs to this job (job ids restart if Home Base's database is ever recreated).
    const requestId = crypto.randomUUID();
    const { id } = this.stateStore.createJob({ kind, target, status: 'queued', dryRun: false, createdAt: new Date().toISOString(), currentStep: null, planJson: JSON.stringify({ action, requestId }) });
    this.runTypedActionJob(id, action, onComplete, requestId).catch((error) => this.failTypedJob(id, error.message));
    return id;
  }

  failTypedJob(jobId, message) {
    this.stateStore.appendJobLog(jobId, `\n[executor-error] ${message}\n`);
    this.stateStore.updateJob(jobId, { status: 'failed', finishedAt: new Date().toISOString(), errorText: message });
  }

  async runTypedActionJob(jobId, action, onComplete = null, requestId = crypto.randomUUID()) {
    this.stateStore.updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
    let acceptedPlan = null;
    const onEvent = (event) => {
      if (event.eventType === 'plan.accepted') {
        acceptedPlan = event.plan;
        // Stored verbatim (it carries secret ref names, never values) so it re-digests to what ran.
        const verified = digestOperationPlan(event.plan) === event.planDigest;
        this.stateStore.updateJob(jobId, { planJson: JSON.stringify({ action, requestId, planDigest: event.planDigest, digestVerified: verified, operationPlan: event.plan }) });
        this.stateStore.appendJobLog(jobId, `[executor] plan.accepted ${event.planDigest}${verified ? '' : ' (DIGEST MISMATCH)'}\n`);
        return;
      }
      if (event.operationId) this.stateStore.updateJob(jobId, { currentStep: event.operationId });
      // Record each backup as soon as it exists on disk, so a later failure (e.g. during a restore)
      // can never leave a safety backup missing from the recovery inventory.
      if (event.eventType === 'operation.completed') this.recordCompletedBackups(jobId, action, acceptedPlan, [event.operationId]);
      appendExecutorEventLog(this.stateStore, jobId, event);
    };
    // The executor bounds every step; wait for the whole accepted plan (plus margin) rather than a
    // fixed deadline that could mark a still-running install failed.
    const planDeadline = (event) => (event.eventType === 'plan.accepted' && Array.isArray(event.plan?.operations)
      ? event.plan.operations.reduce((total, operation) => total + (operation.timeoutMs || 0), 0) + 5 * 60 * 1000
      : null);
    let outcome = null;
    for (let attempt = 1; !outcome; attempt += 1) {
      try {
        // The same nonce is reused across busy retries: a rejected attempt never ran.
        const result = await this.runExecutorAction(this.executorSocket, { jobId, requestId, ...action }, { timeoutMs: 30 * 60 * 1000, onEvent, deadlineFromEvent: planDeadline });
        outcome = { status: 'completed', plan: acceptedPlan, result };
      } catch (error) {
        // Accepted, then the connection was lost (timeout, reset, restart): the executor keeps going,
        // so ask it for the real outcome instead of guessing. Only the executor call is classified
        // here; errors while applying the outcome below are never mistaken for a lost connection.
        if (acceptedPlan && isTransportError(error)) {
          this.stateStore.appendJobLog(jobId, `[executor] lost contact after the plan was accepted (${error.message}); asking the executor for the outcome\n`);
          outcome = await this.awaitExecutorOutcome(jobId, requestId);
        } else if (error.code === 'EXECUTOR_BUSY' && attempt < this.busyRetry.attempts) {
          // A background update check briefly holds the executor; nothing ran yet, so waiting is safe.
          this.stateStore.appendJobLog(jobId, `[executor] busy; retrying (${attempt}/${this.busyRetry.attempts - 1})\n`);
          await new Promise((resolve) => setTimeout(resolve, this.busyRetry.delayMs));
        } else {
          throw error;
        }
      }
    }
    await this.settleTypedJob(jobId, action, outcome, { onComplete });
  }

  // Polls the executor's journal until the job leaves "running". Transient socket failures (the
  // executor restarting) are retried within the budget; the budget covers the longest plan.
  async awaitExecutorOutcome(jobId, requestId, { intervalMs = this.reconcile.intervalMs, maxWaitMs = this.reconcile.maxWaitMs } = {}) {
    if (!requestId) return { status: 'unknown' };
    const deadline = Date.now() + maxWaitMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const entry = await this.executorActionStatus(this.executorSocket, jobId, requestId, { timeoutMs: 10_000 });
        if (entry.status !== 'running') return entry;
      } catch (error) {
        // An executor that cannot answer this question at all (older protocol, refused) will not start to.
        if (['INVALID_REQUEST', 'UNSUPPORTED_PROTOCOL', 'POLICY_DENIED'].includes(error.code)) return { status: 'unreachable', error: error.message };
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { status: 'unreachable', error: lastError?.message || 'The executor still reports the job as running.' };
  }

  // The single place a typed job's outcome is applied, for live jobs and reconciled ones alike.
  async settleTypedJob(jobId, action, outcome, { onComplete = null } = {}) {
    const plan = outcome.plan || null;
    if (plan && Array.isArray(outcome.completedOperationIds)) this.recordCompletedBackups(jobId, action, plan, outcome.completedOperationIds);
    if (outcome.status !== 'completed') {
      const reason = {
        failed: `The executor reported failure${outcome.failedOperationId ? ` at ${outcome.failedOperationId}` : ''}: ${outcome.error || 'unknown error'}`,
        interrupted: `The executor restarted during this plan (completed: ${(outcome.completedOperationIds || []).join(', ') || 'none'}). Steps are idempotent; re-run the action.`,
        unknown: 'The executor has no record of this job; it never started. Re-run the action.',
        unreachable: `Could not learn the outcome from the executor: ${outcome.error}. Check journalctl -u homebase-executor, then re-run if needed.`,
      }[outcome.status] || `Unexpected executor status: ${outcome.status}`;
      this.failTypedJob(jobId, reason);
      return;
    }
    const app = action.appId ? getAppById(action.appId) : null;
    if (['install', 'restart', 'restore'].includes(action.action)) {
      // Installed/restored only after the app answers readiness, never merely because systemd started it.
      this.stateStore.appendJobLog(jobId, `[executor] waiting for ${app.name} readiness\n`);
      await waitForAppReadiness({ app, ...this.readinessOptions });
    }
    if (action.action === 'install') {
      const { stateRecord } = buildExecutorInstallRecord({ appId: action.appId, ref: action.ref, config: { defaultHostname: action.site.hostname, defaultDomain: action.site.domain, householdTimezone: action.site.householdTimezone } });
      this.stateStore.upsertInstallation({ ...stateRecord, updatedAt: new Date().toISOString(), status: 'installed' });
    }
    if (action.action === 'uninstall') {
      this.stateStore.deleteInstallation(action.appId);
      // Backup records follow the archives on disk: kept unless the backups were removed too.
      if (!action.keepBackups) this.stateStore.deleteBackups(action.appId);
    }
    if (typeof onComplete === 'function') onComplete();
    this.stateStore.updateJob(jobId, { status: 'completed', finishedAt: new Date().toISOString(), resultJson: JSON.stringify(outcome.result || { reconciled: true, completedOperationIds: outcome.completedOperationIds }) });
  }

  // Called at startup: any typed job still queued or running lost its connection when Home Base
  // stopped. The executor's journal says what actually happened.
  reconcileTypedJobs() {
    const unfinished = typeof this.stateStore.listUnfinishedJobs === 'function' ? this.stateStore.listUnfinishedJobs() : [];
    const typed = unfinished.filter((job) => !job.dryRun && parsePlanJson(job.planJson)?.action);
    for (const job of typed) {
      const { action, requestId } = parsePlanJson(job.planJson);
      this.stateStore.appendJobLog(job.id, '[executor] Home Base restarted while this job was in flight; reconciling with the executor\n');
      this.awaitExecutorOutcome(job.id, requestId)
        .then((outcome) => this.settleTypedJob(job.id, action, outcome))
        .catch((error) => this.failTypedJob(job.id, `Reconciliation failed: ${error.message}`));
    }
    return typed.map((job) => job.id);
  }

  // A dry-run in executor mode: the executor compiles (but does not run) the plan, and the job records it.
  startTypedPreviewJob({ kind, target, action }) {
    const { id } = this.stateStore.createJob({ kind, target, status: 'queued', dryRun: true, createdAt: new Date().toISOString(), currentStep: null, planJson: JSON.stringify({ action }) });
    this.planExecutorAction(this.executorSocket, action, { timeoutMs: 30_000 })
      .then(({ plan, planDigest }) => {
        this.stateStore.updateJob(id, { planJson: JSON.stringify({ action, planDigest, preview: true, operationPlan: plan }) });
        const lines = plan.operations.map((operation, index) => `${index + 1}. [${operation.risk}] ${operation.title}`);
        this.stateStore.appendJobLog(id, `[executor] dry-run preview ${planDigest}\n${lines.join('\n')}\n`);
        this.stateStore.updateJob(id, { status: 'completed', finishedAt: new Date().toISOString(), resultJson: JSON.stringify({ dryRun: true, planDigest }) });
      })
      .catch((error) => {
        this.stateStore.appendJobLog(id, `\n[executor-error] ${error.message}\n`);
        this.stateStore.updateJob(id, { status: 'failed', finishedAt: new Date().toISOString(), errorText: error.message });
      });
    return id;
  }

  startTypedBootstrapJob() {
    return this.startTypedActionJob({ kind: 'bootstrap', target: 'local-host', action: { action: 'bootstrap' } });
  }

  startTypedInstallJob({ appId, ref, transport, site, onComplete = null }) {
    if (!getAppById(appId)) throw new Error(`Unknown catalog app: ${appId}`);
    return this.startTypedActionJob({ kind: 'install', target: appId, action: { action: 'install', appId, ref, transport, site }, onComplete });
  }

  startTypedRestartJob({ appId }) {
    return this.startTypedActionJob({ kind: 'restart', target: appId, action: { action: 'restart', appId } });
  }

  startTypedBackupJob({ appId }) {
    return this.startTypedActionJob({ kind: 'backup', target: appId, action: { action: 'backup', appId } });
  }

  startTypedRestoreJob({ appId, backupId }) {
    return this.startTypedActionJob({ kind: 'restore', target: appId, action: { action: 'restore', appId, backupId } });
  }

  startTypedUninstallJob({ appId, keepBackups }) {
    return this.startTypedActionJob({ kind: 'uninstall', target: appId, action: { action: 'uninstall', appId, keepBackups } });
  }

  // Records every backup.create among the given completed operations, once each.
  recordCompletedBackups(jobId, action, plan, completedIds) {
    const operations = (plan?.operations || []).filter((operation) => operation.type === 'backup.create' && completedIds.includes(operation.id));
    for (const operation of operations) {
      const archiveDir = `${BACKUP_ROOT}/${action.appId}/${operation.archiveName}`;
      const known = typeof this.stateStore.listBackups === 'function' && this.stateStore.listBackups(action.appId).some((record) => record.archiveDir === archiveDir);
      if (!known) this.recordTypedBackup(action.appId, jobId, plan, operation);
    }
  }

  // The executor names every archive inside the accepted plan, so the record matches what ran.
  recordTypedBackup(appId, jobId, acceptedPlan, operation) {
    this.stateStore.recordBackup({
      appId,
      archiveDir: `${BACKUP_ROOT}/${appId}/${operation.archiveName}`,
      generatedAt: acceptedPlan.generatedAt,
      dryRun: false,
      status: 'completed',
      includedFiles: [],
      jobId,
      createdAt: new Date().toISOString(),
    });
  }

  startBackupJob(plan, { dryRun = true } = {}) {
    const steps = [
      {
        id: 'backup',
        title: `Backup ${plan.app.name}`,
        run: plan.commands,
      },
    ];
    return this.startPlanJob({
      kind: 'backup',
      target: plan.app.id,
      plan,
      steps,
      dryRun,
      onComplete: () => {
        if (dryRun) return;
        this.stateStore.recordBackup({
          appId: plan.app.id,
          archiveDir: plan.backup.archiveDir,
          generatedAt: plan.generatedAt,
          dryRun: false,
          status: 'completed',
          includedFiles: plan.backup.expectedFiles || [],
          jobId: null,
          createdAt: new Date().toISOString(),
        });
      },
      extraResult: {
        archiveDir: plan.backup.archiveDir,
      },
    });
  }

  startRestoreJob(plan, { dryRun = true } = {}) {
    const steps = [
      {
        id: 'restore',
        title: `Restore ${plan.app.name}`,
        run: plan.commands,
      },
    ];
    return this.startPlanJob({
      kind: 'restore',
      target: plan.app.id,
      plan,
      steps,
      dryRun,
      extraResult: {
        archiveDir: plan.restore.archiveDir,
      },
    });
  }

  startRestartJob(plan, { dryRun = true } = {}) {
    const steps = [
      {
        id: 'restart',
        title: `Restart ${plan.app.name}`,
        run: plan.commands,
      },
    ];
    return this.startPlanJob({
      kind: 'restart',
      target: plan.app.id,
      plan,
      steps,
      dryRun,
      extraResult: {
        serviceName: plan.restart.serviceName,
      },
    });
  }

  startUninstallJob(plan, { dryRun = true } = {}) {
    return this.startPlanJob({
      kind: 'uninstall',
      target: plan.app.id,
      plan,
      steps: plan.executionSteps || [],
      dryRun,
      onComplete: () => {
        if (dryRun) return;
        this.stateStore.deleteInstallation(plan.app.id);
        this.stateStore.deleteBackups(plan.app.id);
      },
      extraResult: {
        keepBackups: Boolean(plan.uninstall?.keepBackups),
        backupRoot: plan.uninstall?.backupRoot,
      },
    });
  }


  startTailscalePublishJob(plan, { dryRun = true } = {}) {
    return this.startPlanJob({
      kind: 'tailscale-publish',
      target: 'svc:home',
      plan,
      steps: plan.executionSteps || [],
      dryRun,
      extraResult: {
        readinessState: plan.readiness?.state || null,
        conflictCount: Array.isArray(plan.conflicts) ? plan.conflicts.length : 0,
        desiredHost: plan.desiredHost || null,
        desiredDomain: plan.desiredDomain || null,
        homebaseUrl: plan.previewUrls?.homebase || null,
        appsBaseUrl: plan.previewUrls?.appsBase || null,
      },
    });
  }

  startHomeBaseUpdateJob(plan, { dryRun = true } = {}) {
    return this.startPlanJob({
      kind: 'homebase-update',
      target: 'homebase',
      plan,
      steps: plan.executionSteps || [],
      dryRun,
    });
  }

  startHomeBaseRuntimeJob(plan, { dryRun = true } = {}) {
    return this.startPlanJob({
      kind: 'homebase-runtime',
      target: 'homebase',
      plan,
      steps: plan.executionSteps || [],
      dryRun,
      extraResult: {
        runtime: plan.runtime,
      },
    });
  }

  startPlanJob({ kind, target, plan, steps, dryRun = true, onComplete = null, extraResult = {} }) {
    const createdAt = new Date().toISOString();
    const { id } = this.stateStore.createJob({
      kind,
      target,
      status: 'queued',
      dryRun,
      createdAt,
      currentStep: steps[0] ? steps[0].id : null,
      planJson: JSON.stringify(plan),
    });

    this.runPlanJob(id, steps, { dryRun, onComplete, extraResult }).catch((error) => {
      this.stateStore.appendJobLog(id, `\n[error] ${error.message}\n`);
      this.stateStore.updateJob(id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        errorText: error.message,
      });
    });

    return id;
  }

  async runPlanJob(jobId, steps, { dryRun, onComplete = null, extraResult = {} }) {
    this.stateStore.updateJob(jobId, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    for (const step of steps) {
      this.stateStore.updateJob(jobId, { currentStep: step.id });
      this.stateStore.appendJobLog(jobId, `\n==> ${step.title}\n`);

      for (const command of step.run) {
        if (dryRun) {
          this.stateStore.appendJobLog(jobId, `[dry-run] ${command}\n`);
          continue;
        }

        await this.runCommand(jobId, command);
      }
    }

    if (typeof onComplete === 'function') {
      onComplete();
    }

    this.stateStore.updateJob(jobId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      resultJson: JSON.stringify({
        completedStepCount: steps.length,
        dryRun,
        ...extraResult,
      }),
    });
  }

  runCommand(jobId, command) {
    return new Promise((resolve, reject) => {
      this.stateStore.appendJobLog(jobId, `$ ${command}\n`);

      const child = spawn('/bin/bash', ['-lc', command], {
        env: process.env,
      });

      child.stdout.on('data', (chunk) => {
        this.stateStore.appendJobLog(jobId, chunk.toString('utf8'));
      });

      child.stderr.on('data', (chunk) => {
        this.stateStore.appendJobLog(jobId, chunk.toString('utf8'));
      });

      child.on('error', reject);

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Command failed with exit code ${code}: ${command}`));
      });
    });
  }
}

module.exports = {
  JobRunner,
  waitForAppReadiness,
  appendExecutorEventLog,
};
