// Feature-10 D1: the identity lookup nginx makes on every request (auth_request). nginx sends what Serve
// set from the tailnet connection: the client's tailnet address (X-Forwarded-For) and login
// (Tailscale-User-Login). This endpoint asks tailscaled who that address is (whois) and answers with the
// stable user ID only when everything agrees. Any doubt means "no identity": the request still reaches
// the app, without X-Sovereign-* headers. If this endpoint is down, nginx refuses the request (fail closed).
//
// Not identity: tagged devices (D2), the host's own addresses (a local process requesting the host's own
// public URL, spike 3), unknown logins, and anyone the household directory has not admitted.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IDENTITY_PATH = '/_sovereign/identity';
const CACHE_MS = 5_000;
const SELF_CACHE_MS = 60_000;
const CACHE_LIMIT = 1_000;
const LOGIN = /^[\x21-\x7e]{1,320}$/;

function runJson(binary, args, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try { return resolve(JSON.parse(stdout)); } catch (parseError) { return reject(parseError); }
    });
  });
}

const tailscaleWhois = (addr) => runJson('tailscale', ['whois', '--json', addr]);
const tailscaleStatus = () => runJson('tailscale', ['status', '--json', '--peers=false']);

// Canonical text for an address, so "::ffff:100.64.0.5" or differently written IPv6 compares equal.
function canonicalAddress(value) {
  let text = String(value || '').trim();
  if (net.isIPv6(text) && /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(text)) text = text.slice(7);
  if (net.isIPv4(text)) return text;
  if (!net.isIPv6(text)) return null;
  // Expand :: and drop leading zeros: new URL() normalizes IPv6 hosts.
  return new URL(`http://[${text}]/`).hostname.slice(1, -1).toLowerCase();
}

// directory.lookup(userId, { login, name }) → { admitted: true } for members the administrator admitted
// (SID-004). Until there is a directory, nobody is admitted.
const NO_DIRECTORY = Object.freeze({ lookup: () => null });

// Who a tailnet address is, from tailscaled alone: { userId, login, name }, or null for the host's own
// addresses (spike 3), tagged devices (D2), a failed lookup or an ID that isn't one. Neither the login
// check nor admission happens here.
function createWhoisIdentity({ whois = tailscaleWhois, status = tailscaleStatus, now = Date.now, log = () => {} } = {}) {
  let self = { addresses: null, at: -Infinity };

  async function selfAddresses() {
    if (self.addresses && now() - self.at < SELF_CACHE_MS) return self.addresses;
    const payload = await status();
    const ips = payload?.Self?.TailscaleIPs;
    if (!Array.isArray(ips) || !ips.length) throw new Error('tailscale status has no Self.TailscaleIPs');
    self = { addresses: new Set(ips.map(canonicalAddress).filter(Boolean)), at: now() };
    return self.addresses;
  }

  return async function identify(addr) {
    let addresses;
    try { addresses = await selfAddresses(); } catch (error) {
      // Without the host's own addresses the self guard cannot run, so nobody gets an identity.
      log(`identity: cannot read this host's tailnet addresses (${error.message}); no identity`);
      return null;
    }
    if (addresses.has(addr)) return null;
    let who;
    try { who = await whois(addr); } catch (error) {
      log(`identity: whois ${addr} failed (${error.message}); no identity`);
      return null;
    }
    const node = who?.Node;
    const profile = who?.UserProfile;
    if (!node || !profile) return null;
    if (Array.isArray(node.Tags) && node.Tags.length) return null;
    const userId = profile.ID;
    if (!(Number.isSafeInteger(userId) && userId > 0) && !(typeof userId === 'string' && /^[A-Za-z0-9]{1,64}$/.test(userId))) return null;
    if (typeof profile.LoginName !== 'string') return null;
    return { userId: String(userId), login: profile.LoginName, name: String(profile.DisplayName || '') };
  };
}

function createIdentityResolver({ whois = tailscaleWhois, status = tailscaleStatus, directory = NO_DIRECTORY, now = Date.now, log = () => {} } = {}) {
  const cache = new Map();
  const identify = createWhoisIdentity({ whois, status, now, log });

  async function lookup(addr, serveLogin) {
    const identity = await identify(addr);
    if (!identity) return null;
    if (identity.login !== serveLogin) {
      log(`identity: whois login for ${addr} does not match Serve's; no identity`);
      return null;
    }
    const member = directory.lookup(identity.userId, identity);
    if (!member?.admitted) return null;
    return identity;
  }

  // The answer for one lookup request's headers, or null for "no identity".
  return async function resolve(headers = {}) {
    const rawAddr = String(headers['x-sovereign-client-addr'] || '');
    const serveLogin = String(headers['x-sovereign-serve-login'] || '');
    // Serve sends exactly one address and a login; anything else did not come from Serve.
    if (!rawAddr || rawAddr.includes(',') || !LOGIN.test(serveLogin)) return null;
    const addr = canonicalAddress(rawAddr);
    if (!addr) return null;
    const key = `${addr}|${serveLogin}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < CACHE_MS) return cached.value;
    const value = lookup(addr, serveLogin);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, { at: now(), value });
    return value;
  };
}

// Header values are ASCII; the display name is percent-encoded (the sovereignAuth contract decodes it).
function writeAnswer(res, identity) {
  if (identity) {
    res.setHeader('X-Sovereign-User-Id', identity.userId);
    res.setHeader('X-Sovereign-Login', identity.login);
    if (identity.name) res.setHeader('X-Sovereign-Name', encodeURIComponent(identity.name));
  }
  res.statusCode = 204;
  res.end();
}

function createIdentityServer({ resolve, log = () => {} }) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== IDENTITY_PATH) {
      res.statusCode = 404;
      return res.end();
    }
    return Promise.resolve()
      .then(() => resolve(req.headers))
      .then((identity) => writeAnswer(res, identity))
      .catch((error) => {
        log(`identity: lookup failed (${error.message}); no identity`);
        writeAnswer(res, null);
      });
  });
}

// Listens on the identity socket. Access is the directory's job (/run/homebase-identity, 0750 homebase:www-data):
// the socket itself is 0666 so nginx's group can connect, and only Home Base and nginx can reach it.
function listenIdentitySocket(server, socketPath, callback) {
  try { if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o666);
    if (callback) callback();
  });
}

// The cutover creates the socket's directory; until then there is nothing to listen in. Checks again
// every interval and starts once, so Home Base needs no restart after a cutover.
function startIdentitySocketWhenReady({ server, socketPath, intervalMs = 15_000, log = () => {}, statFn = (target) => fs.statSync(target) }) {
  let timer = null;
  const attempt = () => {
    let dir;
    try { dir = statFn(path.dirname(socketPath)); } catch { dir = null; }
    if (!dir || !dir.isDirectory()) return false;
    if (timer) clearInterval(timer);
    timer = null;
    listenIdentitySocket(server, socketPath, () => log(`identity lookups on ${socketPath}`));
    return true;
  };
  if (!attempt()) {
    timer = setInterval(attempt, intervalMs);
    if (timer.unref) timer.unref();
  }
  return () => { if (timer) clearInterval(timer); };
}

module.exports = { IDENTITY_PATH, canonicalAddress, runJson, createIdentityResolver, createWhoisIdentity, createIdentityServer, listenIdentitySocket, startIdentitySocketWhenReady };
