const test = require('node:test');
const assert = require('node:assert/strict');
const { createMoveHandlers } = require('../executor/move-handlers');
const { createFakeFs } = require('./fixtures/fake-fs');
const { users } = require('./fixtures/users');
const { appLayout } = require('../src/operations/app-layout');
const { getAppById } = require('../src/catalog');
const { compileAction, normalizeAction } = require('../executor/actions');
const { validateOperationPolicy } = require('../src/operations/policy');

const SOURCE = appLayout(getAppById('home-source'));
const HELM = appLayout(getAppById('helm'));
const CHECKOUT = '/opt/sovereign-home/apps/homeSource';
const SHARED = { uid: 1001, gid: 1002 };
const OWN = 1102;
const SITE = { hostname: 'homebase', domain: 'example.ts.net', householdTimezone: 'America/New_York' };
const op = (fields = {}) => ({ id: 'reown-app', type: 'filesystem.reown-app', title: 't', risk: 'destructive', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields });

// Home Source as installed before SID-002: every file is sovereign's, and so are apps/ and backups/.
function installedBeforeSid002(extra = {}) {
  const mine = (entry) => ({ uid: SHARED.uid, gid: SHARED.gid, ...entry });
  return createFakeFs({
    '/opt/sovereign-home/apps': mine({ kind: 'dir' }),
    [CHECKOUT]: mine({ kind: 'dir', mode: 0o755 }),
    [`${CHECKOUT}/.env`]: mine({ kind: 'file', content: 'A=1\n', mode: 0o640 }),
    [`${CHECKOUT}/server.js`]: mine({ kind: 'file', content: 'code' }),
    [`${CHECKOUT}/node_modules`]: mine({ kind: 'dir' }),
    [`${CHECKOUT}/node_modules/x.js`]: mine({ kind: 'file', content: 'x' }),
    [`${CHECKOUT}/node_modules/.bin`]: mine({ kind: 'link', target: '../x.js' }),
    '/var/lib/sovereign-home': { kind: 'dir' },
    '/var/lib/sovereign-home/home-source': { kind: 'dir' },
    '/var/lib/sovereign-home/home-source/data': mine({ kind: 'dir', mode: 0o750 }),
    '/var/lib/sovereign-home/home-source/data/documents': mine({ kind: 'dir', mode: 0o750 }),
    '/var/lib/sovereign-home/home-source/data/documents/a.pdf': mine({ kind: 'file', content: 'pdf' }),
    '/var/lib/sovereign-home/backups': mine({ kind: 'dir' }),
    '/var/lib/sovereign-home/backups/home-source': mine({ kind: 'dir', mode: 0o755 }),
    '/var/lib/sovereign-home/backups/home-source/20260924T101010Z': mine({ kind: 'dir', mode: 0o755 }),
    '/var/lib/sovereign-home/backups/home-source/20260924T101010Z/database.dump': mine({ kind: 'file', content: 'dump', mode: 0o600 }),
    ...extra,
  });
}

