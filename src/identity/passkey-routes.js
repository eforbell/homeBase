// Feature-10 SID-005: the passkey service's routes, under /_sovereign/auth/ on Home Base's own hostname only
// (D21). On any other hostname, the shared one included, they don't exist: a 404 before anything else, so no
// ceremony starts there. Who may start which ceremony:
//
//   enroll    setup and recovery: the administrator, with the passphrase session their tailnet identity
//             opened. Active: a member adding to their own passkeys after a check in the last 5 minutes
//             (manage-own-credential), or a member with none, with the enrollment grant the administrator
//             gave them. An administrator's credentials change only in recovery until every-time
//             hardware checks arrive (manage-admin-credential).
//   check     any member with a passkey: sets the assurance cookie for this hostname. For the
//             administrator in active Home Base this is the admin session (open-admin, 8 hours).
//   activate  setup or recovery, the administrator with their passphrase session, using an attested
//             hardware key: Home Base becomes active (D16) and the ceremony is also their first check.
//
// Every POST passes the mutation guard first (src/request-guard.js, before routing).
const { policyFor } = require('sovereign-auth');
const { DirectoryError } = require('./directory');

const PREFIX = '/_sovereign/auth/';
const ADMIN_WINDOW_SECONDS = policyFor('open-admin').window_seconds;

