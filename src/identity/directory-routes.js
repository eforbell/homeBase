// Feature-10 SID-004: the directory API, on when HOME_BASE_DIRECTORY is. Until the passkey service and the
// route matrix land (SID-005, SID-006), the administrator acts through a passphrase session opened by their
// own tailnet identity (src/admin-auth.js), which exists only in setup and recovery. So in this story the
// directory is edited during setup, and active Home Base refuses every edit until passkeys arrive.
const { getAdminStatus, openSession, verifyPassphrase } = require('../admin-auth');

function createDirectoryRoutes({ directory, binding, stateStore, sendJson, parseBody, recordAdminAudit }) {
  const fail = (res, error, audit) => {
    if (!error.statusCode) throw error;
    if (audit) recordAdminAudit(stateStore, { ...audit, outcome: 'refused', reason: error.code });
    sendJson(res, error.statusCode, { error: error.message, code: error.code });
  };

  async function administrator(req, res, action, target) {
    const status = await getAdminStatus(req, stateStore, { directory: binding });
    if (status.unlocked) return { userId: status.userId };
    recordAdminAudit(stateStore, { action, target, outcome: 'blocked-auth' });
    sendJson(res, 401, { error: 'Unlock Home Base as the administrator first.', code: 'ADMIN_UNLOCK_REQUIRED' });
    return null;
  }

  // Returns true when it handled the request.
  async function handle({ req, res, method, pathname }) {
    if (!pathname.startsWith('/api/directory')) return false;

    if (method === 'GET' && pathname === '/api/directory') {
      const status = await getAdminStatus(req, stateStore, { directory: binding });
      if (status.unlocked) {
        sendJson(res, 200, directory.describe());
        return true;
      }
      // Anyone else learns the state and whether they are a member, nothing about the household.
      const caller = await binding.caller(req);
      const member = caller ? directory.memberStatus(caller.userId) : null;
      sendJson(res, 200, { state: directory.state(), caller: caller && { login: caller.login, member: Boolean(member), admitted: member === 'active' } });
      return true;
    }

    // The passphrase while active, from the recorded administrator only: every session and assurance cookie
    // ends, and what is left is re-enrolling and revoking (D16).
    if (method === 'POST' && pathname === '/api/directory/recovery') {
      const body = await parseBody(req);
      const audit = { action: 'directory-recovery', target: 'homebase' };
      const credential = stateStore.getAdminCredential();
      if (!credential?.passphraseHash || !verifyPassphrase(String(body.passphrase || ''), credential.passphraseHash)) {
        recordAdminAudit(stateStore, { ...audit, outcome: 'refused', reason: 'passphrase' });
        sendJson(res, 403, { error: 'Invalid admin passphrase.' });
        return true;
      }
      const caller = await binding.caller(req);
      if (!caller) {
        recordAdminAudit(stateStore, { ...audit, outcome: 'refused', reason: 'NO_IDENTITY' });
        sendJson(res, 403, { error: 'Home Base could not tell which tailnet account is asking.', code: 'NO_IDENTITY' });
        return true;
      }
      if (directory.state() === 'setup') {
        sendJson(res, 409, { error: 'Home Base is in setup: unlock with the passphrase instead.', code: 'BOOTSTRAP_STATE' });
        return true;
      }
      try {
        const admin = directory.enterRecovery(caller);
        openSession(res, stateStore, admin.user_id);
        sendJson(res, 200, { ok: true, state: 'recovery' });
      } catch (error) {
        fail(res, error, audit);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/directory/members') {
      const body = await parseBody(req);
      const actor = await administrator(req, res, 'member-add', 'directory');
      if (!actor) return true;
      try {
        const member = directory.addMember(actor, { userId: body.userId, role: body.role, name: body.name, apps: body.apps ?? null });
        sendJson(res, 201, { ok: true, memberId: member.member_id });
      } catch (error) {
        fail(res, error, { action: 'member-add', target: 'directory' });
      }
      return true;
    }

    const memberMatch = pathname.match(/^\/api\/directory\/members\/(m_[0-9a-f]+)(\/grant)?$/);
    if (method === 'POST' && memberMatch) {
      const [, memberId, grant] = memberMatch;
      const body = await parseBody(req);
      const action = grant ? 'enrollment-grant' : 'member-update';
      const actor = await administrator(req, res, action, memberId);
      if (!actor) return true;
      try {
        if (grant) {
          sendJson(res, 201, { ok: true, ...directory.issueGrant(actor, memberId) });
        } else {
          const patch = Object.fromEntries(['name', 'role', 'status', 'apps', 'administrator'].filter((key) => key in body).map((key) => [key, body[key]]));
          directory.updateMember(actor, memberId, patch);
          sendJson(res, 200, { ok: true });
        }
      } catch (error) {
        fail(res, error, { action, target: memberId });
      }
      return true;
    }

    const revokeMatch = pathname.match(/^\/api\/directory\/credentials\/([A-Za-z0-9_-]{1,512})\/revoke$/);
    if (method === 'POST' && revokeMatch) {
      await parseBody(req);
      const actor = await administrator(req, res, 'credential-revoke', 'directory');
      if (!actor) return true;
      try {
        sendJson(res, 200, { ok: true, ...directory.revokeCredential(actor, revokeMatch[1]) });
      } catch (error) {
        fail(res, error, { action: 'credential-revoke', target: 'directory' });
      }
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  return handle;
}

module.exports = { createDirectoryRoutes };
