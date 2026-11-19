// The native handoff on Home Base (sovereignAuth wire contract, section 13): a page in the app's web view
// begins and redeems, the app attests with App Attest, and a Safari sheet runs the ceremony. Each is its own
// client here: the web view and the app share the phone's tailnet identity but not cookies, and the sheet is
// ephemeral. Apple is a fake (test/support/app-attest.js); the passkeys are test/support/authenticator.js's.
const test = require('node:test');
const assert = require('node:assert/strict');
const { appInstanceClientData, handoffClientData } = require('sovereign-auth');
const { createFakeApple } = require('./support/app-attest');
const { createAuthenticator } = require('./support/authenticator');
const { HOMEBASE, KID, ORIGIN, PARENT, PASSPHRASE, PULSE, activeHousehold, browser, startServer } = require('./support/household');

const APP_ID = 'ABCDE12345.org.example.homebase';
const NATIVE_APP = { appId: APP_ID, scheme: 'org.example.homebase', development: false };
const RETURN = 'org.example.homebase://sovereign-auth/done';

let apple;
test.before(async () => { apple = await createFakeApple({ appId: APP_ID }); });
const nativeConfig = () => ({ config: { nativeApp: NATIVE_APP, appAttestRoots: apple.roots } });

// The app registers this installation; returns what it needs to assert later.
async function registerApp(client) {
  const issued = (await client.post('/_sovereign/auth/app/challenge')).body;
  const attested = await apple.attest({ clientData: appInstanceClientData({ household: issued.household, userId: issued.userId, challenge: issued.challenge }) });
  const answer = await client.post('/_sovereign/auth/app/register', { challenge: issued.challenge, keyId: attested.keyId, attestation: attested.attestation, label: 'Phone' });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return { keyId: attested.keyId, device: attested.device };
}

// One phone: the web view, the app's own requests and the sheet, all on hostname host.
function phone(base, addr, instance, host = HOMEBASE) {
  const webView = browser(base, addr, { host });
  const native = browser(base, addr, { host });
  const attest = (id, { keyId = instance.keyId, clientData = handoffClientData(host, id) } = {}) => native.post('/_sovereign/auth/handoff/attest', { id, keyId, assertion: apple.assert(instance.device, { clientData }) });
  // A fresh, ephemeral sheet each time, as ASWebAuthenticationSession opens it.
  const sheet = () => browser(base, addr, { host });
  return { webView, native, attest, sheet };
}

async function confirmInSheet(sheet, id, authenticator, origin) {
  const options = await sheet.post('/_sovereign/auth/handoff/options', { id });
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const finished = await sheet.post('/_sovereign/auth/handoff/finish', { id, assertion: authenticator.authenticate(options.body.options, { origin }) });
  return { options, finished };
}

const handoffCookies = (client) => [...client.cookies.keys()].filter((name) => name.startsWith('__Host-sv_handoff_'));

