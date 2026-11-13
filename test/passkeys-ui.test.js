const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const base = { state: 'active', instance: 'prod', member: { login: 'parent@example.com', name: 'Parent', role: 'parent', administrator: true }, credentials: [{ credentialId: 'key-1', label: 'Primary <key>', kind: 'hardware', createdAt: '2026-11-01T00:00:00Z', lastUsedAt: null, usable: true, handleFormat: 'legacy-v1', handleMetadataValid: true }], check: null, administratorRuleMet: true, canActivate: false, enrollmentMetadataValid: true, isolatedIssuedAt: '2026-11-13T00:00:00Z' };

async function page(status, { postError = null } = {}) {
  const sent = []; const events = {}; const result = { textContent: '' }; let reloads = 0;
  const root = { innerHTML: '', addEventListener: (name, fn) => { events[name] = fn; }, querySelector: () => result };
  const window = { location: { reload: () => { reloads++; } } };
  const context = vm.createContext({ window, document: {}, navigator: {}, console, setTimeout, fetch: async (url, options = {}) => {
    sent.push({ url, ...options });
    const error = options.method === 'POST' && postError;
    const body = options.method === 'POST' ? error ? { error } : { ok: true } : status;
    return { ok: !error, status: error ? 401 : 200, text: async () => JSON.stringify(body) };
  } });
  for (const name of ['api.js', 'passkeys.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8'), context, { filename: name });
  await window.HBPasskeys.mount(root); window.HBPasskeys.wire(root);
  return { root, sent, result, reloads: () => reloads,
    async remove() {
      assert.match(root.innerHTML, /data-passkey-revoke="key-1"/);
      const directory = /data-passkey-directory-revoke="true"/.test(root.innerHTML);
      const button = { dataset: { passkeyRevoke: 'key-1', ...(directory ? { passkeyDirectoryRevoke: 'true' } : {}) } };
      await events.click({ target: { closest: () => button } });
    },
  };
}

test('Passkeys explains isolated versus compatible legacy accounts and the administrative rollback floor', async () => {
  const status = { ...base, instance: 'prod <unsafe>', credentials: [...base.credentials, { ...base.credentials[0], credentialId: 'key-2', label: 'Backup', handleFormat: 'isolated-v2' }] };
  const ui = await page(status);
  assert.match(ui.root.innerHTML, /Legacy \(compatible\)/);
  assert.match(ui.root.innerHTML, /Isolated/);
  assert.match(ui.root.innerHTML, /Do not downgrade/);
  assert.match(ui.root.innerHTML, /prod &lt;unsafe&gt;/);
  assert.match(ui.root.innerHTML, /Primary &lt;key&gt;/);
  assert.deepEqual(ui.sent.map((request) => request.url), ['/_sovereign/auth/status']);
});

test('administrator recovery removal uses the existing passphrase-authorized directory route', async () => {
  const ui = await page({ ...base, state: 'recovery' });
  await ui.remove();
  assert.equal(ui.sent[1].url, '/api/directory/credentials/key-1/revoke');
  assert.equal(ui.sent[1].method, 'POST');
  assert.equal(ui.sent[1].credentials, 'same-origin');
  assert.equal(ui.reloads(), 1);
});

test('active administrator and member removals retain the normal step-up route', async () => {
  for (const administrator of [true, false]) {
    const ui = await page({ ...base, member: { ...base.member, administrator } });
    await ui.remove();
    assert.equal(ui.sent[1].url, '/_sovereign/auth/credentials/revoke');
    assert.equal(JSON.parse(ui.sent[1].body).credentialId, 'key-1');
    if (!administrator) assert.doesNotMatch(ui.root.innerHTML, /Do not downgrade/);
  }
});

test('metadata corruption is visible without hiding status or promising that every key can check', async () => {
  const ui = await page({ ...base, enrollmentMetadataValid: false, credentials: [{ ...base.credentials[0], handleMetadataValid: false, webauthn_user_handle: 'DO-NOT-RENDER' }] });
  assert.match(ui.root.innerHTML, /Invalid account metadata/);
  assert.match(ui.root.innerHTML, /metadata.*(?:unavailable|inconsistent)/i);
  assert.doesNotMatch(ui.root.innerHTML, /DO-NOT-RENDER/);
});

test('a locked recovery removal surfaces the server refusal and never reloads or retries', async () => {
  const ui = await page({ ...base, state: 'recovery' }, { postError: 'Unlock Home Base as the administrator first.' });
  await ui.remove();
  assert.match(ui.result.textContent, /Unlock Home Base/);
  assert.equal(ui.reloads(), 0);
  assert.equal(ui.sent.length, 2);
});
