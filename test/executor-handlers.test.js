const test = require('node:test');
const assert = require('node:assert/strict');
const { createBaseHandlers } = require('../executor/handlers');

function base(type, fields = {}) {
  return { id: 'test-op', type, title: 'test', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields };
}

test('package handler uses fixed apt argv and rejects packages outside policy', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ run: async (input) => { calls.push(input); return {}; } });
  await handlers['package.ensure'](base('package.ensure', { packages: ['git', 'nginx'], updateCache: true }));
  assert.deepEqual(calls.map((call) => [call.binary, call.args]), [
    ['/usr/bin/apt-get', ['update']],
    ['/usr/bin/apt-get', ['install', '--yes', '--no-install-recommends', 'git', 'nginx']],
  ]);
  await assert.rejects(() => handlers['package.ensure'](base('package.ensure', { packages: ['git;reboot'], updateCache: false })), (error) => error.code === 'POLICY_DENIED');
});

test('identity handler permits only sovereign and never accepts caller groups', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ run: async (input) => { calls.push(input); return {}; }, lookupUser: () => null });
  await handlers['identity.ensure-user'](base('identity.ensure-user', { user: 'sovereign' }));
  assert.equal(calls[0].binary, '/usr/sbin/useradd');
  assert.deepEqual(calls[0].args, ['--system', '--home-dir', '/opt/sovereign-home', '--shell', '/usr/sbin/nologin', 'sovereign']);
  await assert.rejects(() => handlers['identity.ensure-user'](base('identity.ensure-user', { user: 'root' })), (error) => error.code === 'POLICY_DENIED');
});
