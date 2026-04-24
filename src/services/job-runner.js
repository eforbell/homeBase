const { spawn } = require('child_process');

class JobRunner {
  constructor(stateStore) {
    this.stateStore = stateStore;
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

  startInstallJob(plan, { dryRun = true } = {}) {
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
      },
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
};
