const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('the web process starts without the executor validator dependencies (legacy hosts)', () => {
  const result = spawnSync(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'block-ajv.js'), '-e', "require('./src/app'); process.stdout.write('loaded')"], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'loaded');
});

test('privileged jobs without an execution mode fail closed but say exactly how to opt in', async () => {
  const { loadConfig } = require('../src/config');
  const saved = { ...process.env };
  try {
    process.env.HOME_BASE_ENABLE_PRIVILEGED_JOBS = '1';
    delete process.env.HOME_BASE_EXECUTION_MODE;
    const config = loadConfig();
    assert.equal(config.homeBaseEnablePrivilegedJobs, false);
    assert.equal(config.homeBaseExecutionModeMissing, true);
    process.env.HOME_BASE_EXECUTION_MODE = 'legacy-sudo';
    assert.equal(loadConfig().homeBaseEnablePrivilegedJobs, true);
    assert.equal(loadConfig().homeBaseExecutionModeMissing, false);
  } finally { process.env = saved; }
});

test('a dry-run never downgrades an installed app to "planned"', async () => {
  const { JobRunner } = require('../src/services/job-runner');
  const { buildInstallPlan } = require('../src/services/install-planner');
  const { SqliteStateStore } = require('../src/state/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-dryrun-'));
  const store = new SqliteStateStore(path.join(dir, 'state.sqlite3'));
  store.init();
  const plan = buildInstallPlan({ appId: 'family-dinner', state: { installations: {} }, options: {}, config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: path.join(dir, 'apps'), defaultHostname: 'homebase', defaultDomain: 'tailnet' } });
  store.upsertInstallation({ ...plan.stateRecord, status: 'installed', updatedAt: new Date().toISOString() });
  const runner = new JobRunner(store);
  const jobId = runner.startInstallJob(plan, { dryRun: true });
  for (let i = 0; i < 50 && store.getJob(jobId).status !== 'completed'; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getJob(jobId).status, 'completed');
  assert.equal(store.loadState().installations['family-dinner'].status, 'installed');
});

test('auto-bootstrap never runs the legacy plan on an executor host', () => {
  const { getAutoBootstrapDecision } = require('../src/auto-bootstrap');
  const decision = getAutoBootstrapDecision({ config: { homeBaseAutoBootstrap: true, homeBaseEnablePrivilegedJobs: true, homeBaseExecutionMode: 'executor' }, latestBootstrapJob: null });
  assert.deepEqual([decision.shouldStart, decision.reason], [false, 'executor-mode']);
});

test('a plan.accepted event replaces the fixed client deadline with the plan-sized one', async () => {
  const net = require('net');
  const { sendRequest } = require('../src/executor/client');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-deadline-'));
  const socketPath = path.join(dir, 's.sock');
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write(`${JSON.stringify({ eventType: 'plan.accepted', plan: { operations: [{ timeoutMs: 1000 }] } })}\n`);
      setTimeout(() => socket.end(`${JSON.stringify({ type: 'terminal', ok: true, result: { done: true } })}\n`), 150);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await sendRequest(socketPath, { hello: true }, { timeoutMs: 50, deadlineFromEvent: (event) => (event.eventType === 'plan.accepted' ? 1000 : null) });
    assert.deepEqual(result, { done: true }, 'the 50ms initial deadline was extended once the plan was known');
    await assert.rejects(() => sendRequest(socketPath, { hello: true }, { timeoutMs: 50 }), /timed out/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('executor install records use catalog values no matter what the request or config says', () => {
  const { buildExecutorInstallRecord } = require('../src/services/install-planner');
  const { stateRecord, ref } = buildExecutorInstallRecord({ appId: 'home-source', ref: 'main', state: { installations: { other: { port: 3008 } } }, config: { port: 3080, baseInstallDir: '/srv/elsewhere', defaultHostname: 'homebase', defaultDomain: 'tailnet' } });
  assert.equal(ref, 'main');
  assert.equal(stateRecord.installRoot, '/opt/sovereign-home/apps/homeSource');
  assert.equal(stateRecord.mountPath, '/source/');
  assert.equal(stateRecord.port, 3008);
  assert.equal(stateRecord.externalUrl, 'https://homebase.tailnet/source/');
});
