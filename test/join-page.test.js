// public/join.js: the join page, run against a stubbed DOM and /api/home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

async function renderJoin(home, { clipboard = null, origin = 'https://smith-homebase.example.ts.net' } = {}) {
  const status = { textContent: '' };
  let click = null;
  const root = {
    innerHTML: '',
    addEventListener: (type, fn) => { if (type === 'click') click = fn; },
    querySelector: (selector) => (selector === '[data-join-copied]' ? status : null),
  };
  const document = { title: '', getElementById: (id) => (id === 'app' ? root : null) };
  const written = [];
  const window = {
    location: { origin, host: new URL(origin).host, hostname: new URL(origin).hostname },
    navigator: clipboard ? { clipboard: { writeText: async (text) => { written.push(text); } } } : {},
  };
  const context = vm.createContext({ window, document, console,
    fetch: async (url) => {
      assert.equal(url, '/api/home');
      if (home instanceof Error) throw home;
      return { ok: true, text: async () => JSON.stringify(home) };
    },
  });
  // qrcode-generator defines a global `qrcode`, which in a browser is window.qrcode.
  for (const name of ['api.js', 'qrcode-generator.js']) vm.runInContext(read(name), context, { filename: name });
  window.qrcode = context.qrcode;
  vm.runInContext(read('join.js'), context, { filename: 'join.js' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { root, document, status, written, click: async () => { click({ target: { closest: (s) => (s === '[data-join-copy]' ? {} : null) } }); await new Promise((r) => setImmediate(r)); } };
}

test('the join page names the household and shows its address, as text and as the code', async () => {
  const page = await renderJoin({ state: 'unidentified', caller: null, household: 'The <Smiths>' });
  assert.match(page.root.innerHTML, /<h1 style="margin:0;">Join The &lt;Smiths&gt;<\/h1>/);
  assert.equal(page.document.title, 'Join The <Smiths> - Home Base');
  assert.match(page.root.innerHTML, /<code data-join-host>smith-homebase\.example\.ts\.net<\/code>/);
  assert.match(page.root.innerHTML, /Scan code/);
  assert.match(page.root.innerHTML, /<svg data-join-qr role="img"[^>]*><rect[^>]*\/><path d="M/, 'the QR code is drawn');
  assert.match(page.root.innerHTML, /<a class="hb-btn" href="\/">Open Home Base here<\/a>/);
});

test('without a household name, or when /api/home fails, the page still works', async () => {
  for (const home of [{ state: 'legacy' }, new Error('offline')]) {
    const page = await renderJoin(home);
    assert.match(page.root.innerHTML, /Join your household/);
    assert.match(page.root.innerHTML, /smith-homebase\.example\.ts\.net/);
  }
});

test('before the cutover, the address keeps Home Base\'s port', async () => {
  const page = await renderJoin({ state: 'waiting' }, { clipboard: true, origin: 'https://homebase.example.ts.net:3080' });
  assert.match(page.root.innerHTML, /<code data-join-host>homebase\.example\.ts\.net:3080<\/code>/);
  await page.click();
  assert.deepEqual(page.written, ['homebase.example.ts.net:3080']);
});

test('Copy address copies the host, and shows it where there is no clipboard', async () => {
  const withClipboard = await renderJoin({ state: 'waiting' }, { clipboard: true });
  await withClipboard.click();
  assert.deepEqual(withClipboard.written, ['smith-homebase.example.ts.net']);
  assert.equal(withClipboard.status.textContent, 'Copied.');
  const without = await renderJoin({ state: 'waiting' });
  await without.click();
  assert.equal(without.status.textContent, 'smith-homebase.example.ts.net');
});