test('without the native app there is no handoff, but the sheet\'s static page is there', async (t) => {
  const { base, parent } = await activeHousehold(t);
  assert.equal((await parent.post('/_sovereign/auth/handoff/begin', { purpose: 'check' })).status, 404);
  const page = await fetch(`${base}/_sovereign/auth/handoff/sheet`, { headers: { 'x-forwarded-for': PARENT, 'x-forwarded-host': HOMEBASE } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'; script-src 'self'; connect-src 'self'/);
  assert.match(await page.text(), /<script src="\/_sovereign\/auth\/handoff\/sheet\.js"><\/script>/);
  const script = await fetch(`${base}/_sovereign/auth/handoff/sheet.js`, { headers: { 'x-forwarded-for': PARENT, 'x-forwarded-host': HOMEBASE } });
  assert.match(script.headers.get('content-type'), /javascript/);
});

test('a check on Home Base: begin, attest, the sheet confirms, the web view redeems the cookie once', async (t) => {
  const { base, parent, phone: passkey } = await activeHousehold(t, nativeConfig());
  const instance = await registerApp(parent);
  const { webView, attest, sheet } = phone(base, PARENT, instance);

  const begun = await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'check' });
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  const { id } = begun.body;
  assert.deepEqual(handoffCookies(webView), [`__Host-sv_handoff_${id.slice(0, 16)}`]);
  assert.equal((await attest(id)).status, 200);

  const inSheet = sheet();
  const { options, finished } = await confirmInSheet(inSheet, id, passkey, ORIGIN);
  assert.equal(options.body.summary, 'Unlock administration on Home Base.');
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.deepEqual(finished.body, { return: RETURN });
  assert.equal(inSheet.cookies.size, 0, 'no cookie in the sheet: the result is the web view\'s');

  assert.equal(webView.cookies.has('__Host-sv_assurance'), false);
  const redeemed = await webView.post('/_sovereign/auth/handoff/redeem', { id });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  assert.deepEqual(redeemed.body, { ok: true });
  assert.ok(webView.cookies.has('__Host-sv_assurance'), 'the check\'s cookie is in the web view now');
  assert.deepEqual(handoffCookies(webView), [], 'and the handoff\'s is cleared');
  const status = (await webView.get('/_sovereign/auth/status')).body;
  assert.equal(status.check.label, 'Phone', 'the check counts, with the passkey it used');
  const again = await webView.post('/_sovereign/auth/handoff/redeem', { id });
  assert.deepEqual(again.body, { error: 'handoff_refused', reason: 'unknown_handoff' });
});

test('a check on a sensitive app\'s hostname, named in the sheet; actions run on Home Base only', async (t) => {
  const { base, parent, phone: passkey } = await activeHousehold(t, nativeConfig());
  const instance = await registerApp(parent);
  const { webView, attest, sheet } = phone(base, PARENT, instance, PULSE);
  const action = await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'action', action: { policy: 'privileged-plan', target: 'x', digest: 'd'.repeat(43) } });
  assert.equal(action.status, 400);
  assert.equal(action.body.code, 'INVALID');

  const { id } = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'check' })).body;
  assert.equal((await attest(id, { clientData: handoffClientData(HOMEBASE, id) })).body.reason, 'bad_signature', 'attested for another hostname');
  const second = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'check' })).body.id;
  assert.equal((await attest(second)).status, 200);
  const { options, finished } = await confirmInSheet(sheet(), second, passkey, `https://${PULSE}`);
  assert.equal(options.body.summary, 'Confirm it\'s you to open Family Pulse.');
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.equal((await webView.post('/_sovereign/auth/handoff/redeem', { id: second })).status, 200);
  assert.ok(webView.cookies.has('__Host-sv_assurance'));
});

test('an every-time action: the handoff\'s token makes the identical retry go through', async (t) => {
  const { base, parent, yubikey } = await activeHousehold(t, nativeConfig());
  const instance = await registerApp(parent);
  const { webView, attest, sheet } = phone(base, PARENT, instance);
  // An open-admin cookie for the web view first, through a handoff: rotating the key needs the admin session.
  const check = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'check' })).body.id;
  await attest(check);
  await confirmInSheet(sheet(), check, yubikey, ORIGIN);
  await webView.post('/_sovereign/auth/handoff/redeem', { id: check });

  const first = await webView.post('/_sovereign/auth/signing-key/rotate', {});
  assert.equal(first.status, 401);
  assert.equal(first.body.level, 'every-time');
  const action = { policy: first.body.policy, target: first.body.target, digest: first.body.digest };
  const begun = await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'action', action });
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  await attest(begun.body.id);
  const { options, finished } = await confirmInSheet(sheet(), begun.body.id, yubikey, ORIGIN);
  assert.equal(options.body.summary, `Confirm privileged-plan for ${first.body.target} in Home Base with your hardware key.`);
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  const redeemed = await webView.post('/_sovereign/auth/handoff/redeem', { id: begun.body.id });
  assert.equal(redeemed.status, 200);
  assert.equal(typeof redeemed.body.token, 'string');
  assert.equal(webView.cookies.has('__Host-sv_assurance'), true);
  const retry = await webView.post('/_sovereign/auth/signing-key/rotate', {}, { 'x-sovereign-action-token': redeemed.body.token });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
});

