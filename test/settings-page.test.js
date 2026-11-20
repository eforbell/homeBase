// The Admin, Config, Status and Network pages (public/settings.js), run against a stubbed DOM and API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.js'), 'utf8');

// Runs settings.js as page `page`; getJson answers from `answers` (a path prefix to a value, or an Error).
async function renderPage(page, answers, { passkeys = null } = {}) {
  const node = { innerHTML: '' };
  const root = { innerHTML: '', addEventListener() {}, querySelector: (selector) => (passkeys && selector === '[data-passkeys]' && root.innerHTML.includes('data-passkeys') ? node : null), querySelectorAll: () => [] };
  const asked = [];
  const getJson = async (url) => {
    asked.push(url);
    const key = Object.keys(answers).find((prefix) => url.startsWith(prefix));
    const answer = key ? answers[key] : new Error('Unlock admin on the Admin page first.');
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const window = { HB: { getJson, postJson: getJson, escapeHtml: (value) => String(value ?? ''), formatTimestamp: String }, ...(passkeys ? { HBPasskeys: passkeys } : {}) };
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

test('the Members card is on Admin only for an unlocked administrator with the directory on', async () => {
  const unlocked = await renderPage('admin', { '/api/admin/status': { configured: true, unlocked: true, directoryState: 'active', sessionExpiresAt: new Date().toISOString() }, '/api/admin/audit': { entries: [] } });
  assert.match(unlocked.html, /data-members/);
  const locked = await renderPage('admin', { '/api/admin/status': { configured: true, unlocked: false, directoryState: 'active' } });
  assert.doesNotMatch(locked.html, /data-members/);
  const noDirectory = await renderPage('admin', { '/api/admin/status': { configured: true, unlocked: true } });
  assert.doesNotMatch(noDirectory.html, /data-members/);
});

test('Config still says why it is empty while admin is locked', async () => {
  const { html } = await renderPage('config', { '/api/admin/status': { configured: true, unlocked: false, directoryState: 'active' } });
  assert.match(html, /Unlock admin on the Admin page first/);
});

// passkeys.js, as far as settings.js uses it: focused until mount decides the code doesn't fit (fits: false).
function passkeysStub({ fits }) {
  let focused = true;
  const calls = [];
  return {
    calls,
    focused: () => focused,
    unfocus: () => { focused = false; },
    wire: () => { calls.push('wire'); },
    mount: async () => { calls.push('mount'); if (!fits) focused = false; return {}; },
  };
}

test('Admin opened with an enrollment code that fits: only the passkey card, and nothing else of Admin is read', async () => {
  const passkeys = passkeysStub({ fits: true });
  const { html, asked } = await renderPage('admin', { '/api/admin/status': { configured: true, unlocked: false, directoryState: 'active' } }, { passkeys });
  assert.deepEqual(asked, [], 'not even the lock state');
  assert.match(html, /<section class="hb-card" data-passkeys>/);
  assert.doesNotMatch(html, /data-members|Admin audit/);
  assert.deepEqual(passkeys.calls, ['wire', 'mount']);
});

test('a code that doesn\'t fit: the full Admin, as without one', async () => {
  const passkeys = passkeysStub({ fits: false });
  const { html, asked } = await renderPage('admin', { '/api/admin/status': { configured: true, unlocked: false, directoryState: 'active' } }, { passkeys });
  assert.deepEqual(asked, ['/api/admin/status']);
  assert.match(html, /data-passkeys/);
  assert.equal(passkeys.focused(), false);
});

test('a failure while focused shows the Admin error with the navigation back', async () => {
  const passkeys = passkeysStub({ fits: true });
  passkeys.mount = async () => { throw new Error('Request failed (500)'); };
  const { html } = await renderPage('admin', {}, { passkeys });
  assert.equal(passkeys.focused(), false);
  assert.match(html, /Request failed \(500\)/);
});

test('Config offers a saved timezone outside its list as itself, so saving keeps it', async () => {
  const render = (householdTimezone) => renderPage('config', {
    '/api/admin/status': { configured: true, unlocked: true, sessionExpiresAt: new Date().toISOString() },
    '/api/homebase/config': { hostname: 'homebase', domain: 'tailnet', householdTimezone, ingress: { instance: null, cutOver: false } },
    '/api/homebase/status': { systemd: { active: 'active' } },
    '/api/preflight': { checks: [] },
  });
  const london = (await render('Europe/London')).html;
  assert.match(london, /<option value="Europe\/London" selected>Europe\/London<\/option>/);
  const chicago = (await render('America/Chicago')).html;
  assert.match(chicago, /<option value="America\/Chicago" selected>/);
  assert.doesNotMatch(chicago, /<option value="America\/Chicago" selected>America\/Chicago<\/option>/, 'a listed zone is not offered twice');
});
