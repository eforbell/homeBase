const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, DOMAIN, PARENT, PASSPHRASE, startServer } = require('./support/household');
const { createResidentAuthenticator } = require('./support/resident-authenticator');

test('characterizes the cross-suite resident-key replacement that ordinary static fixtures miss', async (t) => {
  const key = createResidentAuthenticator({ kind: 'hardware' });
  const suites = [];
  for (const instance of ['prod', 'rehearsal']) {
    const { base } = await startServer(t, { config: { instance } });
    const host = instance + '-homebase.' + DOMAIN;
    const parent = browser(base, PARENT, { host });
    const origin = 'https://' + host;
    assert.equal((await parent.post('/api/admin/setup', { passphrase: PASSPHRASE })).status, 200);
    const enrolled = await parent.enroll(key, { label: 'Shared hardware key', hardware: true, origin });
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
    assert.equal((await parent.check(key, { origin })).status, 200);
    suites.push({ parent, origin, id: enrolled.body.credentialId });
  }
  assert.notEqual(suites[0].id, suites[1].id);
  assert.equal(key.hasCredential(suites[0].id), false);
  await assert.rejects(suites[0].parent.check(key, { origin: suites[0].origin }), { name: 'NotAllowedError' });
  assert.equal((await suites[1].parent.check(key, { origin: suites[1].origin })).status, 200);
});
