// Feature-10 SID-005: the passkey service's routes, under /_sovereign/auth/ on Home Base's own hostname and,
// for checks only, on each sensitive app's (D21). On any other hostname, the shared one included, they don't
// exist: a 404 before anything else, so no ceremony starts there. A sensitive app's hostname serves
// stepup.js, the check that sets that hostname's assurance cookie, and sign-out; enrollment, revocation,
// status, activation and action tokens are Home Base's hostname's alone. Who may start which ceremony:
//
//   enroll    setup and recovery: the administrator, with the passphrase session their tailnet identity
//             opened. Active: a member adding to their own passkeys after a check in the last 5 minutes
//             (manage-own-credential), or a member with none, with the enrollment grant the administrator
//             gave them; the administrator with an every-time hardware token (manage-admin-credential).
//   check     any member with a passkey: sets the assurance cookie for this hostname. For the
//             administrator in active Home Base this is the admin session (open-admin, 8 hours). On a
//             sensitive app's hostname, active Home Base only: the app's session (wire contract, section 8).
//   activate  setup or recovery, the administrator with their passphrase session, using an attested
//             hardware key: Home Base becomes active (D16) and the ceremony is also their first check.
//   action    active: a fresh ceremony for one every-time action (wire contract, section 9), which answers
//             with an action token bound to the app, the policy key, the target and the request digest.
//
// Rotating the signing key (signing-key/rotate) is the administrator's, in active Home Base, with an
// every-time hardware token (privileged-plan: rotating secrets).
//
// A request that needs a check it doesn't have gets the wire contract's 401 step_up_required, which
// stepup.js (served here) turns into a prompt and one retry of the identical request.
//
// Every POST passes the mutation guard first (src/request-guard.js, before routing).
const fs = require('fs');
const path = require('path');
const { POLICY, requestDigest, policyFor } = require('sovereign-auth');
const { DirectoryError } = require('./directory');

const PREFIX = '/_sovereign/auth/';
// Ceremony refusals (wire contract, section 11) in words a member can act on; the reason code stays in the
// audit and in the answer.
const REASONS = {
  untrusted_attestation: 'it proved its maker with a certificate Home Base does not trust (only pinned vendors such as Yubico count as hardware keys)',
  unsupported_attestation: 'it answered with an attestation format Home Base does not accept; register it without "hardware key" ticked',
  unknown_challenge: 'that prompt was already used or has expired; start again',
  expired: 'the prompt expired; start again',
  unknown_credential: 'that passkey is not one Home Base offered for this',
  insufficient_kind: 'this needs an attested hardware key, and that passkey is not one',
  cross_origin: 'it was answered from inside another page',
  not_verified: 'the passkey\'s answer did not verify',
};
const ceremonyError = (what, reason) => `${what} was not accepted: ${REASONS[reason] || reason} (${reason}).`;
const ADMIN_WINDOW_SECONDS = policyFor('open-admin').window_seconds;
// A sensitive app's cookie lives as long as the longest app session; each app checks its own window from
// auth_time (open-documents, 30 days; open-operator, 24 hours).
const APP_WINDOW_SECONDS = Math.max(...Object.values(POLICY.policies).filter((policy) => policy.level === 'session' && !policy.administrator).map((policy) => policy.window_seconds));
// What a sensitive app's hostname serves; anything else there is absent.
const APP_ROUTES = new Set(['GET stepup.js', 'POST check/options', 'POST check/finish', 'POST sign-out']);
// Home Base's own every-time actions name it as their app.
const HOME_BASE_APP = 'homebase';
const STEPUP_SCRIPT = fs.readFileSync(path.join(__dirname, 'browser', 'stepup.js'));
const TARGET_MAX = 512;
// Why a confirmation could not be used (directory.consumeAction's answers).
const USED = {
  replayed: ['REPLAYED', 'That confirmation was already used; confirm again.'],
  expired: ['EXPIRED', 'That confirmation expired; confirm again.'],
  stale: ['STALE', 'Home Base changed while this was in progress; start again.'],
};

// An action ceremony's request ({ policy, target, digest }) as the challenge will bind it, or { error }.
function actionRequest(action, standing) {
  if (!action || typeof action !== 'object') return { error: 'Say which action this check is for.' };
  const { policy: key, target, digest } = action;
  let policy;
  try {
    policy = policyFor(String(key));
  } catch {
    return { error: 'No such action.' };
  }
  if (policy.level !== 'every-time') return { error: 'That action does not take a one-time confirmation.' };
  if (typeof target !== 'string' || target.length > TARGET_MAX || /[\r\n]/.test(target)) return { error: 'The action\'s target is not valid.' };
  if (typeof digest !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(digest)) return { error: 'The action\'s digest is not valid.' };
  if (policy.administrator && !standing.member.administrator) return { forbidden: true };
  return { key: String(key), policy, target, digest };
}

