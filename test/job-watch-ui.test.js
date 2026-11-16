// The pages watch a job they started until it finishes (public/api.js watchJob). A read that fails while the job
// runs (an install reloads nginx and keeps the host busy; a Home Base update restarts it) must not end the watch,
// or the page shows that one error, never repaints, and leaves its form disabled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');

// api.js in a page of its own, with /api/jobs/:id answering from `answers` in turn (the last one repeats).
function page(answers) {
  const reads = [];
  const fetch = async (url) => {
    reads.push(url);
    const [status, body] = answers[Math.min(reads.length - 1, answers.length - 1)];
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  const window = {};
  vm.runInNewContext(read('api.js'), { window, fetch, document: {}, setTimeout: (fn) => setImmediate(fn), console });
  return { HB: window.HB, reads };
}

const LOCKED = [401, { error: 'Unlock admin on the Admin page first.', code: 'ADMIN_UNLOCK_REQUIRED' }];
const running = [200, { id: 93, status: 'running' }];
const done = [200, { id: 93, status: 'completed' }];

test('a read that fails while the job runs does not end the watch', async () => {
  const { HB, reads } = page([LOCKED, running, LOCKED, LOCKED, running, done]);
  const node = { innerHTML: '' };
  const job = await HB.watchJob(93, node);
  assert.equal(job.status, 'completed');
  assert.equal(reads.length, 6);
  assert.match(node.innerHTML, /Job <a href="\/jobs\/93">#93<\/a> completed\./);
});

test('while a read fails, the page says it is checking again', async () => {
  const { HB } = page([LOCKED, done]);
  const seen = [];
  const node = { set innerHTML(value) { seen.push(value); }, get innerHTML() { return seen.at(-1); } };
  await HB.watchJob(93, node);
  assert.match(seen[0], /#93<\/a>: checking again \(Unlock admin on the Admin page first\.\)\.\.\./);
});

test('reads that keep failing stop the watch with the reason and a way to the job', async () => {
  const { HB, reads } = page([LOCKED]);
  const node = { innerHTML: '' };
  assert.equal(await HB.watchJob(93, node), null);
  assert.equal(reads.length, 20);
  assert.match(node.innerHTML, /^Lost track of job <a href="\/jobs\/93">#93<\/a> \(Unlock admin on the Admin page first\.\)\. Open the job for details/);
});

test('a job still running after every attempt says so', async () => {
  const { HB } = page([running]);
  const node = { innerHTML: '' };
  assert.equal(await HB.watchJob(93, node, { attempts: 3 }), null);
  assert.match(node.innerHTML, /#93<\/a> is still running\. Open the job for details\./);
});

test('every page watches jobs through api.js, and a form it disabled is released however the watch ends', () => {
  for (const name of ['app-detail.js', 'apps.js', 'settings.js']) {
    const source = read(name);
    assert.match(source, /window\.HB\.watchJob\(jobId, resultNode\)/, name);
    assert.doesNotMatch(source, /\/api\/jobs\//, `${name} reads jobs only through watchJob`);
    assert.doesNotMatch(source, /onComplete: \(\) => \{\s*(?:if \(form\) )?form\.dataset\.submitting = 'false'/, `${name}: release in finally, not only on completion`);
  }
  for (const name of ['app-detail.js', 'apps.js']) {
    assert.match(read(name), /\{ onComplete: \(\) => load\(\) \}\)\.finally\(\(\) => \{\n\s+form\.dataset\.submitting = 'false';\n\s+if \(submitButton\) submitButton\.disabled = false;/, name);
  }
  assert.match(read('settings.js'), /\{ onComplete: \(\) => load\(\) \}\)\.finally\(\(\) => \{\n\s+if \(form\) form\.dataset\.submitting = 'false';\n\s+buttons\.forEach/);
});
