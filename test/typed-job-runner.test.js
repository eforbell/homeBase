const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForAppReadiness } = require('../src/services/job-runner');
const { getAppById } = require('../src/catalog');

test('readiness probes only loopback at the catalog port and path', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200 }; };
  await waitForAppReadiness({ app: getAppById('family-dinner'), attempts: 1, fetchImpl });
  await waitForAppReadiness({ app: getAppById('home-source'), attempts: 1, fetchImpl });
  assert.deepEqual(calls, ['http://127.0.0.1:3000/api/ready', 'http://127.0.0.1:3008/api/ready']);
  await assert.rejects(() => waitForAppReadiness({ app: { name: 'x', network: { preferredPort: 80, health: { readinessPath: '@evil.example/' } } }, attempts: 1, fetchImpl }), (error) => error.code === 'READINESS_FAILED');
});

test('readiness fails closed after bounded unsuccessful responses', async () => {
  await assert.rejects(() => waitForAppReadiness({ app: getAppById('family-dinner'), attempts: 1, fetchImpl: async () => ({ ok: false, status: 503 }) }), (error) => error.code === 'READINESS_FAILED');
});

test('typed job source never delegates to the legacy shell runner and never sends plans or secrets', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../src/services/job-runner'), 'utf8');
  const typedSection = source.slice(source.indexOf('startTypedActionJob'), source.indexOf('startBackupJob'));
  assert.ok(typedSection.length > 0);
  assert.doesNotMatch(typedSection, /runCommand\(/);
  assert.doesNotMatch(typedSection, /\/bin\/(bash|sh)/);
  assert.doesNotMatch(typedSection, /secretBindings|executePlan/);
  assert.match(typedSection, /this\.runExecutorAction\(/);
});

test('typed jobs record the executor-accepted plan and complete through the shared settle step', async () => {
  const { JobRunner } = require('../src/services/job-runner');
  const jobs = {};
  const store = {
    createJob: (job) => { const id = Object.keys(jobs).length + 1; jobs[id] = { ...job, log: '' }; return { id }; },
    updateJob: (id, fields) => Object.assign(jobs[id], fields),
    appendJobLog: (id, text) => { jobs[id].log += text; },
  };
  const sent = [];
  const runner = new JobRunner(store, {
    executorSocket: '/tmp/none.sock',
    runExecutorAction: async (socket, fields, { onEvent }) => {
      sent.push(fields);
      onEvent({ eventType: 'plan.accepted', planDigest: 'sha256:abc', plan: { operations: [{ id: 'op', secretRefs: [] }] } });
      onEvent({ eventType: 'operation.completed', operationId: 'op' });
      return { planDigest: 'sha256:abc', completedOperationIds: ['op'] };
    },
  });
  let completedCallbacks = 0;
  const id = runner.startTypedActionJob({ kind: 'bootstrap', target: 'local-host', action: { action: 'bootstrap' }, onComplete: () => { completedCallbacks += 1; } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
  assert.deepEqual({ ...sent[0], requestId: undefined }, { jobId: id, action: 'bootstrap', requestId: undefined });
  assert.equal(sent[0].requestId, JSON.parse(jobs[id].planJson).requestId, 'the stored nonce is the one sent');
  const stored = JSON.parse(jobs[id].planJson);
  assert.equal(stored.planDigest, 'sha256:abc');
  assert.equal(stored.digestVerified, false, 'a digest that does not match the recorded plan is flagged');
  assert.equal(stored.operationPlan.operations[0].id, 'op');
  assert.equal(completedCallbacks, 1);
  assert.equal(jobs[id].status, 'completed');

  const failing = new JobRunner(store, { busyRetry: { attempts: 1, delayMs: 1 }, runExecutorAction: async () => { throw Object.assign(new Error('Another mutation plan is active.'), { code: 'EXECUTOR_BUSY' }); } });
  const failedId = failing.startTypedBootstrapJob();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(jobs[failedId].status, 'failed');
  assert.match(jobs[failedId].log, /Another mutation plan is active/);
});

test('typed jobs wait out a briefly busy executor, then run; persistent busy still fails', async () => {
  const { JobRunner } = require('../src/services/job-runner');
  const { digestOperationPlan } = require('../src/operations/digest');
  const jobs = {};
  const store = {
    createJob: (job) => { const id = Object.keys(jobs).length + 1; jobs[id] = { ...job, log: '' }; return { id }; },
    updateJob: (id, fields) => Object.assign(jobs[id], fields),
    appendJobLog: (id, text) => { jobs[id].log += text; },
  };
  const plan = { operations: [{ id: 'op', secretRefs: ['familyDinnerDatabasePassword'], passwordSecretRef: 'familyDinnerDatabasePassword' }] };
  let calls = 0;
  const runner = new JobRunner(store, {
    busyRetry: { attempts: 3, delayMs: 1 },
    runExecutorAction: async (socket, fields, { onEvent }) => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('Another mutation plan is active.'), { code: 'EXECUTOR_BUSY' });
      onEvent({ eventType: 'plan.accepted', planDigest: digestOperationPlan(plan), plan });
      return { completedOperationIds: ['op'] };
    },
  });
  const id = runner.startTypedBootstrapJob();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 3);
  assert.equal(jobs[id].status, 'completed');
  const stored = JSON.parse(jobs[id].planJson);
  assert.equal(stored.digestVerified, true);
  assert.deepEqual(stored.operationPlan, plan, 'the accepted plan is stored verbatim, including secret ref names');

  const alwaysBusy = new JobRunner(store, { busyRetry: { attempts: 2, delayMs: 1 }, runExecutorAction: async () => { throw Object.assign(new Error('busy'), { code: 'EXECUTOR_BUSY' }); } });
  const busyId = alwaysBusy.startTypedBootstrapJob();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(jobs[busyId].status, 'failed');
});

test('a completed adopt records the app as executor-managed, only after readiness', async () => {
  const { JobRunner } = require('../src/services/job-runner');
  const jobs = {};
  const upserts = [];
  const store = {
    createJob: (job) => { const id = Object.keys(jobs).length + 1; jobs[id] = { ...job, log: '' }; return { id }; },
    updateJob: (id, fields) => Object.assign(jobs[id], fields),
    appendJobLog: (id, text) => { jobs[id].log += text; },
    upsertInstallation: (record) => upserts.push(record),
  };
  const probes = [];
  const runner = new JobRunner(store, {
    runExecutorAction: async () => ({ planDigest: 'sha256:x', completedOperationIds: [] }),
    readinessOptions: { attempts: 1, fetchImpl: async (url) => { probes.push(url); return { ok: true, status: 200 }; } },
  });
  const site = { hostname: 'home', domain: 'example.ts.net', householdTimezone: 'America/New_York' };
  const id = runner.startTypedAdoptJob({ appId: 'helm', ref: 'main', transport: 'ssh', site });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(jobs[id].status, 'completed');
  assert.deepEqual(probes, ['http://127.0.0.1:3011/health']);
  assert.equal(upserts.length, 1);
  assert.deepEqual([upserts[0].appId, upserts[0].status, upserts[0].managedBy, upserts[0].externalUrl], ['helm', 'installed', 'executor', 'https://home.example.ts.net/helm/']);
});
