// Feature-10: a household on a test Home Base, shared by the passkey and route-matrix tests. Who is asking comes
// from tailscaled (stubbed) by X-Forwarded-For; the hostname from Serve's X-Forwarded-Host.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../../src/app');
const { SqliteStateStore } = require('../../src/state/sqlite-store');
const { attestationFixture, createAuthenticator } = require('./authenticator');

const DOMAIN = 'example-tailnet.ts.net';
const HOMEBASE = `smith-homebase.${DOMAIN}`;
const ORIGIN = `https://${HOMEBASE}`;
// A sensitive app's own hostname (family-pulse, catalog network.dedicatedHostname).
const PULSE = `smith-pulse.${DOMAIN}`;
const PEERS = {
  '100.64.0.1': { Node: { Tags: [] }, UserProfile: { ID: 1001, LoginName: 'parent@example.com', DisplayName: 'Parent' } },
  '100.64.0.2': { Node: { Tags: [] }, UserProfile: { ID: 1002, LoginName: 'kid@example.com', DisplayName: 'Kid' } },
};
const PARENT = '100.64.0.1';
const KID = '100.64.0.2';
const PASSPHRASE = 'correct horse battery';

// whois: the stub's answer for an address, or a test's own in its place (one that pauses, say).
const PEER_WHOIS = async (addr) => { if (!PEERS[addr]) throw new Error('no such peer'); return PEERS[addr]; };

// again: the root of a server this test already ran, to start Home Base again on its files. roots: the
// attestation roots it pins (the test root unless given). alerts: an array that collects health alerts.
// config: more of Home Base's configuration (executor mode, say).
async function startServer(t, { cutOver = true, whois = PEER_WHOIS, again = null, roots = attestationFixture().roots, alerts = null, config = {} } = {}) {
  const root = again || fs.mkdtempSync(path.join(os.tmpdir(), 'hb-passkeys-'));
  const identityDir = path.join(root, 'identity');
  const stateDbPath = path.join(root, 'state.sqlite3');
  if (!again) {
    fs.mkdirSync(identityDir, { mode: 0o755 });
    fs.chmodSync(identityDir, 0o755);
  }
  if (cutOver && !again) {
    const store = new SqliteStateStore(stateDbPath);
    store.init();
    const { id } = store.createJob({ kind: 'ingress-cutover', target: 'smith', status: 'queued', dryRun: false, createdAt: new Date().toISOString(), currentStep: null, planJson: '{}' });
    store.updateJob(id, { status: 'completed', finishedAt: new Date().toISOString() });
  }
  const app = createApp({
    appName: 'Home Base',
    stateDbPath,
    port: 0,
    bindHost: '127.0.0.1',
    serviceUser: 'sovereign',
    identitySocket: '',
    identitySnapshotFile: path.join(identityDir, 'snapshot.json'),
    identitySnapshotTrustedRoot: root,
    ingressCheckDelayMs: 3_600_000,
    healthAlertCheckDelayMs: 3_600_000,
    instance: 'smith',
    defaultDomain: DOMAIN,
    directory: true,
    passkeyRoots: roots,
    ...(alerts ? { healthAlertsEnabled: true, healthAlertsWebhookUrl: 'https://alerts.example/hook', notificationsPostJson: async (url, body) => { alerts.push(body); } } : {}),
    identityWhois: whois,
    identityStatus: async () => ({ Self: { TailscaleIPs: ['100.64.0.100'] } }),
    // Most tests reach Home Base over TCP; outside tests passkeys need its socket (homebase-socket.test.js).
    passkeysOverTcp: true,
    ...config,
  });
  await new Promise((resolve) => app.listen(resolve));
  let stopped = false;
  const stop = () => new Promise((resolve) => { if (stopped) return resolve(); stopped = true; app.stop(); app.server.close(resolve); });
  t.after(stop);
  // After the stop: hooks run in the order they were added, and Home Base must not outlive its files.
  if (!again) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, root, stop, snapshot: () => JSON.parse(fs.readFileSync(path.join(identityDir, 'snapshot.json'), 'utf8')) };
}

// A browser on one tailnet device: its cookies by name, and the hostname it asked for.
function browser(base, addr, { host = HOMEBASE } = {}) {
  const cookies = new Map();
  const request = async (method, url, body, extra = {}) => {
    const headers = { 'x-forwarded-for': addr, 'x-forwarded-host': host, ...extra };
    if (cookies.size) headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      if (attributes.some((attribute) => attribute.trim() === 'Max-Age=0')) cookies.delete(name);
      else cookies.set(name, pair.slice(at + 1));
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.getSetCookie() };
  };
  const get = (url) => request('GET', url);
  const post = (url, body = {}, headers = {}) => request('POST', url, body, headers);
  // What stepup.js does with an every-time 401: an action ceremony, then the token.
  async function actionToken(authenticator, stepUp, { origin = ORIGIN } = {}) {
    const action = { policy: stepUp.policy, target: stepUp.target, digest: stepUp.digest };
    const started = await post('/_sovereign/auth/check/options', { purpose: 'action', action });
    if (started.status !== 200) return started;
    return post('/_sovereign/auth/check/finish', { purpose: 'action', action, response: authenticator.authenticate(started.body.options, { origin }) });
  }
  return {
    get,
    post,
    cookies,
    actionToken,
    // A POST, and on an every-time 401 the ceremony with authenticator and one identical retry.
    async confirmed(authenticator, url, body = {}) {
      const first = await post(url, body);
      if (first.status !== 401 || first.body.level !== 'every-time') return { first, retry: null, token: null };
      const issued = await actionToken(authenticator, first.body);
      if (issued.status !== 200) return { first, retry: null, token: null, issued };
      return { first, token: issued.body.token, retry: await post(url, body, { 'x-sovereign-action-token': issued.body.token }) };
    },
    async enroll(authenticator, { label = 'key', hardware = false, grant, origin = ORIGIN } = {}) {
      const started = await post('/_sovereign/auth/enroll/options', { label, hardware, grant });
      if (started.status !== 200) return started;
      return post('/_sovereign/auth/enroll/finish', { label, hardware, grant, response: authenticator.register(started.body.options, { origin }) });
    },
    async check(authenticator, { purpose = 'step-up', kind, origin = ORIGIN } = {}) {
      const started = await post('/_sovereign/auth/check/options', { purpose, kind });
      if (started.status !== 200) return started;
      return post('/_sovereign/auth/check/finish', { purpose, kind, response: authenticator.authenticate(started.body.options, { origin }) });
    },
  };
}

// Setup through activation: the founder, a synced passkey and an attested hardware key.
async function activeHousehold(t, options = {}) {
  const server = await startServer(t, options);
  const parent = browser(server.base, PARENT);
  assert.equal((await parent.post('/api/admin/setup', { passphrase: PASSPHRASE })).status, 200);
  const phone = createAuthenticator({ kind: 'synced' });
  const yubikey = createAuthenticator({ kind: 'hardware' });
  assert.equal((await parent.enroll(phone, { label: 'Phone' })).status, 201);
  assert.equal((await parent.enroll(yubikey, { label: 'YubiKey', hardware: true })).status, 201);
  const activated = await parent.check(yubikey, { purpose: 'activate' });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return { ...server, parent, phone, yubikey };
}

module.exports = { DOMAIN, HOMEBASE, KID, ORIGIN, PARENT, PASSPHRASE, PEERS, PEER_WHOIS, PULSE, activeHousehold, browser, startServer };
