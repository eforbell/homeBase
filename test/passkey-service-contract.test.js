const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = path.join(__dirname, '../src/identity/passkeys.js');
const realRequire = createRequire(filename);
const sdk = realRequire('sovereign-auth');
const expected = Buffer.alloc(32, 7).toString('base64url');
const legacy = Buffer.from('1001').toString('base64url');

for (const scenario of ['legacy SDK', 'missing options', 'different account', 'mutated request']) {
  test('enrollment refuses ' + scenario + ' output before returning irreversible registration options', async () => {
    const module = { exports: {} }; let strictFlag;
    const mock = { ...sdk, createWebAuthn(config) {
      strictFlag = config.requireUserHandle;
      return { async registrationOptions(request) {
        assert.equal(request.member.userHandle, expected);
        if (scenario === 'missing options') return null;
        if (scenario === 'mutated request') request.member.userHandle = legacy;
        return { user: { id: scenario === 'different account' ? Buffer.alloc(32, 8).toString('base64url') : legacy } };
      } };
    } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Buffer, require: (name) => name === 'sovereign-auth' ? mock : realRequire(name) }, { filename });
    const directory = { enrollmentHandleFor: () => expected, credentialsFor: () => [] };
    const service = module.exports.createPasskeys({ directory, signingKey: {}, household: 'prod' });
    await assert.rejects(service.enrollOptions({ site: { rpID: 'example.ts.net', hostname: 'prod-homebase.example.ts.net' }, standing: { member: { userId: '1001', login: 'parent@example.com', name: 'Parent', epoch: 0 }, state: 'setup', globalEpoch: 1 } }), { code: 'PASSKEY_LIBRARY_MISMATCH', statusCode: 503 });
    assert.equal(strictFlag, true);
  });
}
