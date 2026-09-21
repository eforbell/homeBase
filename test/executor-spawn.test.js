const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runApproved } = require('../executor/spawn');

function fakeSpawn({ code = 0, stdout = '', stderr = '' } = {}) {
  const stub = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code, null);
    });
    stub.record = { binary, args, options };
    return child;
  };
  return stub;
}

test('approved spawn uses a fixed absolute binary, argv array, identity, and shell:false', async () => {
  const stub = fakeSpawn({ stdout: 'ok' });
  const result = await runApproved({ binary: '/usr/bin/git', args: ['status'], uid: 1001, gid: 1001, cwd: '/opt/sovereign-home/apps/familyDinner', env: { PATH: '/usr/bin' }, timeoutMs: 1000, spawnImpl: stub });
  assert.equal(result.stdout, 'ok');
  assert.deepEqual(stub.record, { binary: '/usr/bin/git', args: ['status'], options: { shell: false, uid: 1001, gid: 1001, cwd: '/opt/sovereign-home/apps/familyDinner', env: { PATH: '/usr/bin' } } });
});

test('approved spawn rejects arbitrary binaries and redacts bounded child output', async () => {
  assert.throws(() => runApproved({ binary: '/bin/sh', args: ['-c', 'id'], uid: 1, gid: 1, timeoutMs: 1 }), /unapproved binary/);
  const stub = fakeSpawn({ stdout: 'token=s3cret' });
  const result = await runApproved({ binary: '/usr/bin/id', uid: 1, gid: 1, timeoutMs: 1000, secrets: ['s3cret'], spawnImpl: stub });
  assert.equal(result.stdout, 'token=[REDACTED]');
});