test('a passkey that isn\'t hardware can\'t finish a hardware handoff; the record waits for another try', async (t) => {
  const { base, parent, phone: synced, yubikey } = await activeHousehold(t, nativeConfig());
  const instance = await registerApp(parent);
  const { webView, attest, sheet } = phone(base, PARENT, instance);
  const { id } = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'check', kind: 'hardware' })).body;
  await attest(id);
  const inSheet = sheet();
  const options = await inSheet.post('/_sovereign/auth/handoff/options', { id });
  const refused = await inSheet.post('/_sovereign/auth/handoff/finish', { id, assertion: synced.authenticate({ ...options.body.options, allowCredentials: [] }, { origin: ORIGIN }) });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'CEREMONY_REFUSED');
  // Still attested: the sheet asks again and the hardware key finishes it.
  const { finished } = await confirmInSheet(inSheet, id, yubikey, ORIGIN);
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
});

test('a change to the member between the sheet\'s options and its finish leaves no result', async (t) => {
  const { app, base, parent, phone: passkey } = await activeHousehold(t, nativeConfig());
  const instance = await registerApp(parent);
  const { webView, attest, sheet } = phone(base, PARENT, instance);
  const { id } = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'check' })).body;
  await attest(id);
  const inSheet = sheet();
  const options = await inSheet.post('/_sovereign/auth/handoff/options', { id });
  // Changing the member's apps moves their epoch, which ends their cookies. The challenge was bound to the
  // member as they stood, so the ceremony itself is refused: a result now would carry an epoch it never saw.
  const memberId = (await parent.get('/api/directory')).body.members.find((member) => member.login === 'parent@example.com').memberId;
  app.directory.updateMember({ userId: '1001' }, memberId, { apps: ['family-pulse'] });
  const finished = await inSheet.post('/_sovereign/auth/handoff/finish', { id, assertion: passkey.authenticate(options.body.options, { origin: ORIGIN }) });
  assert.equal(finished.status, 400, JSON.stringify(finished.body));
  assert.equal(finished.body.code, 'CEREMONY_REFUSED');
  assert.match(finished.body.error, /wrong_action/);
  assert.deepEqual((await webView.post('/_sovereign/auth/handoff/redeem', { id })).body, { error: 'handoff_refused', reason: 'not_done' });
});

test('the ceremony is bound to the handoff: check/finish can\'t use its challenge, and it can\'t use check/options\'s', async (t) => {
  const { base, parent, phone: passkey } = await activeHousehold(t, nativeConfig());
  const instance = await registerApp(parent);
  const { webView, attest, sheet } = phone(base, PARENT, instance);
  const { id } = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'check' })).body;
  await attest(id);
  const inSheet = sheet();
  const options = await inSheet.post('/_sovereign/auth/handoff/options', { id });
  const elsewhere = await inSheet.post('/_sovereign/auth/check/finish', { purpose: 'step-up', response: passkey.authenticate(options.body.options, { origin: ORIGIN }) });
  assert.equal(elsewhere.status, 400);
  assert.match(elsewhere.body.error, /wrong_action/);

  const plain = await inSheet.post('/_sovereign/auth/check/options', { purpose: 'step-up' });
  const stale = await inSheet.post('/_sovereign/auth/handoff/finish', { id, assertion: passkey.authenticate(plain.body.options, { origin: ORIGIN }) });
  assert.deepEqual(stale.body, { error: 'handoff_refused', reason: 'stale_challenge' });
});

