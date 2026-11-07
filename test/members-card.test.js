// The Members card on the Admin page (public/members.js), run against a stubbed DOM and API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'members.js'), 'utf8');

const escapeHtml = (value) => String(value == null ? '' : value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const soon = () => new Date(Date.now() + 10 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

function member(overrides) {
  return { memberId: 'm_0a', userId: 'u1', login: 'parent@example.com', name: 'A Parent', role: 'parent', administrator: false, status: 'active', apps: ['family-pulse'], credentials: [], grantExpiresAt: null, ...overrides };
}

// Loads members.js with getJson answering `directory`, and postJson recording what it was asked.
function load(directory, { post = async () => ({ code: 'c0de-XYZ', expiresAt: soon() }) } = {}) {
  const posted = [];
  const window = { HB: { escapeHtml, getJson: async () => { if (directory instanceof Error) throw directory; return directory; }, postJson: async (url, body) => { posted.push([url, body]); return post(url, body); } } };
  const document = { addEventListener(type, fn) { if (type === 'submit') document.submit = fn; } };
  // Timers that don't keep the test process alive: a code's expiry is minutes away.
  const timer = (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref(); return handle; };
  vm.runInNewContext(SOURCE, { window, document, navigator: {}, console, setTimeout: timer, encodeURIComponent });
  return { members: window.HBMembers, posted, document };
}

const fakeNode = () => ({ innerHTML: '', removed: false, remove() { this.removed = true; }, addEventListener(type, fn) { this.click = fn; } });
// An element whose first child changes each time its HTML is set, as the browser's would.
function fakeSlot() {
  let html = '';
  return { firstElementChild: null, get innerHTML() { return html; }, set innerHTML(value) { html = value; this.firstElementChild = {}; } };
}
function grantButton(memberGrant, memberName, code = fakeSlot(), error = fakeSlot()) {
  return { code, error, dataset: { memberGrant, memberName }, disabled: false, textContent: '', parentElement: { querySelector: (selector) => (selector === '[data-member-code]' ? code : error) }, closest(selector) { return selector === '[data-member-grant]' ? this : null; } };
}
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test('lists every member with role, apps and whether they have a passkey; never a key', async () => {
  const directory = { state: 'active', members: [
    member({ memberId: 'm_01', name: 'Admin', administrator: true, credentials: [{ credentialId: 'k1', kind: 'hardware' }, { credentialId: 'k2', kind: 'synced' }] }),
    member({ memberId: 'm_02', name: 'Second Parent', login: 'second@example.com' }),
    member({ memberId: 'm_03', name: 'A Kid', role: 'kid', apps: [] }),
  ] };
  const { members } = load(directory);
  const node = fakeNode();
  await members.mount(node);
  assert.match(node.innerHTML, /<strong>Admin<\/strong>/);
  assert.match(node.innerHTML, /2 passkeys<\/span> · hardware key, synced passkey/);
  assert.match(node.innerHTML, />administrator</);
  assert.match(node.innerHTML, /Apps: family-pulse/);
  assert.match(node.innerHTML, /Apps: no apps/);
  assert.equal((node.innerHTML.match(/data-member-grant=/g) || []).length, 2, 'a code for each member without a passkey, not the administrator');
  assert.doesNotMatch(node.innerHTML, /k1|k2/, 'no credential IDs on the page');
});

test('a code is offered only to an active member with no usable passkey, in active Home Base', async () => {
  const offered = async (directory) => {
    const node = fakeNode();
    await load(directory).members.mount(node);
    return /data-member-grant=/.test(node.innerHTML);
  };
  assert.equal(await offered({ state: 'active', members: [member({ credentials: [{ credentialId: 'k', kind: 'synced', revokedAt: past() }] })] }), true, 'only a revoked passkey');
  assert.equal(await offered({ state: 'active', members: [member({ credentials: [{ credentialId: 'k', kind: 'synced', orphaned: true }] })] }), true, 'only one orphaned by recovery');
  assert.equal(await offered({ state: 'active', members: [member({ credentials: [{ credentialId: 'k', kind: 'synced' }] })] }), false, 'has a passkey: they add more with it');
  assert.equal(await offered({ state: 'active', members: [member({ status: 'disabled' })] }), false, 'disabled');
  assert.equal(await offered({ state: 'setup', members: [member()] }), false, 'setup: only the administrator enrolls');
  assert.equal(await offered({ state: 'recovery', members: [member()] }), false, 'recovery');
});

test('a waiting code shows its expiry, and the button replaces it', async () => {
  const node = fakeNode();
  await load({ state: 'active', members: [member({ grantExpiresAt: soon() })] }).members.mount(node);
  assert.match(node.innerHTML, /a code is waiting until/);
  assert.match(node.innerHTML, /Issue a new code/);
  const expired = fakeNode();
  await load({ state: 'active', members: [member({ grantExpiresAt: past() })] }).members.mount(expired);
  assert.doesNotMatch(expired.innerHTML, /a code is waiting/);
});

test('issuing a code posts to that member\'s grant route and shows the code once, escaped', async () => {
  const { members, posted } = load({ state: 'active', members: [member({ memberId: 'm_0a' })] }, { post: async () => ({ code: '<b>x</b>', expiresAt: soon() }) });
  const node = fakeNode();
  members.wire(node);
  const button = grantButton('m_0a', 'A <Parent>');
  const slot = button.code;
  await node.click({ target: button });
  assert.equal(JSON.stringify(posted), JSON.stringify([['/api/directory/members/m_0a/grant', {}]]), 'compared as JSON: the page runs in its own realm');
  assert.match(slot.innerHTML, /<code data-code>&lt;b&gt;x&lt;\/b&gt;<\/code>/);
  assert.match(slot.innerHTML, /for A &lt;Parent&gt;/);
  assert.match(slot.innerHTML, /won't show it again/);
  assert.equal(button.textContent, 'Issue a new code');
  assert.equal(button.disabled, false);
});

test('a refused code says why, and a code already shown stays: it is still valid and can\'t be shown again', async () => {
  let refuse = false;
  const { members } = load({ state: 'active', members: [member()] }, { post: async () => { if (refuse) throw new Error('Unlock Home Base as the administrator first.'); return { code: 'first-code', expiresAt: soon() }; } });
  const node = fakeNode();
  members.wire(node);
  const button = grantButton('m_0a', 'A Parent');
  await node.click({ target: button });
  assert.match(button.code.innerHTML, /first-code/);
  refuse = true;
  await node.click({ target: button });
  assert.match(button.code.innerHTML, /first-code/, 'kept');
  assert.match(button.error.innerHTML, /hb-warn.*Unlock Home Base/);
  refuse = false;
  await node.click({ target: button });
  assert.equal(button.error.innerHTML, '', 'a success clears the error');
});

test('locking admin clears the card at once, codes included', async () => {
  const { members, document } = load({ state: 'active', members: [member()] });
  const node = fakeNode();
  members.wire(node);
  await members.mount(node);
  node.innerHTML += '<code data-code>live-code</code>';
  document.submit({ target: { closest: (selector) => (selector === 'form[data-action="admin-lock"]' ? {} : null) } });
  assert.doesNotMatch(node.innerHTML, /live-code|A Parent/);
  assert.match(node.innerHTML, /Unlock admin to see members/);
  document.submit({ target: { closest: () => null } });
  assert.match(node.innerHTML, /Unlock admin to see members/, 'other forms change nothing');
});

test('a directory answer that arrives after a lock or the session\'s end doesn\'t bring the card back', async () => {
  let answer;
  const pending = new Promise((resolve) => { answer = resolve; });
  const { members, document } = load(pending);
  const node = fakeNode();
  members.wire(node);
  const mounting = members.mount(node);
  document.submit({ target: { closest: (selector) => (selector === 'form[data-action="admin-lock"]' ? {} : null) } });
  answer({ state: 'active', members: [member()] });
  assert.equal(await mounting, null);
  assert.doesNotMatch(node.innerHTML, /A Parent/);
  let later;
  const slow = new Promise((resolve) => { later = resolve; });
  const ended = fakeNode();
  const ending = load(slow).members.mount(ended, { sessionExpiresAt: past() });
  await tick();
  later({ state: 'active', members: [member()] });
  await ending;
  assert.doesNotMatch(ended.innerHTML, /A Parent/);
  assert.match(ended.innerHTML, /Unlock admin to see members/);
});

test('the card clears when the admin session ends, and a code when it expires', async () => {
  const { members } = load({ state: 'active', members: [member()] }, { post: async () => ({ code: 'short-lived', expiresAt: past() }) });
  const node = fakeNode();
  await members.mount(node, { sessionExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  await tick();
  assert.match(node.innerHTML, /A Parent/, 'still open');
  members.wire(node);
  const button = grantButton('m_0a', 'A Parent');
  await node.click({ target: button });
  await tick();
  assert.match(button.code.innerHTML, /That code has expired/);
  const ending = fakeNode();
  await load({ state: 'active', members: [member()] }).members.mount(ending, { sessionExpiresAt: past() });
  await tick();
  assert.match(ending.innerHTML, /Unlock admin to see members/);
});

test('names and logins are escaped', async () => {
  const node = fakeNode();
  await load({ state: 'active', members: [member({ name: '<img src=x onerror=1>', login: '"><script>' })] }).members.mount(node);
  assert.doesNotMatch(node.innerHTML, /<img|<script/);
});

test('anyone but an unlocked administrator gets no card: the directory tells them only its state', async () => {
  const node = fakeNode();
  assert.equal(await load({ state: 'active', caller: { login: 'x', member: true, admitted: true } }).members.mount(node), null);
  assert.equal(node.removed, true);
});