test('the move hands every file to the app user, takes apps/ and backups/ back for root, and makes the .env private', async () => {
  const fsImpl = installedBeforeSid002();
  const handlers = createMoveHandlers({ fsImpl, lookupUser: users() });
  const output = await handlers['filesystem.reown-app'](op(), { layout: SOURCE });
  const owner = (target) => fsImpl.entries.get(target).uid;
  for (const target of [...fsImpl.entries.keys()].filter((key) => key.startsWith(`${CHECKOUT}`) || key.startsWith('/var/lib/sovereign-home/home-source/data') || key.startsWith('/var/lib/sovereign-home/backups/home-source'))) {
    assert.equal(owner(target), OWN, target);
  }
  for (const target of [CHECKOUT, '/var/lib/sovereign-home/home-source/data', '/var/lib/sovereign-home/backups/home-source']) assert.equal(fsImpl.entries.get(target).mode, 0o700, target);
  assert.equal(fsImpl.entries.get(`${CHECKOUT}/.env`).mode, 0o600);
  assert.deepEqual([owner('/opt/sovereign-home/apps'), owner('/var/lib/sovereign-home/backups'), owner('/var/lib/sovereign-home/home-source')], [0, 0, 0]);
  assert.ok(fsImpl.calls.some(([call, target]) => call === 'lchown' && target === `${CHECKOUT}/node_modules/.bin`), 'links are re-owned themselves, never followed');
  assert.match(output, /handed Home Source to sovereign-source/);
  // The checkout goes last: until then the app still counts as sovereign's (identity.js).
  const checkoutHandover = fsImpl.calls.findIndex(([call, target, uid]) => call === 'fchown' && target === CHECKOUT && uid === OWN);
  const otherHandovers = fsImpl.calls.map(([call, target, uid], index) => (call === 'fchown' && uid === OWN && !target.startsWith(CHECKOUT) ? index : -1)).filter((index) => index >= 0);
  assert.ok(otherHandovers.every((index) => index < checkoutHandover));
  // Every directory is root's before any entry is handed over.
  const firstHandover = fsImpl.calls.findIndex(([call, , uid]) => ['fchown', 'lchown'].includes(call) && uid === OWN);
  const lastLock = fsImpl.calls.map(([call, target, uid], index) => (call === 'fchown' && uid === 0 && target.startsWith(CHECKOUT) ? index : -1)).filter((index) => index >= 0).at(-1);
  assert.ok(lastLock < fsImpl.calls.findIndex(([call, target, uid]) => ['fchown', 'lchown'].includes(call) && target.startsWith(CHECKOUT) && uid === OWN));
  assert.ok(firstHandover > 0);
  // Re-running after it finished is harmless.
  await handlers['filesystem.reown-app'](op(), { layout: SOURCE });
  assert.equal(owner(CHECKOUT), OWN);
});

test('hardlinked files are copied before handing over, and setuid bits are dropped', async () => {
  const fsImpl = installedBeforeSid002({
    [`${CHECKOUT}/linked.txt`]: { kind: 'file', content: 'shared inode', uid: SHARED.uid, gid: SHARED.gid, nlink: 2 },
    [`${CHECKOUT}/tool`]: { kind: 'file', content: 'bin', uid: SHARED.uid, gid: SHARED.gid, mode: 0o4755 },
  });
  await createMoveHandlers({ fsImpl, lookupUser: users() })['filesystem.reown-app'](op(), { layout: SOURCE });
  assert.ok(fsImpl.calls.some(([call, from]) => call === 'copy' && from === `${CHECKOUT}/linked.txt`), 'the other link keeps its owner; this path gets a fresh inode');
  assert.equal(fsImpl.entries.get(`${CHECKOUT}/linked.txt`).nlink, 1);
  assert.equal(fsImpl.entries.get(`${CHECKOUT}/linked.txt`).uid, OWN);
  assert.equal(fsImpl.entries.get(`${CHECKOUT}/linked.txt`).content, 'shared inode');
  assert.equal(fsImpl.entries.get(`${CHECKOUT}/tool`).mode, 0o755);
});

test('each directory is root\'s and 0700 before root reads it, so a writable directory can\'t change underneath; modes come back', async () => {
  // A hostile shared user leaves a world-writable directory and keeps a descriptor into it.
  const fsImpl = installedBeforeSid002({ [`${CHECKOUT}/public`]: { kind: 'dir', mode: 0o777, uid: SHARED.uid, gid: SHARED.gid }, [`${CHECKOUT}/public/a.css`]: { kind: 'file', content: 'a', uid: SHARED.uid, gid: SHARED.gid } });
  const seen = new Map();
  const readdir = fsImpl.readdirSync;
  fsImpl.readdirSync = (target) => {
    if (!seen.has(target)) { const entry = fsImpl.entries.get(target); seen.set(target, [entry.uid, entry.mode & 0o777]); }
    return readdir(target);
  };
  await createMoveHandlers({ fsImpl, lookupUser: users() })['filesystem.reown-app'](op(), { layout: SOURCE });
  for (const directory of [CHECKOUT, `${CHECKOUT}/public`, `${CHECKOUT}/node_modules`, '/var/lib/sovereign-home/home-source/data/documents']) assert.deepEqual(seen.get(directory), [0, 0o700], directory);
  assert.equal(fsImpl.entries.get(`${CHECKOUT}/public`).mode & 0o777, 0o777, 'its own mode back, inside a 0700 top');
  assert.equal(fsImpl.entries.get('/var/lib/sovereign-home/home-source/data/documents').mode & 0o777, 0o750);
  assert.equal(fsImpl.entries.get(`${CHECKOUT}/public/a.css`).uid, OWN);
});

