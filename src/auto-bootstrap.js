const { buildBootstrapPlan } = require('./services/bootstrap-planner');

function getAutoBootstrapDecision({ config, latestBootstrapJob }) {
  if (!config.homeBaseAutoBootstrap) {
    return { shouldStart: false, reason: 'disabled' };
  }
  if (config.homeBaseEnablePrivilegedJobs === false) {
    return { shouldStart: false, reason: 'privileged-jobs-disabled' };
  }
  if (latestBootstrapJob) {
    return {
      shouldStart: false,
      reason: 'bootstrap-job-exists',
      jobId: latestBootstrapJob.id,
      status: latestBootstrapJob.status,
    };
  }

  const mode = config.homeBaseAutoBootstrapMode === 'dry-run' ? 'dry-run' : 'execute';
  return {
    shouldStart: true,
    mode,
    dryRun: mode === 'dry-run',
    delayMs: Number.isFinite(config.homeBaseAutoBootstrapDelayMs)
      ? Math.max(0, config.homeBaseAutoBootstrapDelayMs)
      : 5000,
  };
}

function buildAutoBootstrapPlan(config) {
  return buildBootstrapPlan({
    serviceUser: config.serviceUser,
    baseInstallDir: config.baseInstallDir,
    baseBackupDir: config.baseBackupDir,
    baseConfigDir: config.baseConfigDir,
  });
}

function scheduleAutoBootstrap({ stateStore, jobRunner, config, logger = console }) {
  const latestBootstrapJob = stateStore.getLatestJobByKind('bootstrap');
  const decision = getAutoBootstrapDecision({ config, latestBootstrapJob });
  if (!decision.shouldStart) {
    return decision;
  }

  const timer = setTimeout(() => {
    try {
      const latest = stateStore.getLatestJobByKind('bootstrap');
      if (latest) {
        logger.info?.(`Home Base auto-bootstrap skipped; bootstrap job ${latest.id} already exists (${latest.status}).`);
        return;
      }
      const plan = buildAutoBootstrapPlan(config);
      const jobId = jobRunner.startBootstrapJob(plan, { dryRun: decision.dryRun });
      logger.info?.(`Home Base auto-bootstrap started job ${jobId} (${decision.mode}).`);
    } catch (error) {
      logger.error?.(`Home Base auto-bootstrap failed to start: ${error.message}`);
    }
  }, decision.delayMs);

  if (typeof timer.unref === 'function') timer.unref();

  return {
    ...decision,
    scheduled: true,
  };
}

module.exports = {
  buildAutoBootstrapPlan,
  getAutoBootstrapDecision,
  scheduleAutoBootstrap,
};
