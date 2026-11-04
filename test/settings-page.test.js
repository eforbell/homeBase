// The Admin, Config, Status and Network pages (public/settings.js), run against a stubbed DOM and API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.js'), 'utf8');

// Runs settings.js as page `page`; getJson answers from `answers` (a path prefix to a value, or an Error).
async function renderPage(page, answers) {
  const root = { innerHTML: '', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  const asked = [];
  const getJson = async (url) => {
    asked.push(url);
    const key = Object.keys(answers).find((prefix) => url.startsWith(prefix));
    const answer = key ? answers[key] : new Error('Unlock admin on the Admin page first.');
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const window = { HB: { getJson, postJson: getJson, escapeHtml: (value) => String(value ?? ''), formatTimestamp: String } };
  const document = { getElementById: () => root, body: { getAttribute: () => page } };
  vm.runInNewContext(SOURCE, { window, document, navigator: {}, setTimeout, console });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { html: root.innerHTML, asked };
}

test('Admin renders while admin is locked: it reads only the lock state, which anyone may (SID-006)', async () => {
  const locked = { configured: true, unlocked: false, directoryState: 'active' };
  const { html, asked } = await renderPage('admin', { '/api/admin/status': locked });
  assert.deepEqual(asked, ['/api/admin/status']);
  assert.match(html, /data-passkeys/, 'the Passkeys card, where admin is unlocked');
  assert.doesNotMatch(html, /Unlock admin on the Admin page first/);
});

test('Config still says why it is empty while admin is locked', async () => {
  const { html } = await renderPage('config', { '/api/admin/status': { configured: true, unlocked: false, directoryState: 'active' } });
  assert.match(html, /Unlock admin on the Admin page first/);
});