test('only the household\'s app, for this member, attests; nothing reaches the ceremony before it does', async (t) => {
  const { app, base, parent } = await activeHousehold(t, nativeConfig());
  const instance = await registerApp(parent);
  const { webView, native, attest, sheet } = phone(base, PARENT, instance);
  const { id } = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'check' })).body;
  assert.deepEqual((await sheet().post('/_sovereign/auth/handoff/options', { id })).body, { error: 'handoff_refused', reason: 'not_attested' });

  const unknown = await native.post('/_sovereign/auth/handoff/attest', { id, keyId: Buffer.alloc(32, 9).toString('base64'), assertion: apple.assert(instance.device, { clientData: handoffClientData(HOMEBASE, id) }) });
  assert.deepEqual(unknown.body, { error: 'app_instance_refused', reason: 'unknown_key' });

  // The kid's phone, with the kid's own registered app, can't attest the parent's record.
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  assert.equal((await parent.post('/api/directory/members', { userId: '1002', role: 'kid' })).status, 201);
  const kid = browser(base, KID);
  const kidInstance = await registerApp(kid);
  const kidAttest = await kid.post('/_sovereign/auth/handoff/attest', { id, keyId: kidInstance.keyId, assertion: apple.assert(kidInstance.device, { clientData: handoffClientData(HOMEBASE, id) }) });
  assert.deepEqual(kidAttest.body, { error: 'handoff_refused', reason: 'wrong_member' });
  // The parent's record, attested with the kid's key by the parent's phone.
  const crossed = await native.post('/_sovereign/auth/handoff/attest', { id, keyId: kidInstance.keyId, assertion: apple.assert(kidInstance.device, { clientData: handoffClientData(HOMEBASE, id) }) });
  assert.deepEqual(crossed.body, { error: 'app_instance_refused', reason: 'wrong_member' });

  // Revoked, the parent's key attests nothing.
  assert.equal((await parent.post('/api/directory/app-instances/revoke', { keyId: instance.keyId })).status, 200);
  assert.deepEqual((await attest(id)).body, { error: 'app_instance_refused', reason: 'unknown_key' });
});

test('redeeming needs the web view\'s own cookie, and takes the record whatever happens', async (t) => {
  const { base, parent, phone: passkey } = await activeHousehold(t, nativeConfig());
  const instance = await registerApp(parent);
  const { webView, native, attest, sheet } = phone(base, PARENT, instance);
  const { id } = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'check' })).body;
  await attest(id);
  await confirmInSheet(sheet(), id, passkey, ORIGIN);
  // Another client on the phone, without the web view's cookie: the record is gone after this.
  const stolen = await native.post('/_sovereign/auth/handoff/redeem', { id });
  assert.deepEqual(stolen.body, { error: 'handoff_refused', reason: 'no_cookie' });
  assert.equal(native.cookies.has('__Host-sv_assurance'), false);
  assert.deepEqual((await webView.post('/_sovereign/auth/handoff/redeem', { id })).body, { error: 'handoff_refused', reason: 'unknown_handoff' });
  assert.equal(webView.cookies.has('__Host-sv_assurance'), false);
});

test('begin makes the checks check/options makes', async (t) => {
  const { app, base, parent } = await activeHousehold(t, nativeConfig());
  assert.equal((await parent.post('/_sovereign/auth/handoff/begin', { purpose: 'enroll' })).body.code, 'INVALID');
  assert.equal((await parent.post('/_sovereign/auth/handoff/begin', { purpose: 'action', action: { policy: 'no-such-thing', target: 'x', digest: 'd'.repeat(43) } })).body.code, 'INVALID');
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  await parent.post('/api/directory/members', { userId: '1002', role: 'kid' });
  const kid = browser(base, KID);
  const none = await kid.post('/_sovereign/auth/handoff/begin', { purpose: 'check' });
  assert.equal(none.status, 409);
  assert.equal(none.body.code, 'NO_CREDENTIAL');
  const notTheirs = await kid.post('/_sovereign/auth/handoff/begin', { purpose: 'action', action: { policy: 'privileged-plan', target: 'x', digest: 'd'.repeat(43) } });
  assert.equal(notTheirs.status, 403);
  assert.equal(notTheirs.body.code, 'NOT_AUTHORIZED');
  const stranger = await browser(base, '100.64.0.9').post('/_sovereign/auth/handoff/begin', { purpose: 'check' });
  assert.equal(stranger.status, 403);
});

