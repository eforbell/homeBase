const crypto = require('crypto');

const COOKIE_NAME = 'hb_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.split(';').find((part) => part.trim().startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=').trim()) : null;
}

function hashPassphrase(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassphrase(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function makeSessionToken() {
  return `${crypto.randomUUID()}-${crypto.randomBytes(16).toString('hex')}`;
}

async function getAdminStatus(req, stateStore) {
  const credential = stateStore.getAdminCredential();
  const configured = Boolean(credential && credential.passphraseHash);
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  if (!configured || !token) {
    return { configured, unlocked: false, sessionExpiresAt: null };
  }
  const nowIso = new Date().toISOString();
  stateStore.pruneAdminSessions(nowIso);
  const session = stateStore.getAdminSession(hashToken(token));
  if (!session || session.expiresAt <= nowIso) {
    if (session) stateStore.deleteAdminSession(hashToken(token));
    return { configured, unlocked: false, sessionExpiresAt: null };
  }
  return { configured, unlocked: true, sessionExpiresAt: session.expiresAt };
}

function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

async function setupAdmin(req, res, body, stateStore) {
  const existing = stateStore.getAdminCredential();
  if (existing && existing.passphraseHash) {
    return { statusCode: 409, payload: { error: 'Admin credential is already configured.' } };
  }
  const passphrase = String(body.passphrase || '');
  if (passphrase.length < 8) {
    return { statusCode: 400, payload: { error: 'Admin passphrase must be at least 8 characters.' } };
  }
  const nowIso = new Date().toISOString();
  stateStore.setAdminCredential({
    passphraseHash: hashPassphrase(passphrase),
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const token = makeSessionToken();
  stateStore.createAdminSession({ tokenHash: hashToken(token), createdAt: nowIso, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
  setSessionCookie(res, token);
  return { statusCode: 200, payload: { ok: true } };
}

async function unlockAdmin(req, res, body, stateStore) {
  const credential = stateStore.getAdminCredential();
  if (!credential || !credential.passphraseHash) {
    return { statusCode: 409, payload: { error: 'Admin credential is not configured yet. Use setup first.' } };
  }
  const passphrase = String(body.passphrase || '');
  if (!verifyPassphrase(passphrase, credential.passphraseHash)) {
    return { statusCode: 403, payload: { error: 'Invalid admin passphrase.' } };
  }
  const token = makeSessionToken();
  const nowIso = new Date().toISOString();
  stateStore.createAdminSession({ tokenHash: hashToken(token), createdAt: nowIso, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
  setSessionCookie(res, token);
  return { statusCode: 200, payload: { ok: true } };
}

async function lockAdmin(req, res, stateStore) {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  if (token) {
    stateStore.deleteAdminSession(hashToken(token));
  }
  clearSessionCookie(res);
  return { statusCode: 200, payload: { ok: true } };
}

async function rotateAdmin(req, res, body, stateStore) {
  const status = await getAdminStatus(req, stateStore);
  if (!status.configured) {
    return { statusCode: 409, payload: { error: 'Admin credential is not configured yet. Use setup first.' } };
  }
  if (!status.unlocked) {
    return { statusCode: 401, payload: { error: 'Admin unlock is required before credential rotation.' } };
  }

  const credential = stateStore.getAdminCredential();
  const currentPassphrase = String(body.currentPassphrase || '');
  const newPassphrase = String(body.newPassphrase || '');
  if (!verifyPassphrase(currentPassphrase, credential.passphraseHash)) {
    return { statusCode: 403, payload: { error: 'Current admin passphrase is invalid.' } };
  }
  if (newPassphrase.length < 8) {
    return { statusCode: 400, payload: { error: 'New admin passphrase must be at least 8 characters.' } };
  }

  const nowIso = new Date().toISOString();
  stateStore.setAdminCredential({
    passphraseHash: hashPassphrase(newPassphrase),
    createdAt: credential.createdAt || nowIso,
    updatedAt: nowIso,
  });
  stateStore.deleteAllAdminSessions();
  const token = makeSessionToken();
  stateStore.createAdminSession({
    tokenHash: hashToken(token),
    createdAt: nowIso,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  setSessionCookie(res, token);
  return { statusCode: 200, payload: { ok: true } };
}

const EXECUTION_MODE_UPGRADE_HINT = 'HOME_BASE_ENABLE_PRIVILEGED_JOBS is set but HOME_BASE_EXECUTION_MODE is not in this process\'s environment. Home Base reads only the environment systemd provides (it does not read a .env file): add HOME_BASE_EXECUTION_MODE=legacy-sudo to the file named by EnvironmentFile= in `systemctl cat homebase`, then restart the service.';

async function requireAdminForExecute(req, stateStore, { privilegedJobsEnabled = true, executionModeMissing = false } = {}) {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  const sessionTokenHash = token ? hashToken(token) : null;
  const status = await getAdminStatus(req, stateStore);
  if (!status.configured) {
    return { ok: false, statusCode: 409, payload: { error: 'Admin setup is required before real execution.' }, sessionTokenHash };
  }
  if (!status.unlocked) {
    return { ok: false, statusCode: 401, payload: { error: 'Admin unlock is required before real execution.' }, sessionTokenHash };
  }
  if (!privilegedJobsEnabled) {
    return {
      ok: false,
      statusCode: 409,
      payload: {
        error: executionModeMissing
          ? `Home Base is running in plan-only mode. ${EXECUTION_MODE_UPGRADE_HINT}`
          : 'Home Base is running in plan-only mode. Generate and review the plan, then execute it from an operator shell.',
        code: 'PRIVILEGED_EXECUTION_DISABLED',
        executionMode: 'plan-only',
      },
      sessionTokenHash,
    };
  }
  return { ok: true, sessionTokenHash };
}

module.exports = {
  EXECUTION_MODE_UPGRADE_HINT,
  getAdminStatus,
  setupAdmin,
  unlockAdmin,
  lockAdmin,
  rotateAdmin,
  requireAdminForExecute,
};
