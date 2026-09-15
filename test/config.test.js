const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

function withEnv(overrides, run) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('public runtime defaults to loopback and plan-only execution', () => {
  withEnv({
    HOME_BASE_BIND_HOST: null,
    HOME_BASE_EXECUTION_MODE: null,
    HOME_BASE_ENABLE_PRIVILEGED_JOBS: null,
    HOME_BASE_AUTO_BOOTSTRAP: null,
  }, () => {
    const config = loadConfig();
    assert.equal(config.bindHost, '127.0.0.1');
    assert.equal(config.homeBaseExecutionMode, 'plan-only');
    assert.equal(config.homeBaseEnablePrivilegedJobs, false);
    assert.equal(config.homeBaseAutoBootstrap, false);
  });
});

test('legacy privileged execution requires both explicit mode and enable flag', () => {
  withEnv({
    HOME_BASE_EXECUTION_MODE: 'legacy-sudo',
    HOME_BASE_ENABLE_PRIVILEGED_JOBS: '1',
  }, () => {
    const config = loadConfig();
    assert.equal(config.homeBaseExecutionMode, 'legacy-sudo');
    assert.equal(config.homeBaseEnablePrivilegedJobs, true);
  });

  withEnv({
    HOME_BASE_EXECUTION_MODE: 'plan-only',
    HOME_BASE_ENABLE_PRIVILEGED_JOBS: '1',
  }, () => {
    const config = loadConfig();
    assert.equal(config.homeBaseEnablePrivilegedJobs, false);
  });
});

test('unknown execution modes fail closed to plan-only', () => {
  withEnv({ HOME_BASE_EXECUTION_MODE: 'anything-goes' }, () => {
    const config = loadConfig();
    assert.equal(config.homeBaseExecutionMode, 'plan-only');
    assert.equal(config.homeBaseEnablePrivilegedJobs, false);
  });
});
