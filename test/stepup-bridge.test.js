// stepup.js inside the household's iPhone app (window.sovereign, version 1): step-ups go through the native
// handoff (sovereignAuth wire contract, section 13) instead of a ceremony in the page; in a browser nothing
// changes. Run in a VM with a stubbed fetch, a fake bridge and a DOM just big enough for the helper's tap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STEPUP = fs.readFileSync(path.join(__dirname, '../src/identity/browser/stepup.js'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, '../public/api.js'), 'utf8');
const PASSKEYS = fs.readFileSync(path.join(__dirname, '../public/passkeys.js'), 'utf8');
const ID = 'I'.repeat(42) + 'E';
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A DOM element, as much as the helper's modal uses.
function element() {
  const node = { children: [], style: {}, listeners: {}, textContent: '', attributes: {} };
  node.setAttribute = (name, value) => { node.attributes[name] = value; };
  node.append = (...children) => { node.children.push(...children); };
  node.addEventListener = (type, fn) => { node.listeners[type] = fn; };
  node.remove = () => { node.removed = true; };
  node.focus = () => {};
  return node;
}
const buttonsIn = (node) => (node.listeners.click ? [node] : []).concat(...node.children.map(buttonsIn));

// answer: what the member taps in each modal, by its button's text ('Use passkey', 'OK', 'Cancel', …).
function load({ bridge = undefined, answer = (labels) => labels.find((label) => label !== 'Cancel'), respond, withPasskeys = false, hash = '', create = null } = {}) {
  const sent = [];
  const modals = [];
  const document = {
    createElement: element,
    addEventListener() {},
    removeEventListener() {},
    body: {
      append(backdrop) {
        const buttons = buttonsIn(backdrop);
        const text = backdrop.children[0].children[0].textContent;
        modals.push({ text, buttons: buttons.map((button) => button.textContent) });
        const choice = answer(buttons.map((button) => button.textContent), text);
        setImmediate(() => buttons.find((button) => button.textContent === choice).listeners.click());
      },
    },
  };
  const response = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), clone: () => response(status, body) });
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init.headers || {});
    sent.push({ url, method: init.method || 'GET', body, token: headers.get('x-sovereign-action-token') });
    const [status, answerBody] = await respond(url, body, headers, sent);
    return response(status, answerBody);
  };
  const window = { matchMedia: () => ({ matches: false }), location: { reload() {}, hash, pathname: '/admin', search: '' } };
  if (bridge) window.sovereign = bridge;
  const credentials = { get: async () => { throw new Error('no passkey prompt in the page here'); }, create: create || (async () => { throw new Error('no passkey prompt in the page here'); }) };
  const replaced = [];
  const history = { replaceState: (state, title, url) => { replaced.push(url); window.location.hash = ''; } };
  const context = vm.createContext({ window, document, history, navigator: { credentials }, fetch, Headers, console, atob, btoa, setTimeout });
  if (withPasskeys) vm.runInContext(API, context);
  vm.runInContext(STEPUP, context);
  if (withPasskeys) vm.runInContext(PASSKEYS, context);
  return { helper: window.SovereignStepUp, passkeys: window.HBPasskeys, sent, modals, replaced, window };
}

// A bridge that records each handoff and settles it as told (default: the sheet confirmed). confirmed: the
// ids whose sheet finished, which is what lets Home Base's redeem succeed.
function fakeBridge(outcome = () => Promise.resolve()) {
  const ids = [];
  const confirmed = new Set();
  return {
    ids,
    confirmed,
    version: 1,
    handoff(id) {
      ids.push(id);
      return outcome(id, ids.length, confirmed).then((value) => { confirmed.add(id); return value; });
    },
  };
}

const STEP_UP = { error: 'step_up_required', policy: 'open-documents', level: 'session', kind: 'any' };
const EVERY_TIME = { error: 'step_up_required', policy: 'privileged-plan', level: 'every-time', kind: 'hardware', target: 'plan x', digest: 'd'.repeat(43) };

