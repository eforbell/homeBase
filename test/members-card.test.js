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

// Loads members.js with getJson answering `directory` (or what the function `directory` gives, each read), and postJson recording what it was asked.
function load(directory, { post = async () => ({ code: 'c0de-XYZ', expiresAt: soon() }) } = {}) {
  const posted = [];
  const window = { HB: { escapeHtml, getJson: async () => { const answer = typeof directory === 'function' ? await directory() : directory; if (answer instanceof Error) throw answer; return answer; }, postJson: async (url, body) => { posted.push([url, body]); return post(url, body); } } };
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

const candidate = (overrides) => ({ userId: 'u9', login: 'newcomer@example.com', name: 'New Comer', seenAt: past(), ...overrides });

// An Add member button inside its candidate row, with the role and name the administrator chose.
function addButton(userId, { role = '', name = 'New Comer' } = {}) {
  const error = fakeSlot();
  const fields = { '[data-member-error]': error, '[data-candidate-role]': { value: role }, '[data-candidate-name]': { value: name } };
  const row = { querySelector: (selector) => fields[selector] };
  return { error, dataset: { memberAdd: userId }, disabled: false, closest(selector) { if (selector === '[data-member-add]') return this; if (selector === '[data-candidate]') return row; return null; } };
}

test('accounts that opened Home Base are offered to add, with a role to choose and no default', async () => {
  const node = fakeNode();
  await load({ state: 'active', members: [member()], candidates: [candidate({ name: '<i>x</i>' })] }).members.mount(node);
  assert.match(node.innerHTML, /Add a member/);
  assert.match(node.innerHTML, /data-member-add="u9"/);
  assert.match(node.innerHTML, /<option value="" selected disabled>Choose…<\/option>/);
  assert.doesNotMatch(node.innerHTML, /value="(parent|kid)" selected/, 'neither role is preselected');
  assert.doesNotMatch(node.innerHTML, /<i>x<\/i>/, 'the name is escaped');
  const none = fakeNode();
  await load({ state: 'active', members: [member()], candidates: [] }).members.mount(none);
  assert.match(none.innerHTML, /No one new has opened Home Base yet/);
  assert.match(none.innerHTML, /data-members-refresh/);
});

test('adding is offered only while Home Base is in setup or active, as the directory allows', async () => {
  for (const [state, offered] of [['setup', true], ['active', true], ['recovery', false], ['bootstrap', false]]) {
    const node = fakeNode();
    await load({ state, members: [member()], candidates: [candidate()] }).members.mount(node);
    assert.equal(/Add a member/.test(node.innerHTML), offered, state);
  }
});

test('adding a member posts the account, role and name, then shows the directory again', async () => {
  let directory = { state: 'active', members: [member()], candidates: [candidate()] };
  const { members, posted } = load(new Proxy({}, { get: (_, key) => directory[key] }), { post: async () => {
    directory = { state: 'active', members: [member(), member({ memberId: 'm_0b', userId: 'u9', name: 'Kiddo', role: 'kid' })], candidates: [] };
    return { ok: true, memberId: 'm_0b' };
  } });
  const node = fakeNode();
  members.wire(node);
  await members.mount(node);
  const button = addButton('u9', { role: 'kid', name: '  Kiddo  ' });
  await node.click({ target: button });
  assert.equal(JSON.stringify(posted), JSON.stringify([['/api/directory/members', { userId: 'u9', role: 'kid', name: 'Kiddo' }]]));
  assert.match(node.innerHTML, /<strong>Kiddo<\/strong>/, 'listed as a member');
  assert.match(node.innerHTML, /data-member-grant="m_0b"/, 'and offered an enrollment code');
  assert.doesNotMatch(node.innerHTML, /data-member-add=/, 'no longer a candidate');
});

test('adding without a role asks for one and posts nothing; a refusal says why and leaves the row', async () => {
  const { members, posted } = load({ state: 'active', members: [member()], candidates: [candidate()] }, { post: async () => { throw new Error('That account is already a member.'); } });
  const node = fakeNode();
  members.wire(node);
  await members.mount(node);
  const unchosen = addButton('u9');
  await node.click({ target: unchosen });
  assert.equal(posted.length, 0);
  assert.match(unchosen.error.innerHTML, /Choose parent or kid/);
  const refused = addButton('u9', { role: 'parent', name: '' });
  await node.click({ target: refused });
  assert.equal(JSON.stringify(posted), JSON.stringify([['/api/directory/members', { userId: 'u9', role: 'parent' }]]), 'an empty name is left to Home Base');
  assert.match(refused.error.innerHTML, /hb-warn.*already a member/);
  assert.equal(refused.disabled, false);
  assert.match(node.innerHTML, /data-member-add="u9"/, 'the row stays to try again');
});

function refreshButton() {
  const error = fakeSlot();
  return { error, disabled: false, parentElement: { querySelector: () => error }, closest(selector) { return selector === '[data-members-refresh]' ? this : null; } };
}

// A Home Base with one member that holds the waiting code's expiry as the directory does: each code it issues
// replaces the last, in the order asked. answer(i) settles the i-th request when `held`; otherwise each answers at once.
function fakeHomeBase(codes, { held = false, ...overrides } = {}) {
  const state = { state: 'active', members: [member(overrides)], candidates: [] };
  const answers = [];
  const post = (url) => {
    const grant = codes[answers.length];
    state.members[0] = { ...state.members[0], grantExpiresAt: grant.expiresAt };
    return new Promise((resolve) => { answers.push(() => resolve(grant)); if (!held) resolve(grant); });
  };
  return { state, read: () => JSON.parse(JSON.stringify(state)), post, answer: (i) => answers[i]() };
}
const lockEvent = { target: { closest: (selector) => (selector === 'form[data-action="admin-lock"]' ? {} : null) } };

test('a code on screen stays when the card is drawn again, until it expires, is used or is replaced elsewhere', async () => {
  const at = new Date(Date.now() + 10 * 60_000).toISOString();
  const hb = fakeHomeBase([{ code: 'still-valid', expiresAt: at }]);
  const { members } = load(hb.read, { post: hb.post });
  const node = fakeNode();
  members.wire(node);
  await members.mount(node);
  await node.click({ target: grantButton('m_0a', 'A Parent') });
  await node.click({ target: refreshButton() });
  assert.match(node.innerHTML, /<code data-code>still-valid<\/code>/, 'kept: Home Base can\'t show it again');
  hb.state.members[0].grantExpiresAt = new Date(Date.now() + 12 * 60_000).toISOString();
  await node.click({ target: refreshButton() });
  assert.doesNotMatch(node.innerHTML, /still-valid/, 'replaced from another tab: the directory waits on a different code');
  hb.state.members[0].grantExpiresAt = at;
  hb.state.members[0].status = 'disabled';
  await node.click({ target: refreshButton() });
  assert.doesNotMatch(node.innerHTML, /still-valid/, 'the member can\'t use it now');
  hb.state.members[0] = member({ grantExpiresAt: null, credentials: [{ credentialId: 'k', kind: 'synced' }] });
  await node.click({ target: refreshButton() });
  assert.doesNotMatch(node.innerHTML, /still-valid/, 'used: the member has a passkey and no code waits');

  const expiring = fakeHomeBase([{ code: 'gone-soon', expiresAt: new Date(Date.now() + 30).toISOString() }]);
  const other = load(expiring.read, { post: expiring.post });
  const otherNode = fakeNode();
  other.members.wire(otherNode);
  await other.members.mount(otherNode);
  await otherNode.click({ target: grantButton('m_0a', 'A Parent') });
  await tick(60);
  await otherNode.click({ target: refreshButton() });
  assert.doesNotMatch(otherNode.innerHTML, /gone-soon/, 'expired');
  // A background tab's timers run late: a redraw before the expiry timer fires still leaves an expired code out.
  const late = fakeHomeBase([{ code: 'timer-late', expiresAt: past() }]);
  const lateCard = load(late.read, { post: late.post });
  const lateNode = fakeNode();
  lateCard.members.wire(lateNode);
  await lateCard.members.mount(lateNode);
  await lateNode.click({ target: grantButton('m_0a', 'A Parent') });
  await lateNode.click({ target: refreshButton() });
  assert.doesNotMatch(lateNode.innerHTML, /timer-late/, 'expired, timer or not');
});

test('a code drawn again expires where it is drawn now', async () => {
  const hb = fakeHomeBase([{ code: 'redrawn', expiresAt: new Date(Date.now() + 40).toISOString() }]);
  const { members } = load(hb.read, { post: hb.post });
  const live = { innerHTML: '', querySelector: (selector) => (selector === '[data-code]' && /redrawn/.test(live.innerHTML) ? {} : null) };
  const asked = [];
  const node = { ...fakeNode(), querySelector(selector) { asked.push(selector); live.innerHTML = '<code data-code>redrawn</code>'; return live; } };
  members.wire(node);
  await members.mount(node);
  const first = grantButton('m_0a', 'A Parent');
  await node.click({ target: first });
  await node.click({ target: refreshButton() });
  await tick(80);
  assert.deepEqual(asked, ['[data-member="m_0a"] [data-member-code]']);
  assert.match(live.innerHTML, /That code has expired/, 'the slot drawn now');
});

test('locking forgets the codes shown, and one still being issued: a card unlocked again doesn\'t draw them', async () => {
  const at = soon();
  const hb = fakeHomeBase([{ code: 'before-lock', expiresAt: at }]);
  const { members, document } = load(hb.read, { post: hb.post });
  const node = fakeNode();
  members.wire(node);
  await members.mount(node);
  await node.click({ target: grantButton('m_0a', 'A Parent') });
  document.submit(lockEvent);
  const again = fakeNode();
  await members.mount(again);
  assert.match(again.innerHTML, /A Parent/);
  assert.doesNotMatch(again.innerHTML, /before-lock/);

  const pending = fakeHomeBase([{ code: 'during-lock', expiresAt: at }], { held: true });
  const second = load(pending.read, { post: pending.post });
  const card = fakeNode();
  second.members.wire(card);
  await second.members.mount(card);
  const button = grantButton('m_0a', 'A Parent');
  const issuing = card.click({ target: button });
  second.document.submit(lockEvent);
  pending.answer(0);
  await issuing;
  assert.doesNotMatch(button.code.innerHTML, /during-lock/, 'not shown');
  const unlocked = fakeNode();
  await second.members.mount(unlocked);
  assert.doesNotMatch(unlocked.innerHTML, /during-lock/, 'not remembered');
});

test('one action at a time: while a code is issued, the card isn\'t read, added to or asked for another code', async () => {
  const hb = fakeHomeBase([{ code: 'in-flight', expiresAt: soon() }, { code: 'second', expiresAt: soon() }], { held: true });
  let reads = 0;
  const posts = [];
  const { members } = load(() => { reads += 1; return { ...hb.read(), candidates: [candidate()] }; }, { post: (url, body) => { posts.push(url); return hb.post(url, body); } });
  const node = { ...fakeNode(), attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
  members.wire(node);
  await members.mount(node);
  const button = grantButton('m_0a', 'A Parent');
  const issuing = node.click({ target: button });
  assert.equal(node.attributes['aria-busy'], 'true');
  await node.click({ target: refreshButton() });
  await node.click({ target: addButton('u9', { role: 'kid' }) });
  await node.click({ target: grantButton('m_0a', 'A Parent') });
  assert.equal(reads, 1, 'no read while issuing');
  assert.deepEqual(posts, ['/api/directory/members/m_0a/grant'], 'no add and no second code');
  hb.answer(0);
  await issuing;
  assert.match(button.code.innerHTML, /in-flight/, 'the code lands in the row it was asked from');
  assert.equal(node.attributes['aria-busy'], 'false');
  await node.click({ target: refreshButton() });
  assert.equal(reads, 2, 'open again once it answered');
  assert.match(node.innerHTML, /in-flight/);
});

test('only the latest read of the directory is drawn: an earlier one answering late is dropped', async () => {
  const answers = [];
  const { members } = load(() => new Promise((resolve) => answers.push(resolve)));
  const node = fakeNode();
  const first = members.mount(node);
  const second = members.mount(node);
  answers[1]({ state: 'active', members: [member({ name: 'Newer' })] });
  await second;
  answers[0]({ state: 'active', members: [member({ name: 'Older' })] });
  assert.equal(await first, null);
  assert.match(node.innerHTML, /Newer/);
  assert.doesNotMatch(node.innerHTML, /Older/);
});

test('a failed re-read keeps the card: Check again says why and can be pressed again; an add says it went through', async () => {
  let fail = false;
  const { members } = load(() => (fail ? new Error('Home Base did not answer.') : { state: 'active', members: [member()], candidates: [candidate()] }), { post: async () => ({ ok: true, memberId: 'm_0b' }) });
  const node = fakeNode();
  members.wire(node);
  await members.mount(node);
  const drawn = node.innerHTML;
  fail = true;
  const refresh = refreshButton();
  await node.click({ target: refresh });
  assert.equal(node.innerHTML, drawn, 'the card stays');
  assert.match(refresh.error.innerHTML, /hb-warn.*did not answer\. Reload the page/);
  assert.equal(refresh.disabled, false);
  const add = addButton('u9', { role: 'kid' });
  await node.click({ target: add });
  assert.equal(node.innerHTML, drawn, 'the card stays');
  assert.match(add.error.innerHTML, /Added, but the list couldn&#39;t be read again: Home Base did not answer\. Reload the page/);
  assert.equal(add.disabled, true, 'not offered again: the account is a member now');
});

test('anyone but an unlocked administrator gets no card: the directory tells them only its state', async () => {
  const node = fakeNode();
  assert.equal(await load({ state: 'active', caller: { login: 'x', member: true, admitted: true } }).members.mount(node), null);
  assert.equal(node.removed, true);
});
