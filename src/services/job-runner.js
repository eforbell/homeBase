const { spawn } = require('child_process');
const { executePlan } = require('../executor/client');
const { redactPlan } = require('../operations/redact');

async function waitForDinnerReadiness({ fetchImpl = global.fetch, attempts = 30, delayMs = 1000 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl('http://127.0.0.1:3000/api/ready');
      if (response.ok) return;
      lastError = new Error(`readiness returned HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const error = new Error(`Family Dinner readiness failed: ${lastError?.message || 'unknown error'}`);
  error.code = 'READINESS_FAILED';
  throw error;
}

class JobRunner {
  constructor(stateStore, { executorSocket = '/run/homebase/executor.sock' } = {}) {
    this.stateStore = stateStore;
    this.executorSocket = executorSocket;
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
        this.stateStore.upsertInstallation({
          ...plan.stateRecord,
          updatedAt: new Date().toISOString(),
          status: dryRun ? 'planned' : 'installed',
        });
        if (typeof onComplete === 'function') onComplete();
      },
    });
  }

  startTypedBootstrapJob(operationPlan) {
    const { id } = this.stateStore.createJob({ kind: 'bootstrap', target: 'local-host', status: 'queued', dryRun: false, createdAt: new Date().toISOString(), currentStep: operationPlan.operations[0]?.id || null, planJson: JSON.stringify({ operationPlan }) });
    this.runTypedBootstrapJob(id, operationPlan).catch((error) => {
      this.stateStore.appendJobLog(id, `\n[executor-error] ${error.message}\n`);
      this.stateStore.updateJob(id, { status: 'failed', finishedAt: new Date().toISOString(), errorText: error.message });
    });
    return id;
  }

  async runTypedBootstrapJob(jobId, operationPlan) {
    this.stateStore.updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
    const result = await executePlan(this.executorSocket, { jobId, plan: operationPlan, secretBindings: {} }, { timeoutMs: 30 * 60 * 1000, onEvent: (event) => {
      if (event.operationId) this.stateStore.updateJob(jobId, { currentStep: event.operationId });
      this.stateStore.appendJobLog(jobId, `[executor] ${event.eventType}${event.operationId ? ` ${event.operationId}` : ''}\n`);
    } });
    this.stateStore.updateJob(jobId, { status: 'completed', finishedAt: new Date().toISOString(), resultJson: JSON.stringify(result) });
  }

  startTypedDinnerInstallJob(plan, { secretBindings, onComplete = null } = {}) {
    const operationPlan = plan.operationPlan;
    if (!operationPlan || operationPlan.target !== 'family-dinner') throw new Error('Typed executor requires a Family Dinner operation plan.');
    const { id } = this.stateStore.createJob({ kind: 'install', target: 'family-dinner', status: 'queued', dryRun: false, createdAt: new Date().toISOString(), currentStep: operationPlan.operations[0]?.id || null, planJson: JSON.stringify({ ...plan, operationPlan: redactPlan(operationPlan, secretBindings) }) });
    this.runTypedDinnerInstallJob(id, plan, secretBindings, onComplete).catch((error) => {
      this.stateStore.appendJobLog(id, `\n[executor-error] ${error.message}\n`);
      this.stateStore.updateJob(id, { status: 'failed', finishedAt: new Date().toISOString(), errorText: error.message });
    });
    return id;
  }

  async runTypedDinnerInstallJob(jobId, plan, secretBindings, onComplete) {
    this.stateStore.updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
    const result = await executePlan(this.executorSocket, { jobId, plan: plan.operationPlan, secretBindings }, { timeoutMs: 30 * 60 * 1000, onEvent: (event) => {
      if (event.operationId) this.stateStore.updateJob(jobId, { currentStep: event.operationId });
      this.stateStore.appendJobLog(jobId, `[executor] ${event.eventType}${event.operationId ? ` ${event.operationId}` : ''}\n`);
    } });
    this.stateStore.appendJobLog(jobId, '[executor] waiting for Family Dinner readiness\n');
    await waitForDinnerReadiness();
    this.stateStore.upsertInstallation({ ...plan.stateRecord, updatedAt: new Date().toISOString(), status: 'installed' });
    if (typeof onComplete === 'function') onComplete();
    this.stateStore.updateJob(jobId, { status: 'completed', finishedAt: new Date().toISOString(), resultJson: JSON.stringify(result) });
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
  waitForDinnerReadiness,
};
