// Feature-10 SID-004: the household directory. Members are keyed on the tailnet's stable user ID (D1); the
// login is kept current but never identifies anyone, so a new account that inherits a login is unknown and
// administrator rights never follow it. Home Base publishes the directory as the snapshot apps read (D18):
// on every change and every 30 s, with a generation that only grows and a global epoch that recovery and
// reset bump.
//
// Bootstrap (D16):
//   setup     no administrator credentials yet. The passphrase plus the founder's tailnet identity records
//             the founder as administrator; only administrator enrollment and directory edits are allowed.
//   active    the administrator holds ≥2 credentials including an attested hardware key (D11), and a fresh
//             hardware ceremony moved Home Base here. The passphrase opens recovery only.
//   recovery  entered with the passphrase by the recorded administrator (or by root's reset, which goes to
//             setup). Only enrolling replacement administrator credentials and revoking credentials.
//
// Credentials are enrolled by the passkey service (SID-005), which calls addCredential and activate; this
// module holds the rules they must keep.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DEFAULT_SNAPSHOT_PATH, parseSnapshot } = require('sovereign-auth');
const { createDirectoryStore } = require('./directory-store');

const PUBLISH_MS = 30_000;
const GRANT_MS = 15 * 60_000;
const CANDIDATE_LIMIT = 50;
const CANDIDATE_MS = 24 * 60 * 60_000;
const ATTEMPTS = 5;
const ROLES = new Set(['parent', 'kid']);
const STATUSES = new Set(['active', 'disabled']);
const KINDS = new Set(['synced', 'device-bound', 'hardware']);

class DirectoryError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const refuse = (statusCode, code, message) => { throw new DirectoryError(statusCode, code, message); };
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const usable = (credential) => !credential.revoked_at && !credential.orphaned;

// The generation must only grow, across restarts and a lost database too, so it never starts below the
// published file's.
function publishedGeneration(file) {
  try {
    const generation = JSON.parse(fs.readFileSync(file, 'utf8')).generation;
    return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
  } catch {
    return 0;
  }
}

function fromRow(row) {
  return { ...row, administrator: Boolean(row.administrator), apps: row.apps == null ? null : JSON.parse(row.apps) };
}

function toRow(member) {
  return { ...member, administrator: member.administrator ? 1 : 0, apps: member.apps == null ? null : JSON.stringify(member.apps) };
}

