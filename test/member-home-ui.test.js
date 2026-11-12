const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const caller = { name: 'A <Kid>', login: 'kid@example.com' };
const member = { state: 'member', caller, canUnlockAdmin: false, apps: [{ id: 'family-dinner', name: 'Family <Dinner>', icon: '🍽️', url: 'https://smith-home.example/dinner/' }] };
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Run the actual API, navigation and dashboard scripts together, with deterministic browser events and
// clocks. No static-source assertions: requests, rendering and polling must all behave together.
function page(answers, { activePage = 'dashboard' } = {}) {
  const sent = [];
  const timers = new Map();
  const stored = new Map();
  const documentEvents = {};
  const windowEvents = {};
  const nodes = [];
  let timerId = 0;
  function node() {
    const classes = new Set();
    return { innerHTML: '', className: '', style: {}, events: {},
      classList: { add: (name) => classes.add(name), toggle: (name) => classes.has(name) ? classes.delete(name) : classes.add(name) },
      addEventListener(type, fn) { this.events[type] = fn; },
      setAttribute() {}, querySelector() { return null; }, remove() {}, prepend() {},
    };
  }
  const root = node();
  const document = { visibilityState: 'visible', title: '',
    getElementById: (id) => id === 'app' ? root : null,
    querySelectorAll: () => [],
    createElement: () => { const el = node(); nodes.push(el); return el; },
    addEventListener: (event, fn) => { documentEvents[event] = fn; },
    body: { classList: { add() {} }, getAttribute: () => activePage, appendChild() {} },
  };
  const window = { addEventListener: (event, fn) => { windowEvents[event] = fn; } };
  let responseIndex = 0;
  const admin = {
    '/api/state': { installations: {}, jobs: [] }, '/api/homebase/status': { systemd: { active: 'active' } },
    '/api/homebase/config': { hostname: 'home', domain: 'example', baseBackupDir: '/private/backups' },
    '/api/homebase/bootstrap-status': { autoBootstrap: {} }, '/api/apps/health': { byAppId: {} },
    '/api/catalog': { apps: [] }, '/api/preflight': { checks: [] },
  };
  const context = vm.createContext({ window, document, console,
    sessionStorage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    MutationObserver: class { observe() {} },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url) => {
      sent.push(url);
      const body = url === '/api/home' ? answers[Math.min(responseIndex++, answers.length - 1)] : admin[url];
      if (body instanceof Error) throw body;
      assert.notEqual(body, undefined, `unexpected request ${url}`);
      return { ok: true, text: async () => JSON.stringify(body) };
    },
  });
  for (const name of ['api.js', 'nav.js', ...(activePage === 'dashboard' ? ['dashboard.js'] : [])]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8'), context, { filename: name });
  }
  return { root, document, sent, timers, stored, documentEvents, windowEvents,
    nav: () => nodes.map((el) => el.innerHTML).join('\n'),
    async refresh() { root.events.click({ target: { closest: () => ({}) } }); await tick(); },
    async poll() { const [id, timer] = [...timers][0]; timers.delete(id); timer.fn(); await tick(); },
    async visibility(value) { document.visibilityState = value; documentEvents.visibilitychange(); await tick(); },
  };
}

test('member UI renders only safe app cards and contextual navigation, with one shared API request', async () => {
  const ui = page([member]); await tick();
  assert.deepEqual(ui.sent, ['/api/home']);
  assert.match(ui.root.innerHTML, /Your apps/);
  assert.match(ui.root.innerHTML, /A &lt;Kid&gt;/);
  assert.match(ui.root.innerHTML, /Family &lt;Dinner&gt;/);
  assert.match(ui.root.innerHTML, /href="https:\/\/smith-home\.example\/dinner\/"/);
  assert.match(ui.root.innerHTML, /Have a passkey enrollment code/);
  assert.doesNotMatch(ui.root.innerHTML, /\/apps\/family|Backup posture|System readiness|Unlock administration/);
  assert.match(ui.nav(), />Home</);
  assert.match(ui.nav(), />Passkeys</);
  assert.doesNotMatch(ui.nav(), /href="\/(?:apps|jobs|status|config|network)"|hb-status-dot|hb-more-nav-btn/);
  assert.equal(ui.stored.size, 0);
  assert.equal(ui.timers.size, 0, 'members do not poll');
});

