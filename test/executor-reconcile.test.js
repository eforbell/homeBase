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
  const journal = createJournal({ dir: '/j', fsImpl, now: () => new Date('2026-09-24T00:00:00.000Z') });
  journal.begin({ jobId: '7', requestId: 'r', action: { action: 'bootstrap' }, plan, planDigest: 'sha256:d' });
  journal.progress('7', { eventType: 'operation.completed', operationId: 'a' });
  journal.progress('7', { eventType: 'operation.output', operationId: 'a' });
  assert.deepEqual(journal.status('7').completedOperationIds, ['a']);
  assert.equal(journal.status('7').status, 'running');
  journal.markInterrupted();
  assert.equal(journal.status('7').status, 'interrupted', 'a fresh executor process cannot still be running a plan');
  journal.begin({ jobId: '8', requestId: 'r', action: { action: 'bootstrap' }, plan, planDigest: 'sha256:d' });
  journal.finish('8', { ok: false, error: 'boom' });
  assert.deepEqual([journal.status('8').status, journal.status('8').error], ['failed', 'boom']);
  assert.deepEqual(journal.status('999'), { jobId: '999', status: 'unknown' });
  assert.deepEqual(journal.status('../etc'), { jobId: '../etc', status: 'unknown' });
  assert.equal(fsImpl.entries.get('/j/8.json').mode, 0o600);
  for (let id = 100; id < 320; id += 1) journal.begin({ jobId: String(id), requestId: 'r', action: {}, plan, planDigest: 'x' });
  assert.equal(fsImpl.readdirSync('/j').length, 200);
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
  assert.deepEqual([journal.status('5').status, journal.status('5').completedOperationIds], ['completed', ['a', 'b']]);
});

test('action-status accepts only a job id and answers from the journal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-status-'));
  const socketPath = path.join(dir, 's.sock');
  const server = createExecutorServer({ logger: { info() {} }, actionStatus: (jobId) => ({ jobId, status: jobId === '3' ? 'completed' : 'unknown' }) });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    assert.equal((await actionStatus(socketPath, 3)).status, 'completed');
    assert.equal((await actionStatus(socketPath, 4)).status, 'unknown');
    await assert.rejects(() => sendRequest(socketPath, { protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(), type: 'action-status', jobId: '../x' }), (error) => error.code === 'INVALID_REQUEST');
    await assert.rejects(() => sendRequest(socketPath, { protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(), type: 'action-status', jobId: '3', plan: {} }), (error) => error.code === 'INVALID_REQUEST');
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
  store.createJob({ kind: 'install', target: 'home-source', status: 'running', dryRun: false, planJson: JSON.stringify({ action: installAction }) });
  store.createJob({ kind: 'backup', target: 'home-source', status: 'queued', dryRun: false, planJson: JSON.stringify({ action: { action: 'backup', appId: 'home-source' } }) });
  store.createJob({ kind: 'install', target: 'x', status: 'running', dryRun: false, planJson: JSON.stringify({ steps: [] }) });
  const runner = new JobRunner(store, {
    reconcile: { intervalMs: 5, maxWaitMs: 500 },
    readinessOptions: { attempts: 1, fetchImpl: async () => ({ ok: true, status: 200 }) },
    executorActionStatus: async (socket, jobId) => (String(jobId) === '1' ? { status: 'completed', plan: { operations: [] }, completedOperationIds: [] } : { status: 'unknown' }),
  });
  assert.deepEqual(runner.reconcileTypedJobs(), [1, 2], 'legacy (untyped) jobs are left alone');
  for (let i = 0; i < 100 && (store.jobs[1].status === 'running' || store.jobs[2].status === 'queued'); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.jobs[1].status, 'completed');
  assert.equal(store.installs['home-source'].status, 'installed');
  assert.equal(store.installs['home-source'].installRoot, '/opt/sovereign-home/apps/homeSource');
  assert.equal(store.jobs[2].status, 'failed');
  assert.match(store.jobs[2].errorText, /never started/);
  assert.equal(store.jobs[3].status, 'running');
});