// A server: /api/thing answers 401 (stepUp) until the retry carries what the handoff gave. A handoff redeems
// only once its sheet finished (bridge.confirmed), as Home Base's does.
function server(bridge, stepUp = STEP_UP, { ids = [ID] } = {}) {
  let begun = 0;
  const redeemed = new Set();
  return (url, body, headers) => {
    if (url === '/_sovereign/auth/handoff/begin') return [200, { id: ids[begun++] || ids.at(-1) }];
    if (url === '/_sovereign/auth/handoff/redeem') {
      if (!bridge.confirmed.has(body.id)) return [403, { error: 'handoff_refused', reason: 'not_done' }];
      redeemed.add(body.id);
      return [200, stepUp.level === 'every-time' ? { ok: true, token: `token-${body.id.slice(0, 4)}` } : { ok: true }];
    }
    if (url.startsWith('/api/')) {
      const passes = stepUp.level === 'every-time' ? Boolean(headers.get('x-sovereign-action-token')) : redeemed.size > 0;
      return passes ? [200, { ok: true }] : [401, stepUp];
    }
    return [404, {}];
  };
}

test('in a browser nothing changes: no handoff, the ceremony runs in the page', async () => {
  const { helper, sent } = load({ respond: (url) => (url === '/_sovereign/auth/check/options' ? [200, { options: { challenge: 'AA', allowCredentials: [] } }] : [401, STEP_UP]) });
  assert.equal(helper.inApp(), false);
  await assert.rejects(helper.fetch('/api/thing', { method: 'POST', body: '{}' }), /no passkey prompt in the page/);
  assert.deepEqual(sent.map((request) => request.url), ['/api/thing', '/_sovereign/auth/check/options']);
});

test('a bridge of another version is not this one: the page runs the ceremony as in a browser', async () => {
  const bridge = { ...fakeBridge(), version: 2 };
  const { helper } = load({ bridge, respond: () => [200, {}] });
  assert.equal(helper.inApp(), false);
});

test('a check in the app: the tap, begin, the app\'s sheet, redeem, then the identical retry', async () => {
  const bridge = fakeBridge();
  const { helper, sent, modals } = load({ bridge, respond: server(bridge) });
  assert.equal(helper.inApp(), true);
  const answer = await helper.fetch('/api/thing', { method: 'POST', body: '{"a":1}' });
  assert.equal(answer.status, 200);
  assert.deepEqual(modals.map((modal) => modal.buttons), [['Cancel', 'Use passkey']]);
  assert.deepEqual(sent.map((request) => [request.url, request.body]), [
    ['/api/thing', { a: 1 }],
    ['/_sovereign/auth/handoff/begin', { purpose: 'check', kind: 'any' }],
    ['/_sovereign/auth/handoff/redeem', { id: ID }],
    ['/api/thing', { a: 1 }],
  ]);
  assert.deepEqual(bridge.ids, [ID]);
  assert.equal(sent.at(-1).token, null);
});

test('an every-time action in the app: the handoff\'s token goes with the retry', async () => {
  const bridge = fakeBridge();
  const { helper, sent, modals } = load({ bridge, respond: server(bridge, EVERY_TIME) });
  const answer = await helper.fetch('/api/thing', { method: 'POST', body: '{}' });
  assert.equal(answer.status, 200);
  assert.deepEqual(modals[0].buttons, ['Cancel', 'Use hardware key']);
  assert.deepEqual(sent[1].body, { purpose: 'action', action: { policy: 'privileged-plan', target: 'plan x', digest: 'd'.repeat(43) } });
  assert.equal(sent.at(-1).token, `token-${ID.slice(0, 4)}`);
});

test('cancelled at the tap: no handoff begins and the 401 is the answer', async () => {
  const bridge = fakeBridge();
  const { helper, sent } = load({ bridge, answer: () => 'Cancel', respond: server(bridge) });
  const answer = await helper.fetch('/api/thing', { method: 'POST', body: '{}' });
  assert.equal(answer.status, 401);
  assert.deepEqual(sent.map((request) => request.url), ['/api/thing']);
  assert.deepEqual(bridge.ids, []);
});

test('cancelled in the sheet: the handoff is redeemed only to clear it, and nothing is retried', async () => {
  const bridge = fakeBridge(() => Promise.reject(new Error('cancelled')));
  const { helper, sent } = load({ bridge, respond: server(bridge) });
  const answer = await helper.fetch('/api/thing', { method: 'POST', body: '{}' });
  assert.equal(answer.status, 401);
  await tick();
  assert.deepEqual(sent.map((request) => request.url), ['/api/thing', '/_sovereign/auth/handoff/begin', '/_sovereign/auth/handoff/redeem']);
});

