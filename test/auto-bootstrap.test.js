const test = require('node:test');
const assert = require('node:assert/strict');
const { getAutoBootstrapDecision } = require('../src/auto-bootstrap');

test('auto-bootstrap decision starts only when enabled and no bootstrap job exists', () => {
  const decision = getAutoBootstrapDecision({
    config: {
      homeBaseAutoBootstrap: true,
      homeBaseAutoBootstrapMode: 'execute',
      homeBaseAutoBootstrapDelayMs: 25,
    },
    latestBootstrapJob: null,
  });

  assert.equal(decision.shouldStart, true);
  assert.equal(decision.dryRun, false);
  assert.equal(decision.delayMs, 25);
});

test('auto-bootstrap decision skips if disabled or bootstrap job exists', () => {
  assert.equal(getAutoBootstrapDecision({
    config: { homeBaseAutoBootstrap: false },
    latestBootstrapJob: null,
  }).reason, 'disabled');

  const existing = getAutoBootstrapDecision({
    config: { homeBaseAutoBootstrap: true },
    latestBootstrapJob: { id: 7, status: 'running' },
  });
  assert.equal(existing.shouldStart, false);
  assert.equal(existing.jobId, 7);
});

test('auto-bootstrap decision supports dry-run mode', () => {
  const decision = getAutoBootstrapDecision({
    config: {
      homeBaseAutoBootstrap: true,
      homeBaseAutoBootstrapMode: 'dry-run',
    },
    latestBootstrapJob: null,
  });

  assert.equal(decision.shouldStart, true);
  assert.equal(decision.mode, 'dry-run');
  assert.equal(decision.dryRun, true);
});

test('auto-bootstrap decision retries a failed bootstrap job', () => {
  const decision = getAutoBootstrapDecision({
    config: {
      homeBaseAutoBootstrap: true,
      homeBaseAutoBootstrapMode: 'execute',
    },
    latestBootstrapJob: { id: 9, status: 'failed' },
  });

  assert.equal(decision.shouldStart, true);
  assert.equal(decision.retryOfJobId, 9);
  assert.equal(decision.dryRun, false);
});