// catalog: [{ id, identity?: { defaultAccess: 'administrator' } }]. Operator apps default to administrators.
function createDirectory({ dbPath, catalog, household, snapshotFile = DEFAULT_SNAPSHOT_PATH, now = Date.now, log = () => {}, store = createDirectoryStore(dbPath) }) {
  if (!household) throw new Error('the household directory needs HOME_BASE_INSTANCE');
  const file = path.resolve(snapshotFile);
  const appIds = new Set(catalog.map((app) => app.id));
  const operatorApps = new Set(catalog.filter((app) => app.identity?.defaultAccess === 'administrator').map((app) => app.id));
  const candidates = new Map();
  const observedLogins = new Map();
  let published = new Map();

  const iso = () => new Date(now()).toISOString();

  function load() {
    const data = store.load();
    if (!data.household) throw new Error('the household directory is not initialised');
    return {
      household: data.household,
      members: data.members.map(fromRow),
      credentials: data.credentials.map((row) => ({ ...row, orphaned: Boolean(row.orphaned) })),
      grants: data.grants,
    };
  }

  function appsFor(member) {
    if (member.apps) return member.apps.filter((id) => appIds.has(id));
    return [...appIds].filter((id) => member.administrator || !operatorApps.has(id));
  }

  function snapshotOf(data) {
    return {
      format: 1,
      household,
      generation: data.household.generation,
      written_at: iso(),
      global_epoch: data.household.global_epoch,
      // Signing keys arrive with the passkey service (SID-005); until then nothing can be stepped up.
      keys: [],
      members: data.members.map((member) => ({
        user_id: member.user_id,
        member_id: member.member_id,
        login: member.login,
        name: member.name,
        role: member.role,
        status: member.status,
        epoch: member.epoch,
        apps: appsFor(member),
      })),
    };
  }

  // Writes what the database holds. If it can't, nobody is admitted until it can: the last good snapshot
  // ages out after 120 s and apps fall back to "no member" (fail closed).
  function publish() {
    try {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const data = load();
        const snapshot = snapshotOf(data);
        parseSnapshot(snapshot);
        const result = store.publish({ expectGeneration: data.household.generation, file, body: `${JSON.stringify(snapshot, null, 2)}\n` });
        if (result.ok) {
          published = new Map(data.members.map((member) => [member.user_id, member]));
          return data;
        }
        if (result.newerOnDisk) throw new Error(`the published generation ${result.newerOnDisk} is newer than the database's ${data.household.generation}`);
      }
      throw new Error('the directory kept changing');
    } catch (error) {
      published = new Map();
      log(`directory: snapshot not published (${error.message})`);
      return null;
    }
  }

  function init() {
    store.init({ generation: Math.max(publishedGeneration(file), 1), now: iso() });
  }

  // build(data) returns { change, value } from what it read, or throws a DirectoryError. The change is
  // committed only if nothing else changed the directory meanwhile; otherwise it is rebuilt from a fresh read.
  // expectPassphraseHash: the change also needs the passphrase it was authorized by to be the stored one.
  function change(build, { expectPassphraseHash } = {}) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const data = load();
      const { change: delta, value } = build(data);
      if (!Object.keys(delta).length) return value;
      const result = store.commit({ expectGeneration: data.household.generation, now: iso(), ...delta, ...(expectPassphraseHash ? { expectPassphraseHash } : {}) });
      if (result.ok) {
        publish();
        return value;
      }
      if (result.passphraseChanged) refuse(409, 'PASSPHRASE_CHANGED', 'The admin passphrase changed while this request was in flight; unlock again.');
      if (result.integrity) refuse(409, 'CONFLICT', `That would give two members the same login or user ID (${result.integrity}).`);
    }
    return refuse(409, 'BUSY', 'The directory kept changing; try again.');
  }

  const administrators = (data) => data.members.filter((member) => member.administrator && member.status === 'active');
  const memberById = (data, memberId) => data.members.find((member) => member.member_id === memberId) || refuse(404, 'NOT_FOUND', 'No such member.');
  const credentialsOf = (data, memberId) => data.credentials.filter((credential) => credential.member_id === memberId && usable(credential));

  // D11: at least two usable credentials, at least one an attested hardware key.
  function meetsCredentialRule(credentials) {
    return credentials.length >= 2 && credentials.some((credential) => credential.kind === 'hardware');
  }

  function requireAdministrator(data, userId) {
    const member = administrators(data).find((entry) => entry.user_id === userId);
    return member || refuse(403, 'NOT_ADMINISTRATOR', 'Only the administrator can do that.');
  }

  function requireState(data, allowed, what) {
    if (!allowed.includes(data.household.state)) refuse(409, 'BOOTSTRAP_STATE', `${what} is not possible while Home Base is in ${data.household.state}.`);
  }

  function newMember(identity, fields = {}) {
    const at = iso();
    return {
      member_id: `m_${crypto.randomBytes(6).toString('hex')}`,
      user_id: identity.userId,
      login: identity.login,
      name: identity.name || identity.login,
      role: 'parent',
      administrator: false,
      status: 'active',
      epoch: 0,
      apps: null,
      created_at: at,
      updated_at: at,
      ...fields,
    };
  }

  // The passphrase (passphraseHash) was verified by the caller. Returns the member the session belongs to.
  function claim(caller, { passphraseHash } = {}) {
    return change((data) => {
      const { state, pending_administrator_login: pending } = data.household;
      if (state === 'active') refuse(409, 'RECOVERY_ONLY', 'Home Base is active: the passphrase opens recovery only.');
      if (state === 'recovery') return { change: {}, value: requireAdministrator(data, caller.userId) };
      const current = administrators(data);
      if (!pending && current.length) return { change: {}, value: requireAdministrator(data, caller.userId) };
      if (pending && caller.login !== pending) refuse(403, 'NOT_ADMINISTRATOR', 'Home Base was reset for a different administrator.');
      // The founder: the first tailnet identity to bring the passphrase, or the login root named at reset.
      const existing = data.members.find((member) => member.user_id === caller.userId);
      const founder = existing
        ? { ...existing, administrator: true, status: 'active', updated_at: iso() }
        : newMember(caller, { administrator: true });
      // A demoted administrator loses the operator apps they had by default, so their epoch moves too.
      const demoted = data.members.filter((member) => member.administrator && member.user_id !== caller.userId).map((member) => ({ ...member, administrator: false, epoch: member.epoch + 1, updated_at: iso() }));
      return {
        change: {
          household: { pending_administrator_login: null },
          members: [...demoted, founder].map(toRow),
          audit: [{ action: 'directory-founder', target: founder.member_id, outcome: 'recorded' }],
        },
        value: founder,
      };
    }, { expectPassphraseHash: passphraseHash });
  }

  // The passphrase (passphraseHash) was verified by the caller. Every assurance cookie and session stops working.
  function enterRecovery(caller, { passphraseHash } = {}) {
    return change((data) => {
      const admin = requireAdministrator(data, caller.userId);
      if (data.household.state === 'recovery') return { change: {}, value: admin };
      requireState(data, ['active'], 'Recovery');
      return {
        change: {
          household: { state: 'recovery', global_epoch: data.household.global_epoch + 1 },
          revokeSessions: true,
          audit: [{ action: 'directory-recovery', target: admin.member_id, outcome: 'entered' }],
        },
        value: admin,
      };
    }, { expectPassphraseHash: passphraseHash });
  }

  // Called by the passkey service after a fresh ceremony with credentialId (SID-005).
  function activate({ userId, credentialId }) {
    return change((data) => {
      requireState(data, ['setup', 'recovery'], 'Activation');
      const admin = requireAdministrator(data, userId);
      const credentials = credentialsOf(data, admin.member_id);
      const used = credentials.find((credential) => credential.credential_id === credentialId);
      if (!used || used.kind !== 'hardware') refuse(409, 'HARDWARE_CEREMONY_REQUIRED', 'Activation needs a fresh ceremony with one of the administrator\'s attested hardware keys.');
      if (!meetsCredentialRule(credentials)) refuse(409, 'CREDENTIALS_INCOMPLETE', 'The administrator needs at least two credentials, including an attested hardware key.');
      return {
        change: {
          household: { state: 'active' },
          // The passphrase sessions of setup or recovery end here; active admin needs passkeys (SID-006).
          revokeSessions: true,
          audit: [{ action: 'directory-active', target: admin.member_id, outcome: `from ${data.household.state}` }],
        },
        value: { state: 'active' },
      };
    });
  }

  // Records an enrolled credential (SID-005 verifies the ceremony). In setup and recovery only the
  // administrator enrolls.
  function addCredential({ userId, credentialId, kind, label = '' }) {
    if (!KINDS.has(kind)) refuse(400, 'INVALID', `Unknown credential kind ${kind}.`);
    return change((data) => {
      const member = data.members.find((entry) => entry.user_id === userId && entry.status === 'active') || refuse(404, 'NOT_FOUND', 'No such member.');
      if (data.household.state !== 'active' && !member.administrator) refuse(409, 'BOOTSTRAP_STATE', `Only the administrator enrolls while Home Base is in ${data.household.state}.`);
      if (data.credentials.some((credential) => credential.credential_id === credentialId)) refuse(409, 'CONFLICT', 'That credential is already enrolled.');
      const record = { credential_id: credentialId, member_id: member.member_id, kind, label: String(label), orphaned: 0, created_at: iso(), revoked_at: null };
      return {
        change: { credentials: [record], deleteGrants: [member.member_id], audit: [{ action: 'credential-enroll', target: member.member_id, outcome: kind }] },
        value: record,
      };
    });
  }

  // While active the administrator keeps D11 (transactionally: the check and the write are one commit).
  // Setup and recovery may revoke anything; that is what recovery is for.
  function revokeCredential(actor, credentialId) {
    return change((data) => {
      requireAdministrator(data, actor.userId);
      const credential = data.credentials.find((entry) => entry.credential_id === credentialId && !entry.revoked_at) || refuse(404, 'NOT_FOUND', 'No such credential.');
      const member = memberById(data, credential.member_id);
      if (data.household.state === 'active' && member.administrator) {
        const remaining = credentialsOf(data, member.member_id).filter((entry) => entry.credential_id !== credentialId);
        if (!meetsCredentialRule(remaining)) refuse(409, 'LAST_ADMINISTRATOR_CREDENTIAL', 'The administrator must keep at least two credentials, including an attested hardware key. Enroll a replacement first.');
      }
      return {
        change: {
          credentials: [{ ...credential, orphaned: credential.orphaned ? 1 : 0, revoked_at: iso() }],
          members: [toRow({ ...member, epoch: member.epoch + 1, updated_at: iso() })],
          audit: [{ action: 'credential-revoke', target: member.member_id, outcome: 'revoked' }],
        },
        value: { revoked: credentialId },
      };
    });
  }

  function validApps(apps) {
    if (apps === null) return null;
    if (!Array.isArray(apps) || !apps.every((id) => typeof id === 'string' && appIds.has(id))) refuse(400, 'INVALID', 'apps must be null (the default) or a list of catalog app IDs.');
    return [...new Set(apps)].sort();
  }

  // Members are added from identities Home Base has seen (D1): the user ID is never typed in.
  function addMember(actor, { userId, role, name, apps = null }) {
    const candidate = candidates.get(String(userId || ''));
    if (!candidate) refuse(404, 'NOT_SEEN', 'That tailnet account has not visited Home Base yet; ask them to open it, then try again.');
    if (!ROLES.has(role)) refuse(400, 'INVALID', 'role must be parent or kid.');
    const checkedApps = validApps(apps);
    return change((data) => {
      requireState(data, ['setup', 'active'], 'Adding a member');
      requireAdministrator(data, actor.userId);
      if (data.members.some((member) => member.user_id === candidate.userId)) refuse(409, 'CONFLICT', 'That account is already a member.');
      const holder = data.members.find((member) => member.login === candidate.login);
      if (holder) refuse(409, 'LOGIN_HELD', `${candidate.login} belongs to member ${holder.member_id}, a different tailnet account. Disable or update that member first.`);
      const member = newMember(candidate, { role, name: String(name || candidate.name || candidate.login), apps: checkedApps });
      return { change: { members: [toRow(member)], audit: [{ action: 'member-add', target: member.member_id, outcome: role }] }, value: member };
    });
  }

  function updateMember(actor, memberId, patch) {
    if ('administrator' in patch) refuse(409, 'NOT_AVAILABLE', 'Granting or removing administrator needs a hardware key every time (SID-006).');
    if ('role' in patch && !ROLES.has(patch.role)) refuse(400, 'INVALID', 'role must be parent or kid.');
    if ('status' in patch && !STATUSES.has(patch.status)) refuse(400, 'INVALID', 'status must be active or disabled.');
    const apps = 'apps' in patch ? validApps(patch.apps) : undefined;
    return change((data) => {
      requireState(data, ['setup', 'active'], 'Editing the directory');
      requireAdministrator(data, actor.userId);
      const member = memberById(data, memberId);
      if (member.administrator && patch.status === 'disabled') refuse(409, 'LAST_ADMINISTRATOR', 'The administrator can\'t be disabled.');
      const next = { ...member, updated_at: iso() };
      if ('name' in patch) next.name = String(patch.name || member.login);
      if ('role' in patch) next.role = patch.role;
      if ('status' in patch) next.status = patch.status;
      if (apps !== undefined) next.apps = apps;
      // Disabling a member or changing their access ends their assurance cookies (wire contract, section 7).
      const accessChanged = next.status !== member.status || JSON.stringify(appsFor(next)) !== JSON.stringify(appsFor(member));
      if (accessChanged) next.epoch = member.epoch + 1;
      return { change: { members: [toRow(next)], audit: [{ action: 'member-update', target: memberId, outcome: Object.keys(patch).sort().join(',') }] }, value: next };
    });
  }

  // A single-use code the administrator hands a member with no usable credentials, for 15 minutes.
  function issueGrant(actor, memberId) {
    return change((data) => {
      requireState(data, ['active'], 'An enrollment grant');
      const admin = requireAdministrator(data, actor.userId);
      const member = memberById(data, memberId);
      if (member.status !== 'active') refuse(409, 'DISABLED', 'That member is disabled.');
      if (credentialsOf(data, memberId).length) refuse(409, 'HAS_CREDENTIALS', 'That member has a credential; they enroll more with it.');
      const code = crypto.randomBytes(16).toString('base64url');
      const expiresAt = new Date(now() + GRANT_MS).toISOString();
      return {
        change: {
          grants: [{ member_id: memberId, code_hash: sha256(code), issued_by: admin.member_id, created_at: iso(), expires_at: expiresAt }],
          audit: [{ action: 'enrollment-grant', target: memberId, outcome: 'issued' }],
        },
        value: { code, expiresAt },
      };
    });
  }

  // Used once by the passkey service before an enrollment ceremony (SID-005). True only for the first use.
  function consumeGrant(memberId, code) {
    try {
      return change((data) => {
        const grant = data.grants.find((entry) => entry.member_id === memberId);
        const presented = Buffer.from(sha256(code), 'hex');
        const valid = grant && Date.parse(grant.expires_at) > now() && crypto.timingSafeEqual(Buffer.from(grant.code_hash, 'hex'), presented);
        if (!valid) refuse(403, 'INVALID_GRANT', 'That enrollment grant is not valid.');
        return { change: { deleteGrants: [memberId], audit: [{ action: 'enrollment-grant', target: memberId, outcome: 'used' }] }, value: true };
      });
    } catch (error) {
      if (error.code === 'INVALID_GRANT') return false;
      throw error;
    }
  }

  // Root's reset (bin/homebase.js): back to setup, with every administrator credential and session revoked.
  // With administratorLogin, the next founder must be that login, and the old administrator is demoted then.
  function reset({ passphraseHash, administratorLogin = null }) {
    return change((data) => {
      const admins = data.members.filter((member) => member.administrator);
      const revokedAt = iso();
      const revoked = data.credentials.filter((credential) => !credential.revoked_at && admins.some((admin) => admin.member_id === credential.member_id));
      return {
        change: {
          household: { state: 'setup', global_epoch: data.household.global_epoch + 1, pending_administrator_login: administratorLogin },
          credentials: revoked.map((credential) => ({ ...credential, orphaned: credential.orphaned ? 1 : 0, revoked_at: revokedAt })),
          members: admins.map((admin) => toRow({ ...admin, epoch: admin.epoch + 1, updated_at: revokedAt })),
          revokeSessions: true,
          passphraseHash,
          audit: [{ action: 'admin-reset', target: 'homebase', outcome: administratorLogin ? 'new administrator login' : 'same administrator', reason: `${revoked.length} administrator credential(s) revoked` }],
        },
        value: { revokedCredentials: revoked.length },
      };
    });
  }

  // A member's login changed at the identity provider; the stable user ID is the same person. Observed by
  // the identity lookup and recorded here, by the background tick, so no request changes the directory
  // (D20). Recovery permits only re-enrolling and revoking, so it waits until recovery ends.
  function syncLogins() {
    for (const [userId, login] of [...observedLogins]) {
      try {
        change((data) => {
          if (data.household.state === 'recovery') return { change: {}, value: null };
          observedLogins.delete(userId);
          const member = data.members.find((entry) => entry.user_id === userId);
          if (!member || member.login === login) return { change: {}, value: null };
          if (data.members.some((entry) => entry.login === login)) refuse(409, 'LOGIN_HELD', `${login} is still recorded for another member`);
          return { change: { members: [toRow({ ...member, login, updated_at: iso() })], audit: [{ action: 'member-login', target: member.member_id, outcome: 'updated' }] }, value: null };
        });
      } catch (error) {
        observedLogins.delete(userId);
        log(`directory: login of member with user ID ${userId} not updated (${error.message})`);
      }
    }
  }

  // The identity endpoint's question (D1), answered from the last published snapshot. Accounts that
  // aren't members are remembered (in memory, for a day) so the administrator can add them without typing an
  // ID, and a member's changed login is noted for syncLogins. Both come from tailscaled's answer for the
  // caller's own connection, so whichever request carries them records only the truth, and nothing persists
  // until an administrator adds the member or the background tick records the login.
  function lookup(userId, identity = {}) {
    const member = published.get(userId);
    if (member) {
      // The latest observation wins, including one back to the recorded login.
      if (identity.login && identity.login !== member.login) observedLogins.set(userId, identity.login);
      else observedLogins.delete(userId);
      return { admitted: member.status === 'active' };
    }
    if (identity.login) {
      if (candidates.size >= CANDIDATE_LIMIT && !candidates.has(userId)) candidates.delete(candidates.keys().next().value);
      candidates.delete(userId);
      candidates.set(userId, { userId, login: identity.login, name: identity.name || '', seenAt: now() });
    }
    return null;
  }

  function recentCandidates(data) {
    const members = new Set(data.members.map((member) => member.user_id));
    return [...candidates.values()].filter((entry) => now() - entry.seenAt < CANDIDATE_MS && !members.has(entry.userId)).reverse()
      .map((entry) => ({ userId: entry.userId, login: entry.login, name: entry.name, seenAt: new Date(entry.seenAt).toISOString() }));
  }

  // What the administrator sees. Credentials are described, never their keys; grants by expiry only.
  function describe() {
    const data = load();
    return {
      state: data.household.state,
      household,
      generation: data.household.generation,
      globalEpoch: data.household.global_epoch,
      pendingAdministratorLogin: data.household.pending_administrator_login || null,
      members: data.members.map((member) => ({
        memberId: member.member_id,
        userId: member.user_id,
        login: member.login,
        name: member.name,
        role: member.role,
        administrator: member.administrator,
        status: member.status,
        epoch: member.epoch,
        apps: appsFor(member),
        appsDefault: member.apps == null,
        credentials: data.credentials.filter((credential) => credential.member_id === member.member_id).map((credential) => ({
          credentialId: credential.credential_id, kind: credential.kind, label: credential.label, orphaned: credential.orphaned, createdAt: credential.created_at, revokedAt: credential.revoked_at,
        })),
        grantExpiresAt: data.grants.find((grant) => grant.member_id === member.member_id)?.expires_at || null,
      })),
      candidates: recentCandidates(data),
    };
  }

  const state = () => load().household.state;
  const memberStatus = (userId) => published.get(userId)?.status || null;
  const isAdministrator = (userId) => administrators(load()).some((member) => member.user_id === userId);

  function start() {
    publish();
    return setInterval(() => { syncLogins(); publish(); }, PUBLISH_MS).unref();
  }

  return {
    activate, addCredential, addMember, claim, consumeGrant, describe, enterRecovery, init, isAdministrator, issueGrant,
    lookup, memberStatus, publish, reset, revokeCredential, start, state, syncLogins, updateMember, snapshotFile: file,
  };
}

module.exports = { DirectoryError, createDirectory };
