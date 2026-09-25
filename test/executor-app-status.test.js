const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppUpdateStatusChecker } = require('../executor/app-status');
const { appLayout } = require('../src/operations/app-layout');
const { GIT_DEPLOY_KEY_PATH } = require('../executor/handlers');
const { getAppById } = require('../src/catalog');
const { createFakeFs } = require('./fixtures/fake-fs');

const SOVEREIGN = { uid: 1001, gid: 1002 };
const CHECKOUT = '/opt/sovereign-home/apps/familyDinner';
const MIRROR = '/var/lib/sovereign-home/git-mirrors/familyDinner.git';
const LOCAL = 'a'.repeat(40);
const REMOTE = 'b'.repeat(40);

function fixture(extra = {}) {
  return createFakeFs({ [`${CHECKOUT}/.git`]: { kind: 'dir' }, '/etc/sovereign-home': { kind: 'dir' }, ...extra });
}

function responder({ counts = '0 3', revListFails = false } = {}) {
  return async (input) => {
    if (input.args.includes('rev-parse') && input.args.includes('HEAD')) return { stdout: `${LOCAL}\n` };
    if (input.args.includes('--verify')) return { stdout: `${REMOTE}\n` };
    if (input.args.includes('rev-list')) {
      if (revListFails) throw Object.assign(new Error('bad object'), { code: 'OPERATION_FAILED' });
      return { stdout: `${counts}\n` };
    }
    return { stdout: '' };
  };
}

test('update checks use the shared catalog layout and refuse apps the executor does not manage', async () => {
  const dinner = appLayout(getAppById('family-dinner'));
  assert.equal(dinner.mirror, MIRROR);
  assert.equal(dinner.checkout, CHECKOUT);
  assert.equal(dinner.repositories.ssh, 'ssh://git@github.com/eforbell/familyDinner.git');
  const check = createAppUpdateStatusChecker({ fsImpl: fixture(), lookupUser: () => SOVEREIGN, run: responder() });
  await assert.rejects(() => check({ appId: 'not-in-catalog', transport: 'https', ref: 'main' }), (error) => error.code === 'POLICY_DENIED' && /does not manage not-in-catalog/.test(error.message));
});

test('update status refreshes the mirror as root, reads HEAD as sovereign, and compares only inside the mirror', async () => {
  const calls = [];
  const respond = responder({ counts: '0 3' });
  const check = createAppUpdateStatusChecker({ fsImpl: fixture(), lookupUser: () => SOVEREIGN, run: async (input) => { calls.push(input); return respond(input); } });
  const status = await check({ appId: 'family-dinner', transport: 'https', ref: 'main' });
  assert.deepEqual(status, { localHeadSha: LOCAL, remoteHeadSha: REMOTE, aheadCount: 0, behindCount: 3 });
  const asRoot = calls.filter((call) => call.uid === 0);
  const asSovereign = calls.filter((call) => call.uid === 1001);
  assert.deepEqual(asSovereign.map((call) => call.args), [['-C', CHECKOUT, 'rev-parse', 'HEAD']]);
  for (const call of asRoot) {
    assert.ok(!call.args.includes(CHECKOUT), 'root must never run git inside the sovereign-owned checkout');
    assert.deepEqual(call.args.slice(0, 4), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
  }
  assert.deepEqual(asRoot[0].args.slice(4), ['clone', '--mirror', 'https://github.com/eforbell/familyDinner.git', MIRROR]);
  assert.deepEqual(asRoot.at(-1).args.slice(4), ['-C', MIRROR, 'rev-list', '--left-right', '--count', `${LOCAL}...${REMOTE}`]);
});

test('update status uses the root-held key for SSH and refuses without one', async () => {
  const calls = [];
  const check = createAppUpdateStatusChecker({ fsImpl: fixture({ [GIT_DEPLOY_KEY_PATH]: { kind: 'file', content: 'k', mode: 0o600, uid: 0 }, [MIRROR]: { kind: 'dir' } }), lookupUser: () => SOVEREIGN, run: async (input) => { calls.push(input); return responder()(input); } });
  await check({ appId: 'family-dinner', transport: 'ssh', ref: 'main' });
  const fetch = calls.find((call) => call.args.includes('fetch'));
  assert.equal(fetch.uid, 0);
  assert.match(fetch.env.GIT_SSH_COMMAND, /deploy_key/);
  assert.equal(calls.filter((call) => call.uid === 1001).some((call) => 'GIT_SSH_COMMAND' in call.env), false);
  const keyless = createAppUpdateStatusChecker({ fsImpl: fixture(), lookupUser: () => SOVEREIGN, run: responder() });
  await assert.rejects(() => keyless({ appId: 'family-dinner', transport: 'ssh', ref: 'main' }), /--git-ssh-key/);
});

test('update status reports pins, unknown local commits, and missing checkouts distinctly', async () => {
  const pinned = createAppUpdateStatusChecker({ fsImpl: fixture(), lookupUser: () => SOVEREIGN, run: responder() });
  assert.deepEqual(await pinned({ appId: 'family-dinner', transport: 'https', ref: LOCAL }), { localHeadSha: LOCAL, remoteHeadSha: LOCAL, aheadCount: 0, behindCount: 0, pinned: true, matchesPin: true });
  const diverged = createAppUpdateStatusChecker({ fsImpl: fixture(), lookupUser: () => SOVEREIGN, run: responder({ revListFails: true }) });
  assert.equal((await diverged({ appId: 'family-dinner', transport: 'https', ref: 'main' })).unknownLocalCommit, true);
  const absent = createAppUpdateStatusChecker({ fsImpl: createFakeFs(), lookupUser: () => SOVEREIGN, run: responder() });
  await assert.rejects(() => absent({ appId: 'family-dinner', transport: 'https', ref: 'main' }), (error) => error.code === 'NOT_INSTALLED');
});