function createPasskeyRoutes({ directory, passkeys, binding, stateStore, sendJson, parseBody, recordAdminAudit, adminStatus }) {
  const audit = (action, target, outcome, reason) => recordAdminAudit(stateStore, { action, target, outcome, reason });

  function refusal(res, statusCode, code, error, action, target) {
    if (action) audit(action, target || 'passkeys', 'refused', code);
    sendJson(res, statusCode, { error, code });
    return true;
  }

  // The passphrase session in setup and recovery, opened by this caller's tailnet identity.
  async function holdsPassphraseSession(req, standing) {
    const status = await adminStatus(req);
    return status.unlocked === true && status.userId === standing.member.userId;
  }

  // What this caller may enroll with now: { ok, via } or { ok: false, statusCode, code, error }.
  async function enrollAuthority(req, standing, check, grant) {
    if (standing.state !== 'active') {
      if (!standing.member.administrator) return { ok: false, statusCode: 409, code: 'BOOTSTRAP_STATE', error: `Only the administrator enrolls while Home Base is in ${standing.state}.` };
      if (!(await holdsPassphraseSession(req, standing))) return { ok: false, statusCode: 401, code: 'ADMIN_UNLOCK_REQUIRED', error: 'Unlock Home Base with the passphrase first.' };
      return { ok: true, via: 'passphrase' };
    }
    if (standing.member.administrator) {
      return { ok: false, statusCode: 409, code: 'ADMINISTRATOR_CREDENTIAL', error: 'Administrator passkeys change in recovery for now; every-time hardware checks for them come next.' };
    }
    if (!standing.credentials.some((credential) => credential.usable)) {
      if (typeof grant !== 'string' || !grant.trim()) return { ok: false, statusCode: 403, code: 'GRANT_REQUIRED', error: 'Enter the enrollment code the administrator gave you.' };
      return { ok: true, via: 'grant' };
    }
    if (!passkeys.meets(check, 'manage-own-credential')) return { ok: false, statusCode: 401, code: 'RECENT_CHECK_REQUIRED', error: 'Check with one of your passkeys first (within the last 5 minutes).' };
    return { ok: true, via: 'recent-check' };
  }

  function describe(standing, check, canActivate) {
    const label = (id) => standing.credentials.find((credential) => credential.credentialId === id)?.label || null;
    return {
      state: standing.state,
      member: { login: standing.member.login, name: standing.member.name, role: standing.member.role, administrator: standing.member.administrator },
      credentials: standing.credentials.map(({ credentialId, label: name, kind, createdAt, lastUsedAt, usable }) => ({ credentialId, label: name, kind, createdAt, lastUsedAt, usable })),
      check: check.claims ? { credentialId: check.claims.cred, label: label(check.claims.cred), kind: check.claims.kind, checkedAt: new Date(check.claims.auth_time * 1000).toISOString(), ageSeconds: check.age } : null,
      administratorRuleMet: standing.meetsAdministratorRule,
      canActivate,
    };
  }

  // here: { hostname, rpID } when the request came in on Home Base's own hostname, else null.
  async function handle({ req, res, method, pathname, here }) {
    if (!pathname.startsWith(PREFIX)) return false;
    if (!here) {
      sendJson(res, 404, { error: 'Not found.' });
      return true;
    }
    const route = `${method} ${pathname.slice(PREFIX.length)}`;
    const caller = await binding.caller(req);
    const standing = caller ? directory.standing(caller.userId) : null;
    if (!standing || standing.member.status !== 'active') {
      sendJson(res, 403, { error: 'Only members of this household use passkeys here.', code: 'NOT_A_MEMBER' });
      return true;
    }
    const target = standing.member.memberId;
    const check = passkeys.currentCheck(req.headers, { site: here, standing });
    const activation = async () => standing.state !== 'active' && standing.member.administrator && standing.meetsAdministratorRule && (await holdsPassphraseSession(req, standing));

    try {
      if (route === 'GET status') {
        sendJson(res, 200, describe(standing, check, await activation()));
        return true;
      }
      if (method !== 'POST') {
        sendJson(res, 404, { error: 'Not found.' });
        return true;
      }
      const body = await parseBody(req);

      if (route === 'POST enroll/options' || route === 'POST enroll/finish') {
        const authority = await enrollAuthority(req, standing, check, body.grant);
        if (!authority.ok) return refusal(res, authority.statusCode, authority.code, authority.error, 'passkey-enroll', target);
        if (route === 'POST enroll/options') {
          sendJson(res, 200, { options: await passkeys.enrollOptions({ site: here, standing, label: body.label, hardware: body.hardware === true }) });
          return true;
        }
        const result = await passkeys.enrollFinish({ site: here, standing, label: body.label, hardware: body.hardware === true, response: body.response });
        if (!result.ok) return refusal(res, 400, 'CEREMONY_REFUSED', `The passkey was not accepted (${result.reason}).`, 'passkey-enroll', target);
        if (authority.via === 'grant' && !directory.consumeGrant(standing.member.memberId, String(body.grant).trim())) {
          return refusal(res, 403, 'INVALID_GRANT', 'That enrollment code is not valid; ask the administrator for a new one.', 'passkey-enroll', target);
        }
        const stored = directory.addCredential(result.credential);
        audit('passkey-enroll', target, `enrolled ${stored.kind}`);
        sendJson(res, 201, { ok: true, credentialId: stored.credential_id, kind: stored.kind, label: stored.label, askedForHardware: body.hardware === true });
        return true;
      }

      if (route === 'POST check/options' || route === 'POST check/finish') {
        const purpose = body.purpose === 'activate' ? 'activate' : 'step-up';
        const kind = purpose === 'activate' || body.kind === 'hardware' ? 'hardware' : 'any';
        if (purpose === 'activate' && !(await activation())) {
          return refusal(res, 409, 'CANNOT_ACTIVATE', 'Activation needs Home Base in setup or recovery, the administrator\'s passphrase session, and two passkeys including an attested hardware key.', 'passkey-activate', target);
        }
        const usable = standing.credentials.filter((credential) => credential.usable && (kind === 'any' || credential.kind === 'hardware'));
        if (!usable.length) return refusal(res, 409, 'NO_CREDENTIAL', kind === 'hardware' ? 'You have no attested hardware key enrolled.' : 'You have no passkey enrolled yet.');
        if (route === 'POST check/options') {
          sendJson(res, 200, { options: await passkeys.checkOptions({ site: here, standing, purpose, kind }) });
          return true;
        }
        const result = await passkeys.checkFinish({ site: here, standing, purpose, kind, response: body.response });
        if (!result.ok) return refusal(res, 400, 'CEREMONY_REFUSED', `The check was not accepted (${result.reason}).`, `passkey-${purpose}`, target);
        if (purpose === 'activate') directory.activate({ userId: standing.member.userId, credentialId: result.credentialId });
        // Read again: activation and the assertion just moved the generation (and maybe the kind).
        const now = directory.standing(standing.member.userId);
        res.setHeader('Set-Cookie', passkeys.issueCookie({ site: here, standing: now, credentialId: result.credentialId, kind: result.kind, windowSeconds: ADMIN_WINDOW_SECONDS }));
        audit(`passkey-${purpose}`, target, purpose === 'activate' ? 'active' : `checked ${result.kind}`);
        sendJson(res, 200, { ok: true, kind: result.kind, state: now.state });
        return true;
      }

      if (route === 'POST credentials/revoke') {
        if (!passkeys.meets(check, 'manage-own-credential')) return refusal(res, 401, 'RECENT_CHECK_REQUIRED', 'Check with one of your passkeys first (within the last 5 minutes).', 'passkey-revoke', target);
        directory.revokeOwnCredential(standing.member.userId, String(body.credentialId || ''));
        // Revoking bumped the member's epoch, so this cookie is spent as well.
        res.setHeader('Set-Cookie', passkeys.clearCookieHeader());
        sendJson(res, 200, { ok: true });
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
