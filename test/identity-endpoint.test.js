const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalAddress, createIdentityResolver, createIdentityServer, listenIdentitySocket, startIdentitySocketWhenReady } = require('../src/identity/identity-endpoint');

const KID = { Node: { ID: 7, StableID: 'nKid1CNTRL', Tags: [] }, UserProfile: { ID: 4242, LoginName: 'kid@example.com', DisplayName: 'Kid Ö' } };
const TAGGED = { Node: { ID: 8, StableID: 'nSrv1CNTRL', Tags: ['tag:server'] }, UserProfile: { ID: 1, LoginName: 'tagged-devices', DisplayName: 'Tagged Devices' } };
const STATUS = { Self: { TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'] } };
const ADMITTED = { lookup: (id) => (id === '4242' ? { admitted: true } : null) };

function resolver({ whois = async (addr) => ({ '100.64.0.5': KID, '100.64.0.8': TAGGED })[addr] || Promise.reject(new Error('no such peer')), status = async () => STATUS, directory = ADMITTED, now } = {}) {
  const calls = { whois: 0, status: 0 };
  const resolve = createIdentityResolver({
    whois: async (addr) => { calls.whois += 1; return whois(addr); },
    status: async () => { calls.status += 1; return status(); },
    directory,
    now,
  });
  return { resolve, calls };
}
const ask = (addr, login = 'kid@example.com') => ({ 'x-sovereign-client-addr': addr, 'x-sovereign-serve-login': login });

test('an admitted member on a user-owned device gets their stable user ID', async () => {
  const { resolve } = resolver();
  assert.deepEqual(await resolve(ask('100.64.0.5')), { userId: '4242', login: 'kid@example.com', name: 'Kid Ö' });
});

test('no identity: tagged devices, unknown peers, login mismatch, not admitted, no directory', async () => {
  assert.equal(await resolver().resolve(ask('100.64.0.8', 'tagged-devices')), null);
  assert.equal(await resolver().resolve(ask('100.64.0.9')), null);
  assert.equal(await resolver().resolve(ask('100.64.0.5', 'parent@example.com')), null, 'whois must agree with Serve');
  assert.equal(await resolver({ directory: { lookup: () => ({ admitted: false }) } }).resolve(ask('100.64.0.5')), null);
  assert.equal(await createIdentityResolver({ whois: async () => KID, status: async () => STATUS })(ask('100.64.0.5')), null, 'until SID-004 nobody is admitted');
  assert.equal(await resolver({ whois: async () => ({ ...KID, UserProfile: { ...KID.UserProfile, ID: 0 } }) }).resolve(ask('100.64.0.5')), null);
  assert.equal(await resolver({ whois: async () => ({ Node: KID.Node }) }).resolve(ask('100.64.0.5')), null);
});

test("the host's own addresses never get an identity, however they are written (IPv4 and IPv6)", async () => {
  const self = { ...KID };
  const { resolve, calls } = resolver({ whois: async () => self });
  for (const addr of ['100.64.0.1', '::ffff:100.64.0.1', 'fd7a:115c:a1e0::1', 'FD7A:115C:A1E0:0:0:0:0:1', 'fd7a:115c:a1e0:0000::0001']) {
    assert.equal(await resolve(ask(addr)), null, addr);
  }
  assert.equal(calls.whois, 0, 'refused before asking whois');
  assert.equal(canonicalAddress('fd7a:115c:a1e0:0000::0001'), 'fd7a:115c:a1e0::1');
});

test('without its own addresses the self guard cannot run, so nobody gets an identity', async () => {
  assert.equal(await resolver({ status: async () => { throw new Error('tailscaled down'); } }).resolve(ask('100.64.0.5')), null);
  assert.equal(await resolver({ status: async () => ({ Self: {} }) }).resolve(ask('100.64.0.5')), null);
});

test('input that did not come from Serve is refused before any lookup', async () => {
  const { resolve, calls } = resolver();
  for (const headers of [{}, ask(''), ask('100.64.0.5, 100.64.0.6'), ask('not-an-ip'), ask('100.64.0.5', ''), ask('100.64.0.5', 'kid @example.com'), ask('100.64.0.5', 'a\r\nb')]) {
    assert.equal(await resolve(headers), null, JSON.stringify(headers));
  }
  assert.equal(calls.whois, 0);
});

test('answers are cached briefly per address and login, then looked up again', async () => {
  let clock = 1_000_000;
  const { resolve, calls } = resolver({ now: () => clock });
  await resolve(ask('100.64.0.5'));
  await resolve(ask('100.64.0.5'));
  assert.equal(calls.whois, 1);
  clock += 5_001;
  await resolve(ask('100.64.0.5'));
  assert.equal(calls.whois, 2, 'a revoked member drops out within seconds');
  assert.equal(calls.status, 1, 'own addresses are cached longer');
});

test('the socket server answers 204 with identity headers, 204 without, and 404 elsewhere', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'));
  const socketPath = path.join(dir, 'identity.sock');
  const server = createIdentityServer({ resolve: resolver().resolve });
  await new Promise((done) => listenIdentitySocket(server, socketPath, done));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o666, 'the directory (0750 homebase:www-data) decides who connects');
  const get = (url, headers) => new Promise((resolveResponse, reject) => {
    http.get({ socketPath, path: url, headers }, (res) => { res.resume(); res.on('end', () => resolveResponse(res)); }).on('error', reject);
  });
  const member = await get('/_sovereign/identity', ask('100.64.0.5'));
  assert.equal(member.statusCode, 204);
  assert.equal(member.headers['x-sovereign-user-id'], '4242');
  assert.equal(member.headers['x-sovereign-login'], 'kid@example.com');
  assert.equal(decodeURIComponent(member.headers['x-sovereign-name']), 'Kid Ö');
  const nobody = await get('/_sovereign/identity', ask('100.64.0.9'));
  assert.equal(nobody.statusCode, 204);
  assert.equal(nobody.headers['x-sovereign-user-id'], undefined);
  assert.equal((await get('/other', ask('100.64.0.5'))).statusCode, 404);
});

test('a directory that throws means no identity, not an error page', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'));
  const socketPath = path.join(dir, 'identity.sock');
  const server = createIdentityServer({ resolve: resolver({ directory: { lookup: () => { throw new Error('db locked'); } } }).resolve });
  await new Promise((done) => listenIdentitySocket(server, socketPath, done));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const res = await new Promise((done) => http.get({ socketPath, path: '/_sovereign/identity', headers: ask('100.64.0.5') }, (response) => { response.resume(); response.on('end', () => done(response)); }));
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['x-sovereign-user-id'], undefined);
});

test('the identity socket starts once the cutover has created its directory', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'));
  const dir = path.join(parent, 'homebase');
  const socketPath = path.join(dir, 'identity.sock');
  const server = createIdentityServer({ resolve: async () => null });
  const logs = [];
  const stop = startIdentitySocketWhenReady({ server, socketPath, intervalMs: 20, log: (line) => logs.push(line) });
  t.after(() => { stop(); server.close(); fs.rmSync(parent, { recursive: true, force: true }); });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(server.listening, false, 'nothing to listen in before the cutover');
  fs.mkdirSync(dir);
  for (let i = 0; i < 50 && !server.listening; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.listening, true);
  assert.deepEqual(logs, [`identity lookups on ${socketPath}`]);
});