test('a hardlink owned by anyone but the shared user or the app is left exactly as it is, never copied or chowned', async () => {
  const fsImpl = installedBeforeSid002({
    // A git object linked from the root-owned mirror, and a link planted to a system file.
    [`${CHECKOUT}/object`]: { kind: 'file', content: 'blob', uid: 0, gid: 0, mode: 0o444, nlink: 2 },
    [`${CHECKOUT}/shadow`]: { kind: 'file', content: 'root:secret', uid: 0, gid: 42, mode: 0o640, nlink: 2 },
  });
  const output = await createMoveHandlers({ fsImpl, lookupUser: users() })['filesystem.reown-app'](op(), { layout: SOURCE });
  for (const name of ['object', 'shadow']) {
    const entry = fsImpl.entries.get(`${CHECKOUT}/${name}`);
    assert.deepEqual([entry.uid, entry.nlink], [0, 2], name);
    assert.equal(fsImpl.calls.some(([call, from]) => call === 'copy' && from === `${CHECKOUT}/${name}`), false, name);
  }
  assert.match(output, /2 hardlinks owned by others left as they were/);
});

test('an interrupted move refuses every other plan until a re-run of the move finishes it', async () => {
  const { resolveAppIdentity, describeAppIdentity } = require('../executor/identity');
  const { createLifecycleHandlers } = require('../executor/lifecycle-handlers');
  const fsImpl = installedBeforeSid002({ '/var/lib/homebase-executor': { kind: 'dir', mode: 0o700, uid: 0, gid: 0 } });
  // The host loses power while the checkout is half handed over.
  const fchown = fsImpl.fchownSync;
  let failOnce = true;
  fsImpl.fchownSync = (fd, uid, gid) => {
    if (failOnce && uid === OWN && fsImpl.fdPath?.(fd) === `${CHECKOUT}/server.js`) { failOnce = false; throw Object.assign(new Error('EIO'), { code: 'EIO' }); }
    return fchown(fd, uid, gid);
  };
  const handlers = createMoveHandlers({ fsImpl, lookupUser: users() });
  await assert.rejects(() => handlers['filesystem.reown-app'](op(), { layout: SOURCE }), /EIO/);
  assert.equal(fsImpl.entries.get(CHECKOUT).uid, 0, 'the checkout belongs to root mid-move');
  assert.throws(() => resolveAppIdentity(SOURCE, { fsImpl, lookupUser: users() }), /was interrupted; run "Move to its own user" again/);
  assert.equal(resolveAppIdentity(SOURCE, { fsImpl, lookupUser: users(), duringMove: true }).name, 'sovereign-source');
  assert.deepEqual((({ pendingMove, interrupted }) => ({ pendingMove, interrupted }))(describeAppIdentity(SOURCE, { fsImpl, lookupUser: users() })), { pendingMove: true, interrupted: true });
  // The re-run's safety backup stands aside (the first attempt's was taken before anything changed); a plain backup refuses.
  const lifecycle = createLifecycleHandlers({ fsImpl, lookupUser: users(), asUser: (_user, fn) => fn() });
  const backup = { id: 'safety-backup', type: 'backup.create', title: 't', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], archiveName: '20261028T000000Z' };
  assert.match(await lifecycle['backup.create'](backup, { layout: SOURCE, planKind: 'app-move-user' }), /skipped: .*interrupted/);
  await assert.rejects(() => lifecycle['backup.create'](backup, { layout: SOURCE, planKind: 'app-backup' }), /was interrupted/);
  // The re-run finishes it, and the app is its own user's.
  await handlers['filesystem.reown-app'](op(), { layout: SOURCE });
  assert.equal(fsImpl.existsSync('/var/lib/homebase-executor/moves/home-source'), false);
  assert.equal(fsImpl.entries.get(`${CHECKOUT}/server.js`).uid, OWN);
  assert.equal(resolveAppIdentity(SOURCE, { fsImpl, lookupUser: users() }).name, 'sovereign-source');
});

