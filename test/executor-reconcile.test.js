const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createJournal } = require('../executor/journal');
const { createRunAction } = require('../executor/run-action');
const { createExecutorServer } = require('../executor/server');
const { actionStatus, sendRequest } = require('../src/executor/client');
const { PROTOCOL_VERSION } = require('../executor/protocol-version');
const { JobRunner } = require('../src/services/job-runner');
const { createFakeFs } = require('./fixtures/fake-fs');

const plan = { kind: 'host-bootstrap', target: 'local-host', operations: [{ id: 'a', type: 'x', secretRefs: [] }, { id: 'b', type: 'backup.create', archiveName: '20260924T101010Z', secretRefs: [] }] };

function memoryStore() {
  const jobs = {};
  const backups = [];
  const installs = {};
  const store = {
    jobs, backups, installs,
    createJob: (job) => { const id = Object.keys(jobs).length + 1; jobs[id] = { id, ...job, log: '' }; return { id }; },
    updateJob: (id, fields) => Object.assign(jobs[id], fields),
    appendJobLog: (id, text) => { jobs[id].log += text; },
    listUnfinishedJobs: () => Object.values(jobs).filter((job) => ['queued', 'running'].includes(job.status)),
    recordBackup: (record) => backups.push(record.archiveDir),
    listBackups: () => backups.map((archiveDir) => ({ archiveDir })),
    upsertInstallation: (record) => { installs[record.appId] = record; },
    deleteInstallation: (appId) => { delete installs[appId]; },
    deleteBackups: () => {},
  };
  return store;
}

test('the journal records progress and outcome, marks cut-off plans interrupted, and prunes old entries', () => {
  const fsImpl = createFakeFs({ '/j': { kind: 'dir', uid: 0 } });
  let clock = 0;
  const timed = createJournal({ dir: '/j', fsImpl, now: () => new Date(Date.UTC(2026, 8, 24) + (clock += 1000)) });
  timed.begin({ jobId: '7', requestId: 'r7', action: { action: 'bootstrap' }, plan, planDigest: 'sha256:d' });
  timed.progress('7', { eventType: 'operation.completed', operationId: 'a' });
  timed.progress('7', { eventType: 'operation.output', operationId: 'a' });
  assert.deepEqual(timed.status('7', 'r7').completedOperationIds, ['a']);
  assert.equal(timed.status('7', 'r7').status, 'running');
  assert.equal(timed.status('7', 'someone-else').status, 'unknown', 'an entry answers only for the request that created it');
  timed.markInterrupted();
  assert.equal(timed.status('7', 'r7').status, 'interrupted', 'a fresh executor process cannot still be running a plan');
  timed.begin({ jobId: '8', requestId: 'r8', action: { action: 'bootstrap' }, plan, planDigest: 'sha256:d' });
  timed.finish('8', { ok: false, error: 'boom' });
  assert.deepEqual([timed.status('8', 'r8').status, timed.status('8', 'r8').error], ['failed', 'boom']);
  assert.deepEqual(timed.status('999', 'x'), { jobId: '999', status: 'unknown' });
  assert.deepEqual(timed.status('../etc', 'x'), { jobId: '../etc', status: 'unknown' });
  assert.equal(fsImpl.entries.get('/j/8.json').mode, 0o600);
  for (let id = 300; id < 520; id += 1) timed.begin({ jobId: String(id), requestId: `r${id}`, action: {}, plan, planDigest: 'x' });
  assert.equal(fsImpl.readdirSync('/j').length, 200);
  // Job ids restart after Home Base's database is recreated: a new, low id must survive pruning.
  timed.begin({ jobId: '1', requestId: 'fresh', action: {}, plan, planDigest: 'x' });
  assert.equal(timed.status('1', 'fresh').status, 'running');
  assert.equal(fsImpl.existsSync('/j/300.json'), false, 'the oldest entry by start time was pruned instead');
});