test('waiting visitor sees a truthful acknowledgement, then admission without enrollment or admin reads', async () => {
  const waiting = { state: 'waiting', caller, candidateObserved: false };
  const ui = page([waiting, { ...waiting, candidateObserved: true }, member]); await tick();
  assert.doesNotMatch(ui.root.innerHTML, /Your visit is visible/);
  assert.doesNotMatch(ui.root.innerHTML, /enrollment code/);
  assert.equal([...ui.timers.values()][0].delay, 10000);
  await ui.poll();
  assert.match(ui.root.innerHTML, /Your visit is visible in Admin/);
  await ui.poll();
  assert.match(ui.root.innerHTML, /Your apps/);
  assert.equal(ui.timers.size, 0);
  assert.deepEqual(ui.sent, ['/api/home', '/api/home', '/api/home']);
});

test('onboarding polling pauses while hidden or navigating, resumes on return, and survives a failed refresh', async () => {
  const waiting = { state: 'waiting', caller, candidateObserved: true };
  const ui = page([waiting, new Error('offline'), waiting, { state: 'disabled', caller }]); await tick();
  await ui.visibility('hidden');
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.sent.length, 1);
  await ui.visibility('visible');
  assert.match(ui.root.innerHTML, /We couldn’t check your access/);
  assert.equal(ui.timers.size, 1, 'waiting visitors retry after transient errors');
  await ui.poll();
  assert.match(ui.root.innerHTML, /Waiting for your administrator/);
  ui.windowEvents.pagehide();
  assert.equal(ui.timers.size, 0);
  ui.windowEvents.pageshow({ persisted: true }); await tick();
  assert.match(ui.root.innerHTML, /account is disabled/);
  assert.equal(ui.timers.size, 0);
  assert.doesNotMatch(ui.root.innerHTML, /enrollment code|\/admin/);
});

test('member refresh removes revoked apps and error states never reuse the last inventory', async () => {
  const ui = page([member, { ...member, apps: [] }, new Error('secret host path')]); await tick();
  await ui.refresh();
  assert.match(ui.root.innerHTML, /You’re a member, but no apps/);
  assert.doesNotMatch(ui.root.innerHTML, /Family &lt;Dinner&gt;/);
  await ui.refresh();
  assert.match(ui.root.innerHTML, /Try again/);
  assert.doesNotMatch(ui.root.innerHTML, /secret host path|Family &lt;Dinner&gt;|enrollment code/);
  assert.equal(ui.timers.size, 0);
});

test('lifecycle, missing identity and unavailable states avoid admin API calls and enrollment links', async () => {
  for (const state of ['setup', 'recovery', 'unidentified', 'unavailable', 'disabled']) {
    const ui = page([{ state, caller: null }]); await tick();
    assert.deepEqual(ui.sent, ['/api/home'], state);
    assert.doesNotMatch(ui.root.innerHTML, /Your apps|enrollment code/);
    assert.equal(ui.timers.size, 0);
  }
});

test('only legacy and unlocked administrator views load the operational dashboard and full navigation', async () => {
  const locked = page([{ ...member, canUnlockAdmin: true }]); await tick();
  assert.match(locked.root.innerHTML, /Unlock administration/);
  assert.deepEqual(locked.sent, ['/api/home']);
  for (const state of ['legacy', 'administrator']) {
    const ui = page([{ state }]); await tick();
    assert.match(ui.root.innerHTML, /System readiness/);
    assert.match(ui.root.innerHTML, /Backup posture/);
    assert.match(ui.nav(), /href="\/jobs"/);
    assert.match(ui.nav(), /hb-more-nav-btn/);
    assert.ok(ui.sent.includes('/api/state'));
    assert.ok(ui.sent.includes('/api/preflight'));
    assert.equal(ui.sent.filter((url) => url === '/api/home').length, 1);
  }
});

test('shared navigation hides operational links on member self-service pages too', async () => {
  const ui = page([member], { activePage: 'admin' }); await tick();
  assert.deepEqual(ui.sent, ['/api/home']);
  assert.match(ui.nav(), />Passkeys</);
  assert.doesNotMatch(ui.nav(), /href="\/(?:apps|jobs|config|network)"/);
});
