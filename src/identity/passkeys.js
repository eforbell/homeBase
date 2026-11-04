// Feature-10 SID-005: the suite passkey service. Home Base runs every WebAuthn ceremony (through sovereignAuth's
// createWebAuthn, which binds each challenge to its hostname, member, purpose and action and checks
// attestation), keeps the credentials in the household directory, and signs the assurance cookie apps read
// (wire contract, section 7):
//
//   __Host-sv_assurance=<token>; Secure; HttpOnly; Path=/; SameSite=Strict
//
// The cookie names the hostname it was set on (aud), the member's stable user ID (sub), the credential and its
// kind, the member's epoch and the household's global epoch, and when the ceremony ran (auth_time). Revoking a
// credential bumps the member's epoch and recovery bumps the global epoch, so either ends every cookie.
//
// An every-time action (wire contract, section 9) gets an action token instead: minted from a fresh ceremony
// whose challenge was bound to the app, the policy key, the target and the request digest, valid 60 seconds,
// and used once (its jti is consumed in the state database).
//
// Ceremonies run only on the hostname they were started on; the routes (passkey-routes.js) decide who may
// start which one. RP ID is the tailnet domain (D17).
const crypto = require('crypto');
const { ACTION_HEADER, COOKIE_NAME, POLICY, assuranceCookie, createMemoryChallengeStore, createWebAuthn, policyFor, signToken, verifyToken } = require('sovereign-auth');

const KINDS = new Set(['synced', 'device-bound', 'hardware']);
const LABEL_MAX = 60;
const ACTION_SECONDS = 60;

const seconds = (ms) => Math.floor(ms / 1000);