test('not possible in the app on this phone: the helper says so rather than trying in the page', async () => {
  const bridge = fakeBridge(() => Promise.reject(new Error('unavailable')));
  const { helper, sent, modals } = load({ bridge, respond: server(bridge) });
  const answer = await helper.fetch('/api/thing', { method: 'POST', body: '{}' });
  assert.equal(answer.status, 401);
  assert.equal(modals.length, 2);
  assert.match(modals[1].text, /can't be done in the app on this phone/);
  assert.deepEqual(modals[1].buttons, ['Cancel', 'OK']);
  assert.ok(!sent.some((request) => request.url.includes('check/')), 'no ceremony in the web view');
});

test('any other failure from the app is an error, not a silent 401', async () => {
  const bridge = fakeBridge(() => Promise.reject(new Error('attest failed: unknown_key')));
  const { helper } = load({ bridge, respond: server(bridge) });
  await assert.rejects(helper.fetch('/api/thing', { method: 'POST', body: '{}' }), /attest failed: unknown_key/);
});

test('one handoff at a time: two checks share one, and each request is retried', async () => {
  let release;
  const bridge = fakeBridge(() => new Promise((resolve) => { release = resolve; }));
  const { helper, sent } = load({ bridge, respond: server(bridge) });
  const first = helper.fetch('/api/thing', { method: 'POST', body: '{"n":1}' });
  const second = helper.fetch('/api/thing', { method: 'POST', body: '{"n":2}' });
  while (!release) await tick();
  release();
  const answers = await Promise.all([first, second]);
  assert.deepEqual(answers.map((answer) => answer.status), [200, 200]);
  assert.equal(bridge.ids.length, 1, 'one sheet for both');
  assert.equal(sent.filter((request) => request.url === '/_sovereign/auth/handoff/begin').length, 1);
});

test('one handoff at a time: a hardware check or an action after a check gets its own, after it', async () => {
  const releases = [];
  const bridge = fakeBridge(() => new Promise((resolve) => { releases.push(resolve); }));
  const ids = [ID, 'J'.repeat(42) + 'E'];
  const { helper } = load({ bridge, respond: server(bridge, STEP_UP, { ids }) });
  const check = helper.satisfy(STEP_UP);
  const hardware = helper.satisfy({ ...STEP_UP, kind: 'hardware' });
  while (releases.length < 1) await tick();
  assert.equal(bridge.ids.length, 1, 'the second waits for the first');
  releases[0]();
  while (releases.length < 2) await tick();
  releases[1]();
  assert.deepEqual(await Promise.all([check, hardware]), [null, null]);
  assert.deepEqual(bridge.ids, ids);
});

test('Admin in the app: unlocking goes through the app without a second tap; activating says to use Safari', async () => {
  const bridge = fakeBridge();
  const status = { state: 'active', instance: 'smith', member: { login: 'parent@example.com', name: 'Parent', role: 'parent', administrator: true }, credentials: [], check: null, administratorRuleMet: true, canActivate: false, enrollmentMetadataValid: true };
  const { passkeys, sent, modals } = load({ bridge, withPasskeys: true, respond: (url, body, headers, all) => (url === '/_sovereign/auth/status' ? [200, status] : server(bridge)(url, body, headers, all)) });
  assert.equal(JSON.stringify(await passkeys.check({ purpose: 'step-up' })), '{"ok":true}');
  assert.equal(modals.length, 0, 'the form\'s own button was the tap');
  assert.deepEqual(sent.map((request) => [request.url, request.body]), [
    ['/_sovereign/auth/handoff/begin', { purpose: 'check' }],
    ['/_sovereign/auth/handoff/redeem', { id: ID }],
  ]);
  await assert.rejects(passkeys.check({ purpose: 'activate' }), /Open Home Base in Safari/);
  assert.equal(sent.length, 2, 'it never reached Home Base');
});

// Home Base for adding a passkey: begin answers 401 (stepUp) until a check went through, or never asks.
function enrollServer(bridge, { stepUp = null, ids = [ID] } = {}) {
  let begun = 0;
  let checked = false;
  return (url, body) => {
    if (url === '/_sovereign/auth/handoff/begin' && body.purpose === 'enroll' && stepUp && !checked) return [401, stepUp];
    if (url === '/_sovereign/auth/handoff/begin') return [200, { id: ids[begun++] || ids.at(-1) }];
    if (url === '/_sovereign/auth/handoff/redeem') {
      if (!bridge.confirmed.has(body.id)) return [403, { error: 'handoff_refused', reason: 'not_done' }];
      if (body.id === ids[0] && stepUp) { checked = true; return [200, { ok: true }]; }
      return [200, { ok: true, enrolled: { kind: 'synced', label: 'iPhone' } }];
    }
    return [404, {}];
  };
}

test('adding a first passkey in the app: begin with the code, the app\'s sheet registers, redeem says what was added', async () => {
  const bridge = fakeBridge();
  const { passkeys, sent, modals } = load({ bridge, withPasskeys: true, respond: enrollServer(bridge) });
  const added = await passkeys.enroll({ label: 'iPhone', hardware: false, grant: 'the-code-1234' });
  assert.equal(JSON.stringify(added), '{"ok":true,"kind":"synced","label":"iPhone","askedForHardware":false}');
  assert.equal(modals.length, 0, 'the form\'s button was the tap');
  assert.deepEqual(sent.map((request) => [request.url, request.body]), [
    ['/_sovereign/auth/handoff/begin', { purpose: 'enroll', label: 'iPhone', hardware: false, grant: 'the-code-1234' }],
    ['/_sovereign/auth/handoff/redeem', { id: ID }],
  ]);
  assert.deepEqual(bridge.ids, [ID]);
});

test('adding another passkey in the app: the recent check goes through the app first, then the identical begin', async () => {
  const bridge = fakeBridge();
  const ids = [ID, 'J'.repeat(42) + 'E'];
  const stepUp = { error: 'step_up_required', policy: 'manage-own-credential', level: 'recent', kind: 'any', message: 'Check with one of your passkeys first (within the last 5 minutes).' };
  const { passkeys, sent, modals } = load({ bridge, withPasskeys: true, respond: enrollServer(bridge, { stepUp, ids }) });
  const added = await passkeys.enroll({ label: 'iPad', hardware: false });
  assert.equal(added.label, 'iPhone');
  assert.equal(modals.length, 1, 'the check asks for its own tap');
  assert.deepEqual(sent.map((request) => [request.url, request.body && request.body.purpose]), [
    ['/_sovereign/auth/handoff/begin', 'enroll'],
    ['/_sovereign/auth/handoff/begin', 'check'],
    ['/_sovereign/auth/handoff/redeem', undefined],
    ['/_sovereign/auth/handoff/begin', 'enroll'],
    ['/_sovereign/auth/handoff/redeem', undefined],
  ]);
  assert.deepEqual(sent[0].body, sent[3].body, 'the retry is identical');
  assert.deepEqual(bridge.ids, ids);
});

test('adding a passkey, cancelled in the sheet or not possible on this phone: nothing added, and it says why', async () => {
  const cancelled = fakeBridge(() => Promise.reject(new Error('cancelled')));
  const one = load({ bridge: cancelled, withPasskeys: true, respond: enrollServer(cancelled) });
  await assert.rejects(one.passkeys.enroll({ label: 'iPhone', grant: 'the-code-1234' }), /No passkey added: it was cancelled/);
  assert.deepEqual(one.sent.map((request) => request.url), ['/_sovereign/auth/handoff/begin', '/_sovereign/auth/handoff/redeem'], 'redeemed only to clear it');

  const unavailable = fakeBridge(() => Promise.reject(new Error('unavailable')));
  const two = load({ bridge: unavailable, withPasskeys: true, respond: enrollServer(unavailable) });
  await assert.rejects(two.passkeys.enroll({ label: 'iPhone', grant: 'the-code-1234' }), /No passkey added/);
  assert.match(two.modals[0].text, /Adding a passkey can't be done in the app on this phone/);
});

test('Admin#grant=<code> fills the enrollment code and leaves the address bar at once', async () => {
  const status = { state: 'active', instance: 'smith', member: { login: 'kid@example.com', name: 'Kid', role: 'kid', administrator: false }, credentials: [], check: null, administratorRuleMet: true, canActivate: false, enrollmentMetadataValid: true };
  const bridge = fakeBridge();
  const { passkeys, replaced } = load({ bridge, withPasskeys: true, hash: '#grant=AbC-123_xyz789QRStuvWX', respond: (url) => (url === '/_sovereign/auth/status' ? [200, status] : [404, {}]) });
  assert.deepEqual(replaced, ['/admin'], 'cleared before anything else runs');
  const node = { innerHTML: '' };
  await passkeys.mount(node);
  assert.match(node.innerHTML, /name="grant" autocomplete="one-time-code" value="AbC-123_xyz789QRStuvWX"/);
  assert.match(node.innerHTML, /Your enrollment code is filled in/);

  const plain = load({ bridge, withPasskeys: true, hash: '#grant=<script>', respond: (url) => (url === '/_sovereign/auth/status' ? [200, status] : [404, {}]) });
  assert.deepEqual(plain.replaced, [], 'anything else in the fragment is left alone');
  const other = { innerHTML: '' };
  await plain.passkeys.mount(other);
  assert.match(other.innerHTML, /name="grant" autocomplete="one-time-code" value=""/);
});

test('a cancel from the app after the sheet had finished: its result is used, and the next handoff waits for it', async () => {
  // The first sheet finished, but the app lost the callback and reports a cancel.
  const bridge = fakeBridge((id, n, confirmed) => {
    if (n !== 1) return Promise.resolve();
    confirmed.add(id);
    return Promise.reject(new Error('cancelled'));
  });
  const ids = [ID, 'J'.repeat(42) + 'E'];
  const base = server(bridge, STEP_UP, { ids });
  const order = [];
  let releaseFirstRedeem;
  const { helper } = load({ bridge, respond: (url, body, headers) => {
    const step = url.replace('/_sovereign/auth/', '');
    order.push(step);
    // The cleanup redemption answers late: nothing may begin before it does.
    if (step === 'handoff/redeem' && body.id === ID) return new Promise((resolve) => { releaseFirstRedeem = () => resolve(base(url, body, headers)); });
    return base(url, body, headers);
  } });
  const first = helper.satisfy({ ...STEP_UP, kind: 'hardware' });
  const second = helper.satisfy({ ...STEP_UP, kind: 'hardware' });
  while (!releaseFirstRedeem) await tick();
  await tick();
  assert.deepEqual(order, ['handoff/begin', 'handoff/redeem'], 'held at the first redemption');
  releaseFirstRedeem();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.deepEqual(bridge.ids, [ID], 'the first counted, so the second (hardware too) needed no sheet of its own');
  assert.deepEqual(order, ['handoff/begin', 'handoff/redeem']);
});

// A bridge whose sheets take a moment, recording how many were open at once.
function slowBridge() {
  const open = { now: 0, most: 0 };
  const bridge = fakeBridge(async () => {
    open.now += 1;
    open.most = Math.max(open.most, open.now);
    await tick();
    await tick();
    open.now -= 1;
  });
  return { bridge, open };
}

test('adding a passkey and a check at once: one sheet at a time, and both finish', async () => {
  const { bridge, open } = slowBridge();
  const ids = [ID, 'J'.repeat(42) + 'E'];
  let begun = 0;
  const redeemed = new Set();
  const respond = (url, body) => {
    if (url === '/_sovereign/auth/handoff/begin') return [200, { id: ids[begun++] }];
    if (url === '/_sovereign/auth/handoff/redeem') {
      redeemed.add(body.id);
      return [200, body.id === ids[0] ? { ok: true, enrolled: { kind: 'synced', label: 'iPhone' } } : { ok: true }];
    }
    if (url === '/api/thing') return redeemed.has(ids[1]) ? [200, { ok: true }] : [401, STEP_UP];
    return [404, {}];
  };
  const { helper } = load({ bridge, respond });
  const [added, thing] = await Promise.all([helper.addPasskey({ label: 'iPhone', grant: 'the-code-1234' }), helper.fetch('/api/thing', { method: 'POST', body: '{}' })]);
  assert.equal(added.label, 'iPhone');
  assert.equal(thing.status, 200);
  assert.equal(open.most, 1, 'never two sheets');
  assert.deepEqual([...bridge.ids].sort(), ids, 'each its own handoff, in either order');
});

test('two passkeys added at once: one sheet at a time, each its own', async () => {
  const { bridge, open } = slowBridge();
  const ids = [ID, 'J'.repeat(42) + 'E'];
  let begun = 0;
  const respond = (url, body) => {
    if (url === '/_sovereign/auth/handoff/begin') return [200, { id: ids[begun++] }];
    if (url === '/_sovereign/auth/handoff/redeem') return [200, { ok: true, enrolled: { kind: 'synced', label: body.id === ID ? 'one' : 'two' } }];
    return [404, {}];
  };
  const { helper } = load({ bridge, respond });
  const added = await Promise.all([helper.addPasskey({ label: 'one' }), helper.addPasskey({ label: 'two' })]);
  assert.deepEqual(added.map((entry) => entry.label).sort(), ['one', 'two']);
  assert.equal(open.most, 1);
});

test('adding a passkey when the app lost the callback: the late redemption is the result', async () => {
  const bridge = fakeBridge((id, n, confirmed) => { confirmed.add(id); return Promise.reject(new Error('cancelled')); });
  const { passkeys, sent } = load({ bridge, withPasskeys: true, respond: enrollServer(bridge) });
  const added = await passkeys.enroll({ label: 'iPhone', grant: 'the-code-1234' });
  assert.equal(added.label, 'iPhone');
  assert.deepEqual(sent.map((request) => request.url), ['/_sovereign/auth/handoff/begin', '/_sovereign/auth/handoff/redeem']);
});

test('an administrator passkey in the app: the hardware token from the app goes with the identical begin', async () => {
  const bridge = fakeBridge();
  const ids = [ID, 'J'.repeat(42) + 'E'];
  const stepUp = { error: 'step_up_required', policy: 'manage-admin-credential', level: 'every-time', kind: 'hardware', target: 'enroll:m_01', digest: 'd'.repeat(43) };
  let begun = 0;
  const respond = (url, body, headers) => {
    if (url === '/_sovereign/auth/handoff/begin' && body.purpose === 'enroll' && !headers.get('x-sovereign-action-token')) return [401, stepUp];
    if (url === '/_sovereign/auth/handoff/begin') return [200, { id: ids[begun++] }];
    if (url === '/_sovereign/auth/handoff/redeem') return [200, body.id === ID ? { ok: true, token: 'the-token' } : { ok: true, enrolled: { kind: 'hardware', label: 'Backup key' } }];
    return [404, {}];
  };
  const { passkeys, sent, modals } = load({ bridge, withPasskeys: true, respond });
  const added = await passkeys.enroll({ label: 'Backup key', hardware: true });
  assert.equal(JSON.stringify(added), '{"ok":true,"kind":"hardware","label":"Backup key","askedForHardware":true}');
  assert.equal(modals.length, 1);
  assert.deepEqual(modals[0].buttons, ['Cancel', 'Use hardware key']);
  assert.deepEqual(sent[1].body, { purpose: 'action', action: { policy: 'manage-admin-credential', target: 'enroll:m_01', digest: 'd'.repeat(43) } });
  assert.deepEqual(sent[3].body, sent[0].body, 'the identical begin');
  assert.equal(sent[3].token, 'the-token');
});

test('in a browser, adding a passkey runs in the page as before: no handoff', async () => {
  const bytes = (text) => new TextEncoder().encode(text).buffer;
  const create = async () => ({
    id: 'cred', rawId: bytes('cred'), type: 'public-key',
    response: { clientDataJSON: bytes('{}'), attestationObject: bytes('att'), getTransports: () => ['internal'] },
    getClientExtensionResults: () => ({}),
  });
  const respond = (url) => {
    if (url === '/_sovereign/auth/enroll/options') return [200, { options: { challenge: 'Y2hhbGxlbmdl', user: { id: 'dXNlcg', name: 'kid' }, rp: { id: 'example.ts.net' }, excludeCredentials: [] } }];
    if (url === '/_sovereign/auth/enroll/finish') return [201, { ok: true, kind: 'synced', label: 'iPhone', askedForHardware: false }];
    return [404, {}];
  };
  const { passkeys, sent } = load({ withPasskeys: true, respond, create });
  const added = await passkeys.enroll({ label: 'iPhone', grant: 'the-code-1234' });
  assert.equal(added.kind, 'synced');
  assert.deepEqual(sent.map((request) => request.url), ['/_sovereign/auth/enroll/options', '/_sovereign/auth/enroll/finish']);
  assert.equal(sent[1].body.grant, 'the-code-1234');
});
