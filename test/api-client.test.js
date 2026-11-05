// public/api.js, the pages' API client, against a stubbed fetch: a request Home Base answers with a step-up
// runs the passkey prompt and is sent once more, identical, with the confirmation (SID-006).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'api.js'), 'utf8');
const STEP_UP = { error: 'step_up_required', policy: 'privileged-plan', level: 'every-time', kind: 'hardware', target: 'POST /x', digest: 'D'.repeat(43), message: 'Confirm with your hardware key to restart Home Source.' };

// answers: what fetch returns in turn, as [status, body]. satisfy: the prompt's result (a token, or false).
function client(answers, satisfy) {
  const sent = [];
  const prompted = [];
  const fetch = async (url, init = {}) => {
    sent.push({ url, init });
    const [status, body] = answers[Math.min(sent.length - 1, answers.length - 1)];
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  const window = { SovereignStepUp: { satisfy: async (stepUp) => { prompted.push(stepUp); return satisfy; } } };
  vm.runInNewContext(SOURCE, { window, fetch, document: {}, console });
  return { HB: window.HB, sent, prompted };
}

test('a step-up answer runs the prompt, then the identical request once more with its confirmation', async () => {
  const { HB, sent, prompted } = client([[401, STEP_UP], [202, { ok: true, jobId: 7 }]], 'the-token');
  assert.equal(JSON.stringify(await HB.postJson('/x', { dryRun: false, confirm: 'EXECUTE' })), JSON.stringify({ ok: true, jobId: 7 }));
  assert.equal(prompted.length, 1);
  assert.equal(prompted[0].target, 'POST /x');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].init.body, sent[0].init.body, 'the same bytes the confirmation is bound to');
  assert.equal(sent[1].init.headers['X-Sovereign-Action-Token'], 'the-token');
  assert.equal(sent[0].init.headers['X-Sovereign-Action-Token'], undefined);
});

test('cancelling the prompt sends nothing more; a second refusal is the answer', async () => {
  const cancelled = client([[401, STEP_UP]], false);
  await assert.rejects(cancelled.HB.postJson('/x', {}), /Cancelled: nothing ran/);
  assert.equal(cancelled.sent.length, 1);
  const twice = client([[401, STEP_UP], [401, STEP_UP]], 'stale-token');
  await assert.rejects(twice.HB.postJson('/x', {}), /Confirm with your hardware key to restart Home Source/);
  assert.equal(twice.sent.length, 2, 'one retry, never a loop');
});

test('without a step-up the client is as before: no prompt, the error\'s words', async () => {
  const plain = client([[409, { error: 'Home Source is busy.' }]], 'unused');
  await assert.rejects(plain.HB.postJson('/x', {}), /Home Source is busy/);
  assert.equal(plain.prompted.length, 0);
});
