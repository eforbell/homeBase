const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForDinnerReadiness } = require('../src/services/job-runner');

test('Dinner readiness accepts only the fixed loopback endpoint', async () => {
  const calls = [];
  await waitForDinnerReadiness({ attempts: 1, fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200 }; } });
  assert.deepEqual(calls, ['http://127.0.0.1:3000/api/ready']);
});

test('Dinner readiness fails closed after bounded unsuccessful responses', async () => {
  await assert.rejects(() => waitForDinnerReadiness({ attempts: 1, fetchImpl: async () => ({ ok: false, status: 503 }) }), (error) => error.code === 'READINESS_FAILED');
});

test('typed Dinner job source never delegates to the legacy shell command runner', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../src/services/job-runner'), 'utf8');
  const typedSection = source.slice(source.indexOf('startTypedDinnerInstallJob'), source.indexOf('startBackupJob'));
  assert.doesNotMatch(typedSection, /runCommand\(/);
  assert.doesNotMatch(typedSection, /\/bin\/(bash|sh)/);
  assert.match(typedSection, /redactPlan/);
});
