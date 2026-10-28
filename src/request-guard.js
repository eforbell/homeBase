// Every state-changing API request must come from Home Base's own pages (bugBase #150). A browser marks a
// request from another site, or another tailnet hostname (D20: one site), in Sec-Fetch-Site; a form can't
// send application/json, and Home Base answers no CORS preflight, so the content type covers browsers
// without fetch metadata. That holds for empty requests too: a no-CORS POST with no body still carries the
// session cookie (lock). Clients outside a browser send no fetch metadata and only need the content type.
// SID-003's sovereignAuth guards (below) add the Origin check and resource isolation; this stays as the
// floor for requests they don't cover.

const { createRequestGuard, guardHttp, normalizeOrigin } = require('sovereign-auth');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

function refuseUnsafeRequest(req, method = req.method || 'GET') {
  if (SAFE_METHODS.has(method)) return null;
  const site = req.headers['sec-fetch-site'];
  if (site && !ALLOWED_FETCH_SITES.has(String(site).toLowerCase())) {
    return { statusCode: 403, payload: { error: 'Home Base refuses changes requested from another site or hostname.', code: 'CROSS_ORIGIN' } };
  }
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { statusCode: 415, payload: { error: 'Home Base accepts changes only as application/json.', code: 'JSON_REQUIRED' } };
  }
  return null;
}

const GUARD_MODES = ['off', 'report', 'enforce'];
const MAX_CACHED_HOSTS = 32;

// sovereignAuth's request guards (wire contract, section 4), behind HOME_BASE_REQUEST_GUARDS: 'off' (the
// default), 'report' (log what enforce would refuse) or 'enforce'. They protect a browser that reached Home
// Base through Tailscale Serve. Serve always sets X-Forwarded-Host to the hostname the member asked for
// (spike 3), and on a service hostname nginx refuses any other. A request without it came straight to the
// loopback port from this host (the installer's health probe, an SSH tunnel); refuseUnsafeRequest still
// covers those.
//
// Home Base answers on several hostnames: its own service hostname, the passkey mount on each sensitive
// app's, and the host's own name before cutover. Each one is a strict hostname with its own origin, so a
// request must match the hostname it came in on.
function createSuiteRequestGuard({ mode = 'off', log = console.warn } = {}) {
  if (!GUARD_MODES.includes(mode)) throw new Error(`HOME_BASE_REQUEST_GUARDS must be off, report or enforce, not ${mode}`);
  if (mode === 'off') return () => true;
  const byHost = new Map();

  function guardFor(host) {
    if (byHost.has(host)) return byHost.get(host);
    let guard = null;
    try {
      guard = guardHttp(createRequestGuard({ origin: normalizeOrigin(`https://${host}`) }), { mode, log });
    } catch {
      // Not a hostname. Serve never sends one, so only a local process could; refuse it like a mismatch.
    }
    if (byHost.size < MAX_CACHED_HOSTS) byHost.set(host, guard);
    return guard;
  }

  return function guardSuiteRequest(req, res) {
    const host = req.headers['x-forwarded-host'];
    if (host === undefined) return true;
    const guard = guardFor(String(host));
    if (guard) return guard(req, res);
    log(`[homebase] ${mode === 'report' ? 'would refuse' : 'refused'} ${req.method} ${String(req.url || '/').split('?')[0]}: forwarded host is not a hostname`);
    if (mode === 'report') return true;
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'request_refused', reason: 'forwarded_host', message: 'The forwarded host is not a hostname.' }));
    return false;
  };
}

module.exports = { createSuiteRequestGuard, refuseUnsafeRequest };
