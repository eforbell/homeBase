const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, DOMAIN, PARENT, PASSPHRASE, startServer } = require('./support/household');
const { createResidentAuthenticator } = require('./support/resident-authenticator');

// This end-to-end test characterized replacement before slice 3; it now locks the actual repair.
for (const order of [['prod', 'rehearsal'], ['rehearsal', 'prod']]) test('independent suites retain one key in enrollment order ' + order.join(' then '), async (t) => {
  const key = createResidentAuthenticator({ kind: 'hardware' });
  const suites = [];
  for (const instance of order) {
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
  assert.equal(key.hasCredential(suites[0].id), true);
  assert.equal((await suites[0].parent.check(key, { origin: suites[0].origin })).status, 200);
  assert.equal((await suites[1].parent.check(key, { origin: suites[1].origin })).status, 200);
});
