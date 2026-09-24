const test = require('node:test');
const assert = require('node:assert/strict');
const { executePlan, getFailureOutput, MAX_FAILURE_OUTPUT_CHARS } = require('../executor/execute');
const { appendExecutorEventLog } = require('../src/services/job-runner');

test('executor failure events include bounded, redacted process diagnostics', async () => {
  const secret = 'canary-password';
  const events = [];
  const error = new Error('Approved process exited with code 100.');
  error.code = 'OPERATION_FAILED';
  error.output = {
    stderr: `apt-get update failed for ${secret}`,
    stdout: 'Reading package lists... Done',
    truncated: false,
  };

  await assert.rejects(() => executePlan({
    secretBindings: { familyDinnerDatabasePassword: secret },
    plan: { operations: [{ id: 'install-packages', type: 'package.ensure', dependsOn: [], executor: 'executor' }] },
  }, {
    handlers: { 'package.ensure': async () => { throw error; } },
    emit: (event) => events.push(event),
  }), /exited with code 100/);

  const failure = events.at(-1);
  assert.equal(failure.eventType, 'operation.failed');
  assert.equal(failure.code, 'OPERATION_FAILED');
  assert.match(failure.output, /apt-get update failed/);
  assert.match(failure.output, /\[REDACTED\]/);
  assert.doesNotMatch(failure.output, new RegExp(secret));
});

test('executor failure diagnostics preserve the tail within a protocol-safe bound', () => {
  const tail = 'apt failure detail';
  const failure = getFailureOutput({ output: { stderr: `${'x'.repeat(MAX_FAILURE_OUTPUT_CHARS + 100)}${tail}`, truncated: false } }, []);

  assert.equal(failure.truncated, true);
  assert.match(failure.output, new RegExp(tail));
  assert.ok(failure.output.length <= MAX_FAILURE_OUTPUT_CHARS + 80);
});

test('job logging persists executor diagnostics with another redaction pass', () => {
  const entries = [];
  appendExecutorEventLog({ appendJobLog: (_id, text) => entries.push(text) }, 12, {
    eventType: 'operation.failed',
    operationId: 'install-packages',
    output: 'apt failure for canary-password',
    truncated: true,
  }, { familyDinnerDatabasePassword: 'canary-password' });

  const combined = entries.join('');
  assert.match(combined, /diagnostic output install-packages \(truncated\)/);
  assert.match(combined, /\[REDACTED\]/);
  assert.doesNotMatch(combined, /canary-password/);
});
