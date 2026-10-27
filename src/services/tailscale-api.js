const fs = require('fs');

// Read-only Tailscale API access for service-host verification (Feature-10 D23). The credential is a
// trust credential (OAuth client) limited to services:read and devices:core:read, plus policy_file:read
// for the policy warnings; checked against the live API on 2026-10-27. Home Base only ever GETs.
// The credential file holds TS_OAUTH_CLIENT_ID= and TS_OAUTH_CLIENT_SECRET= lines, readable by Home
// Base alone.

const API = 'https://api.tailscale.com/api/v2';
const TOKEN_MARGIN_MS = 60_000;
const SERVICE_NAME = /^svc:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function readCredential(filePath, fsImpl = fs) {
  let text;
  try { text = fsImpl.readFileSync(filePath, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const values = Object.fromEntries(String(text).split('\n')
    .map((line) => /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line))
    .filter(Boolean)
    .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]));
  if (!values.TS_OAUTH_CLIENT_ID || !values.TS_OAUTH_CLIENT_SECRET) throw new Error(`${filePath} needs TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET`);
  return { clientId: values.TS_OAUTH_CLIENT_ID, clientSecret: values.TS_OAUTH_CLIENT_SECRET };
}

// Returns null when no credential is configured (the household uses administrator confirmation).
function createTailscaleApi({ credentialPath, fsImpl = fs, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
  const credential = credentialPath ? readCredential(credentialPath, fsImpl) : null;
  if (!credential) return null;
  let token = null;

  async function accessToken() {
    if (token && token.expiresAt - TOKEN_MARGIN_MS > now()) return token.value;
    const body = new URLSearchParams({ client_id: credential.clientId, client_secret: credential.clientSecret });
    const response = await fetchImpl(`${API}/oauth/token`, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw Object.assign(new Error(`token exchange refused (HTTP ${response.status})`), { status: response.status });
    const payload = await response.json();
    if (typeof payload.access_token !== 'string') throw new Error('token exchange returned no access token');
    token = { value: payload.access_token, expiresAt: now() + (Number(payload.expires_in) || 3600) * 1000, scope: String(payload.scope || '') };
    return token.value;
  }

  // { ok, status, body } for any answer; { ok: false, error } when there was none. Never throws.
  async function get(path) {
    try {
      const response = await fetchImpl(`${API}/tailnet/-${path}`, { headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      return { ok: false, status: error.status ?? null, error: error.message };
    }
  }

  // Service names go into the path as written (svc:<name>, the form checked against the live API).
  const servicePath = (service) => {
    if (!SERVICE_NAME.test(String(service))) throw new Error(`not a service name: ${service}`);
    return `/services/${service}`;
  };

  return {
    listServiceHosts: async (service) => get(`${servicePath(service)}/devices`),
    getService: async (service) => get(servicePath(service)),
    listDevices: () => get('/devices?fields=default'),
    getPolicy: () => get('/acl'),
    grantedScopes: () => token?.scope || null,
  };
}

module.exports = { createTailscaleApi, readCredential };