test('a symlink planted in place of a directory stops the move before anything is handed over', async () => {
  // The shared user swaps a directory for a symlink just as root opens it.
  const planted = installedBeforeSid002();
  const handlers = createMoveHandlers({ fsImpl: planted, lookupUser: users() });
  const originalOpen = planted.openSync;
  planted.openSync = (target, flags, mode) => {
    if (target === '/var/lib/sovereign-home/home-source/data/documents') planted.entries.set(target, { kind: 'link', target: '/root', uid: SHARED.uid, gid: SHARED.gid, mode: 0o777 });
    return originalOpen(target, flags, mode);
  };
  await assert.rejects(() => handlers['filesystem.reown-app'](op(), { layout: SOURCE }), /changed into something other than a directory/);
  assert.equal(planted.calls.some(([call, , uid]) => ['fchown', 'lchown'].includes(call) && uid === OWN), false, 'nothing was handed over');
  assert.equal(planted.entries.get(CHECKOUT).uid, SHARED.uid, 'the app still counts as not moved');
  await assert.rejects(() => createMoveHandlers({ fsImpl: installedBeforeSid002({ [CHECKOUT]: { kind: 'link', target: '/root' } }), lookupUser: users() })['filesystem.reown-app'](op(), { layout: SOURCE }), /not a real directory/);
});

test('only a sensitive app moves, only to a distinct user that exists', async () => {
  const handlers = createMoveHandlers({ fsImpl: installedBeforeSid002(), lookupUser: users() });
  await assert.rejects(() => handlers['filesystem.reown-app'](op(), { layout: appLayout(getAppById('family-dinner')) }), /shared user by design/);
  await assert.rejects(() => createMoveHandlers({ fsImpl: installedBeforeSid002(), lookupUser: (name) => (name === 'sovereign' ? SHARED : null) })['filesystem.reown-app'](op(), { layout: SOURCE }), /does not exist/);
  await assert.rejects(() => createMoveHandlers({ fsImpl: installedBeforeSid002(), lookupUser: () => SHARED })['filesystem.reown-app'](op(), { layout: SOURCE }), /its own unprivileged identity/);
  await assert.rejects(() => createMoveHandlers({ fsImpl: createFakeFs({ '/opt/sovereign-home/apps': { kind: 'dir' }, '/var/lib/sovereign-home/backups': { kind: 'dir' } }), lookupUser: users() })['filesystem.reown-app'](op(), { layout: SOURCE }), /has no checkout/);
});

test('the move-user action compiles a policy-checked plan for sensitive apps only', () => {
  const { plan } = compileAction(normalizeAction({ action: 'move-user', appId: 'helm', site: SITE }));
  const ids = plan.operations.map((operation) => operation.id);
  assert.equal(ids[0], 'safety-backup');
  assert.ok(ids.indexOf('stop-service') < ids.indexOf('reown-app') && ids.indexOf('reown-app') < ids.indexOf('write-environment') && ids.indexOf('write-service') < ids.indexOf('start-service'));
  assert.equal(ids.at(-1), 'wait-ready');
  assert.equal(plan.operations.find((operation) => operation.id === 'ensure-app-user').user, 'sovereign-helm');
  assert.ok(HELM.timers.every((timer) => plan.operations.some((operation) => operation.unit === timer.serviceUnit)), 'every timer service is rewritten for the new user');
  // A run a timer already started is stopped too, before anything is handed over.
  for (const timer of HELM.timers) assert.ok(ids.indexOf(plan.operations.find((operation) => operation.unit === timer.serviceUnit && operation.action === 'stop').id) < ids.indexOf('reown-app'), timer.serviceUnit);
  assert.throws(() => compileAction(normalizeAction({ action: 'move-user', appId: 'family-dinner', site: SITE })), /shared user by design/);
  assert.throws(() => normalizeAction({ action: 'move-user', appId: 'helm' }), /site must be/);
  const denied = (mutate) => { const next = JSON.parse(JSON.stringify(plan)); mutate(next); assert.throws(() => validateOperationPolicy(next), (error) => error.code === 'POLICY_DENIED' || /schema/i.test(error.message)); };
  denied((next) => { next.operations.find((operation) => operation.id === 'ensure-app-home').purpose = 'app-install'; });
  denied((next) => { next.operations.find((operation) => operation.id === 'reown-app').risk = 'write'; });
  denied((next) => { Object.assign(next.operations.find((operation) => operation.id === 'write-service'), { purpose: 'nginx-snippet', template: 'app-nginx-v1' }); delete next.operations.find((operation) => operation.id === 'write-service').unit; delete next.operations.find((operation) => operation.id === 'write-service').timezone; });
  denied((next) => { next.target = 'family-dinner'; });
});