// passphraseSession(req): admin-auth's passphraseSession, bound to this Home Base.
// signingKey: the keyring (signing-key.js createKeyring), for rotation and the administrator's status.
function createPasskeyRoutes({ directory, passkeys, signingKey, binding, stateStore, sendJson, parseBody, recordAdminAudit, passphraseSession: sessionOf }) {
  const audit = (action, target, outcome, reason) => recordAdminAudit(stateStore, { action, target, outcome, reason });

  function refusal(res, statusCode, code, error, action, target) {
    if (action) audit(action, target || 'passkeys', 'refused', code);
    sendJson(res, statusCode, { error, code });
    return true;
  }

  // The wire contract's step-up answer (section 8), with Home Base's code and words beside it. every
  // ({ target, digest }) is for an every-time policy.
  function stepUp(res, policyKey, code, message, every = null) {
    const policy = policyFor(policyKey);
    sendJson(res, 401, { error: 'step_up_required', policy: policyKey, level: policy.level, kind: policy.kind, ...(every || {}), code, message });
    return true;
  }

  // The every-time hardware token for one administrator action on Home Base, bound to this request and
  // target: { consume } to use up with the change, or { every } to ask for one.
  function adminAction(req, here, standing, target, policyKey = 'manage-admin-credential') {
    const digest = requestDigest({ method: req.method, url: req.url, body: req.rawBody || Buffer.alloc(0), target });
    const token = passkeys.actionToken(req.headers, { site: here, standing, app: HOME_BASE_APP, policyKey, target, digest });
    return token.claims ? { consume: token.consume } : { every: { target, digest }, reason: token.reason };
  }

  // The passphrase session in setup and recovery, opened by this caller's tailnet identity: the passphrase
  // hash it was checked against, which the commit must still find stored (a rotation or root reset in
  // between refuses it), or null. Only a passphrase session counts here, never the passkey check that
  // opens active Home Base.
  async function passphraseSession(req, standing) {
    const session = await sessionOf(req);
    return session && session.userId === standing.member.userId ? session.passphraseHash : null;
  }

  // What the authorization saw, which every commit it leads to requires unchanged.
  const expectOf = (standing) => ({ state: standing.state, globalEpoch: standing.globalEpoch, epoch: standing.member.epoch });
  const moved = (before, after) => !after || after.state !== before.state || after.globalEpoch !== before.globalEpoch || after.member.epoch !== before.epoch;

  // What this caller may enroll with now: { ok, via, passphraseHash, consume } or { ok: false, statusCode,
  // code, error } or { ok: false, stepUp: [policy, code, message, every] }. finishing: the enroll/finish
  // call, whose authority is the challenge enroll/options issued (see enrollContext).
  async function enrollAuthority(req, here, standing, check, grant, finishing) {
    if (standing.state !== 'active') {
      if (!standing.member.administrator) return { ok: false, statusCode: 409, code: 'BOOTSTRAP_STATE', error: `Only the administrator enrolls while Home Base is in ${standing.state}.` };
      const passphraseHash = await passphraseSession(req, standing);
      if (!passphraseHash) return { ok: false, statusCode: 401, code: 'ADMIN_UNLOCK_REQUIRED', error: 'Unlock Home Base with the passphrase first.' };
      return { ok: true, via: 'passphrase', passphraseHash };
    }
    if (standing.member.administrator) {
      // The token is used up when the ceremony starts; the finish is held to the challenge it bought.
      if (finishing) return { ok: true, via: 'every-time' };
      const action = adminAction(req, here, standing, `enroll:${standing.member.memberId}`);
      if (!action.consume) return { ok: false, stepUp: ['manage-admin-credential', 'HARDWARE_CHECK_REQUIRED', 'Confirm with your hardware key to add an administrator passkey.', action.every] };
      return { ok: true, via: 'every-time', consume: action.consume };
    }
    if (!standing.credentials.some((credential) => credential.usable)) {
      if (typeof grant !== 'string' || !grant.trim()) return { ok: false, statusCode: 403, code: 'GRANT_REQUIRED', error: 'Enter the enrollment code the administrator gave you.' };
      return { ok: true, via: 'grant' };
    }
    if (!passkeys.meets(check, 'manage-own-credential')) return { ok: false, stepUp: ['manage-own-credential', 'RECENT_CHECK_REQUIRED', 'Check with one of your passkeys first (within the last 5 minutes).'] };
    return { ok: true, via: 'recent-check' };
  }

  // What an enrollment challenge is bound to besides the label: for the administrator in active Home Base,
  // the every-time authority and the epochs it saw, so the finish needs a challenge their token bought.
  const enrollContext = (standing, via) => (via === 'every-time' ? { authority: 'every-time', epoch: standing.member.epoch, globalEpoch: standing.globalEpoch } : {});

  function describe(standing, check, canActivate) {
    const label = (id) => standing.credentials.find((credential) => credential.credentialId === id)?.label || null;
    return {
      state: standing.state,
      member: { login: standing.member.login, name: standing.member.name, role: standing.member.role, administrator: standing.member.administrator },
      credentials: standing.credentials.map(({ credentialId, label: name, kind, createdAt, lastUsedAt, usable }) => ({ credentialId, label: name, kind, createdAt, lastUsedAt, usable })),
      check: check.claims ? { credentialId: check.claims.cred, label: label(check.claims.cred), kind: check.claims.kind, checkedAt: new Date(check.claims.auth_time * 1000).toISOString(), ageSeconds: check.age } : null,
      administratorRuleMet: standing.meetsAdministratorRule,
      canActivate,
      ...(standing.member.administrator && signingKey ? { signingKey: signingKey.describe() } : {}),
    };
  }

  // here: { hostname, rpID, homeBase } when the request came in on Home Base's own hostname (homeBase) or a
  // sensitive app's, else null.
  async function handle({ req, res, method, pathname, here }) {
    if (!pathname.startsWith(PREFIX)) return false;
    const route = `${method} ${pathname.slice(PREFIX.length)}`;
    if (!here || (!here.homeBase && !APP_ROUTES.has(route))) {
      sendJson(res, 404, { error: 'Not found.' });
      return true;
    }
    if (route === 'GET stepup.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(STEPUP_SCRIPT);
      return true;
    }
    if (method !== 'GET' && method !== 'POST') {
      sendJson(res, 404, { error: 'Not found.' });
      return true;
    }
    // The body first: everything the decision rests on is read after it, not while a client holds it back.
    const body = method === 'POST' ? await parseBody(req) : null;
    const caller = await binding.caller(req);
    const standing = caller ? directory.standing(caller.userId) : null;
    if (!standing || standing.member.status !== 'active') {
      sendJson(res, 403, { error: 'Only members of this household use passkeys here.', code: 'NOT_A_MEMBER' });
      return true;
    }
    const target = standing.member.memberId;
    const check = passkeys.currentCheck(req.headers, { site: here, standing });
    // Activation's authority: setup or recovery, the administrator's rule met, and their passphrase session.
    const activation = async () => (standing.state !== 'active' && standing.member.administrator && standing.meetsAdministratorRule ? passphraseSession(req, standing) : null);

    try {
      if (route === 'GET status') {
        sendJson(res, 200, describe(standing, check, Boolean(await activation())));
        return true;
      }

      if (route === 'POST enroll/options' || route === 'POST enroll/finish') {
        const finishing = route === 'POST enroll/finish';
        const authority = await enrollAuthority(req, here, standing, check, body.grant, finishing);
        if (authority.stepUp) return stepUp(res, ...authority.stepUp);
        if (!authority.ok) return refusal(res, authority.statusCode, authority.code, authority.error, 'passkey-enroll', target);
        const context = enrollContext(standing, authority.via);
        if (!finishing) {
          if (authority.consume) {
            const used = directory.consumeAction(authority.consume, { userId: standing.member.userId, ...expectOf(standing) });
            if (used !== 'redeemed') return refusal(res, 409, USED[used][0], USED[used][1], 'passkey-enroll', target);
            audit('passkey-enroll', target, 'hardware confirmed');
          }
          sendJson(res, 200, { options: await passkeys.enrollOptions({ site: here, standing, label: body.label, hardware: body.hardware === true, context }) });
          return true;
        }
        const result = await passkeys.enrollFinish({ site: here, standing, label: body.label, hardware: body.hardware === true, context, response: body.response });
        if (!result.ok) return refusal(res, 400, 'CEREMONY_REFUSED', ceremonyError('The passkey', result.reason), 'passkey-enroll', target);
        if (authority.via === 'grant' && !directory.consumeGrant(standing.member.memberId, String(body.grant).trim())) {
          return refusal(res, 403, 'INVALID_GRANT', 'That enrollment code is not valid; ask the administrator for a new one.', 'passkey-enroll', target);
        }
        const stored = directory.addCredential({ ...result.credential, expect: expectOf(standing), expectPassphraseHash: authority.passphraseHash || null });
        audit('passkey-enroll', target, `enrolled ${stored.kind}`);
        sendJson(res, 201, { ok: true, credentialId: stored.credential_id, kind: stored.kind, label: stored.label, askedForHardware: body.hardware === true });
        return true;
      }

      if (route === 'POST check/options' || route === 'POST check/finish') {
        const purpose = ['activate', 'action'].includes(body.purpose) ? body.purpose : 'step-up';
        if (!here.homeBase) {
          // An app's hostname: a check for that app's session, and only in active Home Base.
          if (purpose !== 'step-up') return refusal(res, 400, 'INVALID', 'Only checks run on this hostname; Home Base does the rest on its own.');
          if (standing.state !== 'active') return refusal(res, 409, 'BOOTSTRAP_STATE', `Home Base is in ${standing.state}: apps open again once it is active.`, 'passkey-step-up', target);
        }
        let action = null;
        if (purpose === 'action') {
          action = actionRequest(body.action, standing);
          if (action.forbidden) return refusal(res, 403, 'NOT_AUTHORIZED', 'Only the administrator confirms that.', 'passkey-action', target);
          if (action.error) return refusal(res, 400, 'INVALID', action.error);
          if (standing.state !== 'active') return refusal(res, 409, 'BOOTSTRAP_STATE', `Home Base is in ${standing.state}: one-time confirmations are for active Home Base.`, 'passkey-action', target);
        }
        const kind = purpose === 'activate' || body.kind === 'hardware' || action?.policy.kind === 'hardware' ? 'hardware' : 'any';
        const bound = action ? { audience: HOME_BASE_APP, action: { act: action.key, tgt: action.target, dig: action.digest } } : {};
        const activationHash = purpose === 'activate' ? await activation() : null;
        if (purpose === 'activate' && !activationHash) {
          return refusal(res, 409, 'CANNOT_ACTIVATE', 'Activation needs Home Base in setup or recovery, the administrator\'s passphrase session, and two passkeys including an attested hardware key.', 'passkey-activate', target);
        }
        // Setup and recovery are the administrator's alone (D16): nobody else checks in, or changes anything.
        if (standing.state !== 'active' && !standing.member.administrator) {
          return refusal(res, 409, 'BOOTSTRAP_STATE', `Home Base is in ${standing.state}: only the administrator uses passkeys here until it is finished.`, `passkey-${purpose}`, target);
        }
        const usable = standing.credentials.filter((credential) => credential.usable && (kind === 'any' || credential.kind === 'hardware'));
        if (!usable.length) return refusal(res, 409, 'NO_CREDENTIAL', `${kind === 'hardware' ? 'You have no attested hardware key enrolled.' : 'You have no passkey enrolled yet.'}${here.homeBase ? '' : ' Register one on Home Base\'s Admin page.'}`);
        if (route === 'POST check/options') {
          sendJson(res, 200, { options: await passkeys.checkOptions({ site: here, standing, purpose, kind, ...bound }) });
          return true;
        }
        const result = await passkeys.checkFinish({ site: here, standing, purpose, kind, ...bound, response: body.response });
        if (!result.ok) return refusal(res, 400, 'CEREMONY_REFUSED', ceremonyError('The check', result.reason), `passkey-${purpose}`, target);
        if (purpose === 'activate') {
          directory.activate({ userId: standing.member.userId, credentialId: result.credentialId, expect: expectOf(standing), expectPassphraseHash: activationHash });
        }
        // Read again: activation and the assertion just moved the generation. A recovery, reset or
        // revocation since the authorization means no cookie: it would carry epochs this check never saw.
        const now = directory.standing(standing.member.userId);
        const expected = purpose === 'activate' ? { ...expectOf(standing), state: 'active' } : expectOf(standing);
        if (moved(expected, now)) return refusal(res, 409, 'STALE', 'Home Base changed while this was in progress; start again.', `passkey-${purpose}`, target);
        if (action) {
          const token = passkeys.issueActionToken({ site: here, standing: now, app: HOME_BASE_APP, act: action.key, tgt: action.target, dig: action.digest, credentialId: result.credentialId, kind: result.kind });
          audit('passkey-action', target, `confirmed ${action.key}`);
          sendJson(res, 200, { ok: true, token });
          return true;
        }
        res.setHeader('Set-Cookie', passkeys.issueCookie({ site: here, standing: now, credentialId: result.credentialId, kind: result.kind, windowSeconds: here.homeBase ? ADMIN_WINDOW_SECONDS : APP_WINDOW_SECONDS }));
        audit(`passkey-${purpose}`, target, purpose === 'activate' ? 'active' : `checked ${result.kind}${here.homeBase ? '' : ` on ${here.hostname}`}`);
        sendJson(res, 200, { ok: true, kind: result.kind, state: now.state });
        return true;
      }

      if (route === 'POST credentials/revoke') {
        const credentialId = String(body.credentialId || '');
        if (standing.member.administrator && standing.state === 'active') {
          // Their own passkeys; a member's are the directory's business.
          if (!standing.credentials.some((credential) => credential.credentialId === credentialId)) return refusal(res, 404, 'NOT_FOUND', 'No such passkey of yours.');
          const action = adminAction(req, here, standing, `revoke:${credentialId}`);
          if (!action.consume) return stepUp(res, 'manage-admin-credential', 'HARDWARE_CHECK_REQUIRED', 'Confirm with your hardware key to remove an administrator passkey.', action.every);
          directory.revokeCredential({ userId: standing.member.userId }, credentialId, { hardwareEveryTime: true, expect: expectOf(standing), consumeAction: action.consume });
          res.setHeader('Set-Cookie', passkeys.clearCookieHeader());
          sendJson(res, 200, { ok: true });
          return true;
        }
        if (!passkeys.meets(check, 'manage-own-credential')) return stepUp(res, 'manage-own-credential', 'RECENT_CHECK_REQUIRED', 'Check with one of your passkeys first (within the last 5 minutes).');
        directory.revokeOwnCredential(standing.member.userId, credentialId, { expect: expectOf(standing) });
        // Revoking bumped the member's epoch, so this cookie is spent as well.
        res.setHeader('Set-Cookie', passkeys.clearCookieHeader());
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (route === 'POST signing-key/rotate') {
        const exposed = body.exposed === true;
        if (!standing.member.administrator) return refusal(res, 403, 'NOT_AUTHORIZED', 'Only the administrator rotates the signing key.', 'signing-key-rotate', 'homebase');
        if (standing.state !== 'active') return refusal(res, 409, 'BOOTSTRAP_STATE', `Home Base is in ${standing.state}: rotate the signing key once it is active.`, 'signing-key-rotate', 'homebase');
        const action = adminAction(req, here, standing, 'signing-key:rotate', 'privileged-plan');
        if (!action.consume) return stepUp(res, 'privileged-plan', 'HARDWARE_CHECK_REQUIRED', 'Confirm with your hardware key to rotate the signing key.', action.every);
        const used = directory.consumeAction(action.consume, { userId: standing.member.userId, ...expectOf(standing) });
        if (used !== 'redeemed') return refusal(res, 409, USED[used][0], USED[used][1], 'signing-key-rotate', 'homebase');
        const rotated = signingKey.rotate({ exposed });
        audit('signing-key-rotate', 'homebase', exposed ? `rotated to ${rotated.kid}; every earlier key dropped` : `rotated to ${rotated.kid}; ${rotated.retired.join(', ')} kept for the session window`);
        // An exposed key's cookies end now, this one included.
        if (exposed) res.setHeader('Set-Cookie', passkeys.clearCookieHeader());
        // The snapshot lists the new key now, not at the next scheduled publish. If it can't be written, the
        // key has still changed, but apps don't know yet: they keep the last snapshot until it is 120 s old,
        // then admit nobody until a publish succeeds (the scheduled ones keep trying).
        if (!directory.publish()) {
          audit('signing-key-rotate', 'homebase', 'snapshot not published');
          sendJson(res, 503, { error: `The signing key is now ${rotated.kid}, but the snapshot apps read could not be written, so they don't know yet. Home Base keeps trying; check its log.`, code: 'SNAPSHOT_NOT_PUBLISHED', kid: rotated.kid, dropped: rotated.dropped });
          return true;
        }
        sendJson(res, 200, { ok: true, kid: rotated.kid, dropped: rotated.dropped });
        return true;
      }

      if (route === 'POST sign-out') {
        res.setHeader('Set-Cookie', passkeys.clearCookieHeader());
        sendJson(res, 200, { ok: true });
        return true;
      }
    } catch (error) {
      if (!(error instanceof DirectoryError)) throw error;
      return refusal(res, error.statusCode, error.code, error.message, 'passkeys', target);
    }
    sendJson(res, 404, { error: 'Not found.' });
    return true;
  }

  return handle;
}

module.exports = { createPasskeyRoutes };