test('setup: no handoff until Home Base is active', async (t) => {
  const { base } = await startServer(t, nativeConfig());
  const parent = browser(base, PARENT);
  assert.equal((await parent.post('/api/admin/setup', { passphrase: PASSPHRASE })).status, 200);
  await parent.enroll(createAuthenticator(), { label: 'Phone' });
  const refused = await parent.post('/_sovereign/auth/handoff/begin', { purpose: 'check' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'BOOTSTRAP_STATE');
});

test('every handoff result is audited with the app key that attested it', async (t) => {
  const { base, parent, phone: passkey, root } = await activeHousehold(t, nativeConfig());
  const instance = await registerApp(parent);
  const { webView, attest, sheet } = phone(base, PARENT, instance);
  const { id } = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'check' })).body;
  await attest(id);
  await confirmInSheet(sheet(), id, passkey, ORIGIN);
  const { SqliteStateStore } = require('../src/state/sqlite-store');
  const audit = new SqliteStateStore(require('path').join(root, 'state.sqlite3')).listAdminAudit(50);
  assert.ok(audit.some((entry) => entry.action === 'passkey-step-up' && entry.outcome.includes(`in the app (key ${instance.keyId.slice(0, 12)}…)`)), JSON.stringify(audit.slice(0, 5)));
});

test('options and finish ask again what begin asked: a revoked passkey or a lost authority stops the handoff', async (t) => {
  const { app, base, parent, yubikey } = await activeHousehold(t, nativeConfig());
  const instance = await registerApp(parent);
  const { webView, attest, sheet } = phone(base, PARENT, instance);
  const action = { policy: 'privileged-plan', target: 'restore nightly', digest: 'd'.repeat(43) };

  // Demoted between begin and options (a root reset hands administration to someone else, say).
  const original = app.directory.standing;
  const demote = () => { app.directory.standing = (userId) => { const standing = original(userId); return standing && { ...standing, member: { ...standing.member, administrator: false } }; }; };
  t.after(() => { app.directory.standing = original; });
  const before = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'action', action })).body.id;
  await attest(before);
  demote();
  const noOptions = await sheet().post('/_sovereign/auth/handoff/options', { id: before });
  assert.equal(noOptions.status, 403, JSON.stringify(noOptions.body));
  assert.equal(noOptions.body.code, 'NOT_AUTHORIZED');

  // Demoted between options and finish.
  app.directory.standing = original;
  const during = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'action', action })).body.id;
  await attest(during);
  const inSheet = sheet();
  const options = await inSheet.post('/_sovereign/auth/handoff/options', { id: during });
  demote();
  const noFinish = await inSheet.post('/_sovereign/auth/handoff/finish', { id: during, assertion: yubikey.authenticate(options.body.options, { origin: ORIGIN }) });
  assert.equal(noFinish.status, 403, JSON.stringify(noFinish.body));
  assert.equal(noFinish.body.code, 'NOT_AUTHORIZED');
  app.directory.standing = original;
  assert.deepEqual((await webView.post('/_sovereign/auth/handoff/redeem', { id: during })).body, { error: 'handoff_refused', reason: 'not_done' });
});

test('a member whose only passkey is revoked mid-handoff is told so, not a server error', async (t) => {
  const { app, base, parent } = await activeHousehold(t, nativeConfig());
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  const added = await parent.post('/api/directory/members', { userId: '1002', role: 'kid' });
  const { code } = (await parent.post(`/api/directory/members/${added.body.memberId}/grant`)).body;
  const kid = browser(base, KID);
  const enrolled = await kid.enroll(createAuthenticator(), { label: 'Tablet', grant: code });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  const instance = await registerApp(kid);
  const { webView, attest, sheet } = phone(base, KID, instance);
  const { id } = (await webView.post('/_sovereign/auth/handoff/begin', { purpose: 'check' })).body;
  await attest(id);
  assert.equal((await parent.post(`/api/directory/credentials/${enrolled.body.credentialId}/revoke`)).status, 200);
  const options = await sheet().post('/_sovereign/auth/handoff/options', { id });
  assert.equal(options.status, 409, JSON.stringify(options.body));
  assert.equal(options.body.code, 'NO_CREDENTIAL');
});
