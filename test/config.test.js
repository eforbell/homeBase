const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { isProtocolCompatible, canExecuteMutations } = require('../src/executor/capabilities');

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


test('executor capability checks distinguish healthy protocol support from mutation authority', () => {
  const capabilities = { protocolVersions: [1], policyVersion: 'family-dinner-v1', mutationsEnabled: false };
  assert.equal(isProtocolCompatible(capabilities), true);
  assert.equal(canExecuteMutations(capabilities), false);
  assert.equal(isProtocolCompatible({ ...capabilities, protocolVersions: [2] }), false);
});

test('executor mode is explicit and exposes only the protected socket path', () => {
  withEnv({ HOME_BASE_EXECUTION_MODE: 'executor', HOME_BASE_ENABLE_PRIVILEGED_JOBS: '1', HOME_BASE_EXECUTOR_SOCKET: '/run/homebase/executor.sock' }, () => {
    const config = loadConfig();
    assert.equal(config.homeBaseExecutionMode, 'executor');
    assert.equal(config.homeBaseEnablePrivilegedJobs, true);
    assert.equal(config.homeBaseExecutorSocket, '/run/homebase/executor.sock');
  });
});
