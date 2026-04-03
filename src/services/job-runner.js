const { spawn } = require('child_process');

class JobRunner {
  constructor(stateStore) {
    this.stateStore = stateStore;
  }

  startBootstrapJob(plan, { dryRun = true } = {}) {
    const createdAt = new Date().toISOString();
    const { id } = this.stateStore.createJob({
      kind: 'bootstrap',
      target: 'local-host',
      status: 'queued',
      dryRun,
      createdAt,
      currentStep: plan.steps[0] ? plan.steps[0].id : null,
      planJson: JSON.stringify(plan),
    });

    this.runBootstrapJob(id, plan, { dryRun }).catch((error) => {
      this.stateStore.appendJobLog(id, `\n[error] ${error.message}\n`);
      this.stateStore.updateJob(id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        errorText: error.message,
      });
    });

    return id;
  }

  async runBootstrapJob(jobId, plan, { dryRun }) {
    this.stateStore.updateJob(jobId, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    for (const step of plan.steps) {
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

    this.stateStore.updateJob(jobId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      resultJson: JSON.stringify({
        completedStepCount: plan.steps.length,
        dryRun,
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