function cookieHeader(token, maxAgeSeconds) {
  return `${COOKIE_NAME}=${token}; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

const clearCookieHeader = () => `${COOKIE_NAME}=; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;

function cleanLabel(label) {
  const text = String(label ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text.slice(0, LABEL_MAX);
}

// directory: the household directory (standing, credentialsFor, addCredential, recordAssertion).
// signingKey: loadSigningKey()'s result. household: the instance name. roots: the attestation roots a
// hardware key must verify to; sovereignAuth's pinned list unless a test gives its own.
function createPasskeys({ directory, signingKey, household, roots, now = Date.now, store = createMemoryChallengeStore({ now }) }) {
  if (!signingKey) throw new Error('the passkey service needs Home Base\'s signing key');
  const keys = new Map([[signingKey.kid, signingKey.publicKey]]);
  const ceremonies = new Map();

  // One ceremony helper per tailnet domain, sharing the challenge store.
  function webauthnFor(rpID) {
    if (!ceremonies.has(rpID)) ceremonies.set(rpID, createWebAuthn({ rpID, store, now, ...(roots ? { roots } : {}) }));
    return ceremonies.get(rpID);
  }

  const memberOf = (standing) => ({ userId: standing.member.userId, login: standing.member.login, name: standing.member.name });

  // Enrollment: attestation is asked for only when the member says it is a hardware key; the kind stored
  // is what the authenticator proves either way (D15).
  // context: what else the challenge binds (the administrator's every-time authority, from the routes).
  async function enrollOptions({ site, standing, label, hardware, context = {} }) {
    return webauthnFor(site.rpID).registrationOptions({
      hostname: site.hostname,
      member: memberOf(standing),
      purpose: 'enroll',
      action: { ...context, label: cleanLabel(label), hardware: hardware === true },
      attestation: hardware === true ? 'direct' : 'none',
      excludeCredentials: directory.credentialsFor(standing.member.userId),
    });
  }

  // Returns { ok, credential } with what directory.addCredential stores, or { ok: false, reason }. The route
  // stores it, after anything else the enrollment needs (an enrollment grant).
  async function enrollFinish({ site, standing, label, hardware, context = {}, response }) {
    const result = await webauthnFor(site.rpID).verifyRegistration({
      hostname: site.hostname,
      member: memberOf(standing),
      purpose: 'enroll',
      action: { ...context, label: cleanLabel(label), hardware: hardware === true },
      response,
    });
    if (!result.ok) return result;
    const { credential } = result;
    return { ok: true, credential: {
      userId: standing.member.userId,
      credentialId: credential.id,
      kind: credential.kind,
      label: cleanLabel(label) || defaultLabel(credential.kind),
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports,
      aaguid: credential.aaguid,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
      root: credential.root,
    } };
  }

  // purpose: 'step-up' (sets the cookie), 'activate' (the administrator's fresh hardware ceremony, D16) or
  // 'action' (an every-time action: audience is the app, action { act, tgt, dig } what the token will bind).
  async function checkOptions({ site, standing, purpose, kind, audience, action }) {
    return webauthnFor(site.rpID).authenticationOptions({
      hostname: site.hostname,
      member: memberOf(standing),
      purpose,
      kind,
      ...(audience ? { audience, action } : {}),
      credentials: directory.credentialsFor(standing.member.userId),
    });
  }

  // Returns { ok, credentialId, kind } or { ok: false, reason }. Whatever a verified assertion showed is
  // stored, even when it is refused for its kind, so a credential that fell never climbs back. The kind
  // returned is the stored one after that merge, never the assertion's alone: a finish that verified while
  // another one demoted the credential gets the demoted kind, and is refused if the check needed hardware.
  async function checkFinish({ site, standing, purpose, kind, audience, action, response }) {
    const result = await webauthnFor(site.rpID).verifyAuthentication({
      hostname: site.hostname,
      member: memberOf(standing),
      purpose,
      kind,
      ...(audience ? { audience, action } : {}),
      credentials: directory.credentialsFor(standing.member.userId),
      response,
    });
    if (!result.update) return result;
    const stored = directory.recordAssertion(standing.member.userId, result.credentialId, result.update);
    if (!result.ok) return result;
    if (kind === 'hardware' && stored.kind !== 'hardware') return { ok: false, reason: 'insufficient_kind', credentialId: result.credentialId };
    return { ...result, kind: stored.kind };
  }

  // The cookie for a ceremony that just ran on site.hostname. It lives as long as the longest window that
  // hostname's sessions use (Home Base: open-admin, 8 hours); apps check their own window from auth_time.
  function issueCookie({ site, standing, credentialId, kind, windowSeconds }) {
    if (!KINDS.has(kind)) throw new Error(`unknown credential kind ${kind}`);
    const at = seconds(now());
    const token = signToken({
      typ: 'assurance',
      kid: signingKey.kid,
      household,
      aud: site.hostname,
      sub: standing.member.userId,
      sid: crypto.randomBytes(16).toString('base64url'),
      cred: credentialId,
      kind,
      epoch: standing.member.epoch,
      global_epoch: standing.globalEpoch,
      auth_time: at,
      iat: at,
      exp: at + windowSeconds,
    }, signingKey.privateKey);
    return cookieHeader(token, windowSeconds);
  }

  // An action token for a fresh ceremony on site.hostname (wire contract, section 9).
  function issueActionToken({ site, standing, app, act, tgt, dig, credentialId, kind }) {
    if (!KINDS.has(kind)) throw new Error(`unknown credential kind ${kind}`);
    const at = seconds(now());
    return signToken({
      typ: 'action',
      kid: signingKey.kid,
      household,
      aud: site.hostname,
      sub: standing.member.userId,
      cred: credentialId,
      kind,
      epoch: standing.member.epoch,
      global_epoch: standing.globalEpoch,
      app,
      act,
      tgt,
      dig,
      jti: crypto.randomBytes(16).toString('base64url'),
      iat: at,
      exp: at + ACTION_SECONDS,
    }, signingKey.privateKey);
  }

  // The claims every token of type typ must hold for this caller on this hostname, as the directory stands
  // now (the same rules apps apply from the snapshot): the claims, or { reason }.
  function verified(token, typ, { site, standing }) {
    const result = verifyToken(token, { keys, now });
    if (!result.ok) return { reason: result.reason };
    const claims = result.payload;
    if (claims.typ !== typ) return { reason: 'wrong_type' };
    if (claims.household !== household) return { reason: 'wrong_household' };
    if (claims.aud !== site.hostname) return { reason: 'wrong_audience' };
    if (!standing || claims.sub !== standing.member.userId) return { reason: 'wrong_member' };
    if (standing.member.status !== 'active') return { reason: 'not_admitted' };
    if (claims.epoch !== standing.member.epoch) return { reason: 'stale_epoch' };
    if (claims.global_epoch !== standing.globalEpoch) return { reason: 'stale_global_epoch' };
    if (!KINDS.has(claims.kind)) return { reason: 'wrong_kind' };
    return { claims };
  }

  // The caller's check on this hostname, as the cookie shows it and the directory stands now: { claims,
  // age } or { claims: null, reason }. The same rules apps apply (section 7), read from the database
  // rather than the snapshot.
  function currentCheck(headers, { site, standing }) {
    const { token, reason } = assuranceCookie(headers);
    if (!token) return { claims: null, reason };
    const { claims, reason: wrong } = verified(token, 'assurance', { site, standing });
    if (!claims) return { claims: null, reason: wrong };
    if (!Number.isSafeInteger(claims.auth_time) || claims.auth_time > claims.iat) return { claims: null, reason: 'malformed' };
    return { claims, age: seconds(now()) - claims.auth_time };
  }

  // The action token on this request, for the every-time policy policyKey of app, bound to target and
  // digest: { claims, consume } (consume is what the commit uses up) or { claims: null, reason }. Checking
  // does not use it up; the change it authorizes does, in the same commit.
  function actionToken(headers, { site, standing, app, policyKey, target, digest }) {
    const header = headers[ACTION_HEADER];
    if (header === undefined) return { claims: null, reason: 'no_token' };
    if (typeof header !== 'string') return { claims: null, reason: 'malformed' };
    const { claims, reason } = verified(header, 'action', { site, standing });
    if (!claims) return { claims: null, reason };
    if (policyFor(policyKey).kind === 'hardware' && claims.kind !== 'hardware') return { claims: null, reason: 'wrong_kind' };
    if (claims.app !== app) return { claims: null, reason: 'wrong_app' };
    if (claims.act !== policyKey) return { claims: null, reason: 'wrong_action' };
    if (claims.tgt !== target) return { claims: null, reason: 'wrong_target' };
    if (claims.dig !== digest) return { claims: null, reason: 'wrong_digest' };
    if (!Number.isSafeInteger(claims.iat) || claims.exp - claims.iat > ACTION_SECONDS) return { claims: null, reason: 'malformed' };
    if (typeof claims.jti !== 'string' || !claims.jti) return { claims: null, reason: 'malformed' };
    return { claims, consume: { jti: claims.jti, app, expiresAt: claims.exp } };
  }

  // Whether a check meets a policy's window: 'recent' (5 minutes) or a session policy's own.
  function meets(check, policyKey) {
    if (!check?.claims) return false;
    const policy = policyFor(policyKey);
    const window = policy.level === 'recent' ? POLICY.recent_seconds : policy.window_seconds;
    if (!(check.age <= window)) return false;
    return policy.kind !== 'hardware' || check.claims.kind === 'hardware';
  }

  return { actionToken, checkFinish, checkOptions, clearCookieHeader, currentCheck, enrollFinish, enrollOptions, issueActionToken, issueCookie, keys, meets, verified };
}

function defaultLabel(kind) {
  return kind === 'hardware' ? 'Hardware key' : kind === 'synced' ? 'Passkey' : 'Device passkey';
}

module.exports = { cleanLabel, createPasskeys };