test('runAction journals before streaming and keeps running when the peer has gone away', async () => {
  const fsImpl = createFakeFs({ '/j': { kind: 'dir', uid: 0 } });
  const journal = createJournal({ dir: '/j', fsImpl });
  const runAction = createRunAction({
    handlers: {}, journal,
    compile: () => ({ plan, planDigest: 'sha256:d' }),
    execute: async (request, { emit }) => {
      emit({ eventType: 'operation.completed', operationId: 'a' });
      emit({ eventType: 'operation.completed', operationId: 'b' });
      return { completedOperationIds: ['a', 'b'] };
    },
  });
  const sent = [];
  let connected = true;
  const send = (event) => { if (!connected) throw new Error('EPIPE'); sent.push(event.eventType); connected = false; };
  const result = await runAction({ action: 'bootstrap' }, { emit: send, jobId: '5', requestId: 'r' });
  assert.deepEqual(result.completedOperationIds, ['a', 'b']);
  assert.deepEqual(sent, ['plan.accepted'], 'the client vanished after the first event');
  assert.deepEqual([journal.status('5', 'r').status, journal.status('5', 'r').completedOperationIds], ['completed', ['a', 'b']]);
});

test('action-status accepts only a job id and answers from the journal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-status-'));
  const socketPath = path.join(dir, 's.sock');
  const nonce = '11111111-1111-4111-8111-111111111111';
  const server = createExecutorServer({ logger: { info() {} }, actionStatus: (jobId, requestId) => ({ jobId, status: jobId === '3' && requestId === nonce ? 'completed' : 'unknown' }) });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    assert.equal((await actionStatus(socketPath, 3, nonce)).status, 'completed');
    assert.equal((await actionStatus(socketPath, 3, crypto.randomUUID())).status, 'unknown');
    assert.equal((await actionStatus(socketPath, 4, nonce)).status, 'unknown');
    for (const bad of [{ jobId: '../x', actionRequestId: nonce }, { jobId: '3', actionRequestId: nonce, plan: {} }, { jobId: '3' }, { jobId: '1'.repeat(16), actionRequestId: nonce }]) {
      await assert.rejects(() => sendRequest(socketPath, { protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(), type: 'action-status', ...bad }), (error) => error.code === 'INVALID_REQUEST', JSON.stringify(bad));
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('losing the connection after acceptance asks the executor for the outcome instead of failing the job', async () => {
  const store = memoryStore();
  const statuses = [{ status: 'running' }, { status: 'completed', plan, completedOperationIds: ['a', 'b'] }];
  const runner = new JobRunner(store, {
    reconcile: { intervalMs: 5, maxWaitMs: 2000 },
    runExecutorAction: async (socket, fields, { onEvent }) => {
      onEvent({ eventType: 'plan.accepted', planDigest: 'sha256:d', plan });
      throw new Error('Executor request timed out.');
    },
    executorActionStatus: async () => statuses.shift() || statuses.at(-1),
  });
  const id = runner.startTypedBackupJob({ appId: 'home-source' });
  for (let i = 0; i < 100 && store.jobs[id].status !== 'completed' && store.jobs[id].status !== 'failed'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.jobs[id].status, 'completed', store.jobs[id].log);
  assert.match(store.jobs[id].log, /lost contact after the plan was accepted/);
  assert.deepEqual(store.backups, ['/var/lib/sovereign-home/backups/home-source/20260924T101010Z'], 'backups from the journal are recorded once');
});

test('an executor restart mid-plan fails the job with re-run guidance, keeping any backups it made', async () => {
  const store = memoryStore();
  const runner = new JobRunner(store, {
    reconcile: { intervalMs: 5, maxWaitMs: 500 },
    runExecutorAction: async (socket, fields, { onEvent }) => {
      onEvent({ eventType: 'plan.accepted', planDigest: 'sha256:d', plan });
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    },
    executorActionStatus: async () => ({ status: 'interrupted', plan, completedOperationIds: ['a', 'b'] }),
  });
  const id = runner.startTypedRestoreJob({ appId: 'home-source', backupId: '20260101T000000Z' });
  for (let i = 0; i < 100 && store.jobs[id].status === 'running'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.jobs[id].status, 'failed');
  assert.match(store.jobs[id].errorText, /restarted during this plan.*re-run the action/);
  assert.equal(store.backups.length, 1, 'the safety backup made before the interruption is recorded');
});

test('startup reconciliation settles jobs that finished while Home Base was down', async () => {
  const store = memoryStore();
  const installAction = { action: 'install', appId: 'home-source', ref: 'main', transport: 'https', site: { hostname: 'homebase', domain: 'tailnet', householdTimezone: 'America/New_York' } };
  store.createJob({ kind: 'install', target: 'home-source', status: 'running', dryRun: false, planJson: JSON.stringify({ action: installAction, requestId: 'nonce-1' }) });
  store.createJob({ kind: 'backup', target: 'home-source', status: 'running', dryRun: false, planJson: JSON.stringify({ action: { action: 'backup', appId: 'home-source' }, requestId: 'nonce-2', operationPlan: plan }) });
  store.createJob({ kind: 'install', target: 'x', status: 'running', dryRun: false, planJson: JSON.stringify({ steps: [] }) });
  const runner = new JobRunner(store, {
    reconcile: { intervalMs: 5, maxWaitMs: 500 },
    readinessOptions: { attempts: 1, fetchImpl: async () => ({ ok: true, status: 200 }) },
    executorActionStatus: async (socket, jobId, requestId) => (String(jobId) === '1' && requestId === 'nonce-1' ? { status: 'completed', plan: { operations: [] }, completedOperationIds: [] } : { status: 'unknown' }),
  });
  assert.deepEqual(runner.reconcileTypedJobs(), [1, 2], 'legacy (untyped) jobs are left alone');
  for (let i = 0; i < 100 && (store.jobs[1].status === 'running' || store.jobs[2].status === 'running'); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.jobs[1].status, 'completed');
  assert.equal(store.installs['home-source'].status, 'installed');
  assert.equal(store.installs['home-source'].installRoot, '/opt/sovereign-home/apps/homeSource');
  assert.equal(store.jobs[2].status, 'failed');
  assert.match(store.jobs[2].errorText, /never started/);
  assert.equal(store.jobs[3].status, 'running');
});

test('the nonce is stored before sending and reused across busy retries and status polling', async () => {
  const store = memoryStore();
  const seen = [];
  let calls = 0;
  const runner = new JobRunner(store, {
    busyRetry: { attempts: 3, delayMs: 1 },
    reconcile: { intervalMs: 5, maxWaitMs: 500 },
    runExecutorAction: async (socket, fields, { onEvent }) => {
      seen.push(['run', fields.requestId, JSON.parse(store.jobs[fields.jobId].planJson).requestId]);
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EXECUTOR_BUSY' });
      onEvent({ eventType: 'plan.accepted', planDigest: 'sha256:d', plan });
      throw new Error('Executor request timed out.');
    },
    executorActionStatus: async (socket, jobId, requestId) => { seen.push(['status', requestId]); return { status: 'completed', plan, completedOperationIds: [] }; },
  });
  const id = runner.startTypedBootstrapJob();
  for (let i = 0; i < 100 && store.jobs[id].status !== 'completed'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const nonce = JSON.parse(store.jobs[id].planJson).requestId;
  assert.match(nonce, /^[0-9a-f-]{36}$/);
  assert.deepEqual(seen, [['run', nonce, nonce], ['run', nonce, nonce], ['status', nonce]]);
});

test('a failure while applying a successful outcome is not mistaken for a lost connection', async () => {
  const store = memoryStore();
  let statusCalls = 0;
  const runner = new JobRunner(store, {
    runExecutorAction: async (socket, fields, { onEvent }) => { onEvent({ eventType: 'plan.accepted', planDigest: 'd', plan }); return { completedOperationIds: [] }; },
    executorActionStatus: async () => { statusCalls += 1; return { status: 'completed' }; },
  });
  const id = runner.startTypedActionJob({ kind: 'bootstrap', target: 'local-host', action: { action: 'bootstrap' }, onComplete: () => { throw new Error('database is locked'); } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(statusCalls, 0, 'no re-poll and no second settle');
  assert.equal(store.jobs[id].status, 'failed');
  assert.match(store.jobs[id].errorText, /database is locked/);
});

test('status polling stops at once when the executor cannot answer the question', async () => {
  const runner = new JobRunner(memoryStore(), {
    reconcile: { intervalMs: 5, maxWaitMs: 60_000 },
    executorActionStatus: async () => { throw Object.assign(new Error('Unsupported request type.'), { code: 'INVALID_REQUEST' }); },
  });
  const started = Date.now();
  const outcome = await runner.awaitExecutorOutcome('3', 'nonce');
  assert.equal(outcome.status, 'unreachable');
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(await runner.awaitExecutorOutcome('3', undefined), { status: 'unknown' }, 'jobs without a nonce cannot be matched');
});

test('while the maintenance flag exists the executor starts no new work; hello reports it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-maint-'));
  const socketPath = path.join(dir, 's.sock');
  let inMaintenance = true;
  let ran = 0;
  const server = createExecutorServer({ logger: { info() {} }, mutationsEnabled: true, maintenance: () => inMaintenance, runAction: async () => { ran += 1; return {}; }, checkAppUpdateStatus: async () => { ran += 1; return {}; } });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const { hello, runAction, appUpdateStatus } = require('../src/executor/client');
  try {
    assert.equal((await hello(socketPath)).maintenance, true);
    await assert.rejects(() => runAction(socketPath, { jobId: 1, action: 'bootstrap' }), (error) => error.code === 'EXECUTOR_MAINTENANCE');
    await assert.rejects(() => appUpdateStatus(socketPath, { appId: 'family-dinner', transport: 'https', ref: 'main' }), (error) => error.code === 'EXECUTOR_MAINTENANCE');
    assert.equal(ran, 0);
    inMaintenance = false;
    await runAction(socketPath, { jobId: 2, action: 'bootstrap' });
    assert.equal(ran, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('only a root-owned regular file counts as the maintenance flag', () => {
  const { maintenanceActive } = require('../executor/maintenance');
  assert.equal(maintenanceActive({ fsImpl: createFakeFs({ '/run/homebase/executor.maintenance': { kind: 'file', content: '', uid: 0 } }), flag: '/run/homebase/executor.maintenance' }), true);
  assert.equal(maintenanceActive({ fsImpl: createFakeFs({ '/run/homebase/executor.maintenance': { kind: 'file', content: '', uid: 999 } }), flag: '/run/homebase/executor.maintenance' }), false);
  assert.equal(maintenanceActive({ fsImpl: createFakeFs(), flag: '/run/homebase/executor.maintenance' }), false);
});

test('a job submitted during a repair waits for maintenance to end, then runs', async () => {
  const store = memoryStore();
  let calls = 0;
  const runner = new JobRunner(store, {
    maintenanceRetry: { delayMs: 5, maxWaitMs: 5000 },
    runExecutorAction: async (socket, fields, { onEvent }) => {
      calls += 1;
      if (calls < 4) throw Object.assign(new Error('The executor is being repaired; retry shortly.'), { code: 'EXECUTOR_MAINTENANCE' });
      onEvent({ eventType: 'plan.accepted', planDigest: 'd', plan });
      return { completedOperationIds: ['a', 'b'] };
    },
  });
  const id = runner.startTypedBootstrapJob();
  for (let i = 0; i < 100 && store.jobs[id].status !== 'completed'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.jobs[id].status, 'completed');
  assert.equal(calls, 4);
  assert.match(store.jobs[id].log, /maintenance in progress/);
});

test('a disconnect before plan.accepted still asks the executor; delivered work is not reported as failed', async () => {
  const store = memoryStore();
  const statuses = [];
  const runner = new JobRunner(store, {
    reconcile: { intervalMs: 5, maxWaitMs: 2000, unknownGraceMs: 50 },
    runExecutorAction: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); },
    executorActionStatus: async (socket, jobId, requestId) => { statuses.push(requestId); return { status: 'completed', plan, completedOperationIds: ['a', 'b'] }; },
  });
  const id = runner.startTypedBackupJob({ appId: 'home-source' });
  for (let i = 0; i < 100 && !['completed', 'failed'].includes(store.jobs[id].status); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.jobs[id].status, 'completed', store.jobs[id].errorText);
  assert.deepEqual(statuses, [JSON.parse(store.jobs[id].planJson).requestId], 'queried with the persisted token');
  assert.equal(store.backups.length, 1, 'backups come from the journal plan');
});

test('an unknown answer is final only after the grace window; undelivered requests fail at once', async () => {
  const store = memoryStore();
  let polls = 0;
  const started = Date.now();
  const runner = new JobRunner(store, {
    reconcile: { intervalMs: 5, maxWaitMs: 5000, unknownGraceMs: 100 },
    runExecutorAction: async () => { throw new Error('Executor request timed out.'); },
    executorActionStatus: async () => { polls += 1; return { status: 'unknown' }; },
  });
  const id = runner.startTypedBootstrapJob();
  for (let i = 0; i < 200 && store.jobs[id].status !== 'failed'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.jobs[id].status, 'failed');
  assert.match(store.jobs[id].errorText, /never started \(nothing ran\)/);
  assert.ok(polls > 1 && Date.now() - started >= 100, 'kept asking through the grace window');

  let statusCalls = 0;
  const offline = new JobRunner(store, {
    runExecutorAction: async () => { throw Object.assign(new Error('connect ENOENT /run/homebase/executor.sock'), { code: 'ENOENT' }); },
    executorActionStatus: async () => { statusCalls += 1; return { status: 'unknown' }; },
  });
  const offlineId = offline.startTypedBootstrapJob();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.jobs[offlineId].status, 'failed');
  assert.equal(statusCalls, 0, 'nothing was delivered, so there is nothing to ask about');
});

test('after a restart, a job that never reached the executor is submitted instead of failed', async () => {
  const store = memoryStore();
  store.createJob({ kind: 'restart', target: 'home-source', status: 'running', dryRun: false, planJson: JSON.stringify({ action: { action: 'restart', appId: 'home-source' }, requestId: 'nonce-w' }) });
  store.createJob({ kind: 'backup', target: 'home-source', status: 'running', dryRun: false, planJson: JSON.stringify({ action: { action: 'backup', appId: 'home-source' }, requestId: 'nonce-a', operationPlan: plan }) });
  const submitted = [];
  const runner = new JobRunner(store, {
    reconcile: { intervalMs: 5, maxWaitMs: 500, unknownGraceMs: 10 },
    readinessOptions: { attempts: 1, fetchImpl: async () => ({ ok: true, status: 200 }) },
    executorActionStatus: async () => ({ status: 'unknown' }),
    runExecutorAction: async (socket, fields, { onEvent }) => {
      submitted.push([fields.jobId, fields.requestId]);
      onEvent({ eventType: 'plan.accepted', planDigest: 'd', plan: { operations: [] } });
      return { completedOperationIds: [] };
    },
  });
  runner.reconcileTypedJobs();
  for (let i = 0; i < 100 && ['queued', 'running'].includes(store.jobs[1].status) || ['queued', 'running'].includes(store.jobs[2].status); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(submitted, [[1, 'nonce-w']], 'resubmitted with its original token');
  assert.equal(store.jobs[1].status, 'completed');
  assert.equal(store.jobs[2].status, 'failed', 'an accepted job the executor lost is never resubmitted blindly');
});
