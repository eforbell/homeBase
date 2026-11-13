// Feature-10 SID-004: the household directory's tables, in Home Base's state database. Every change goes
// through one operation, commit, which applies it only if the directory is still at the generation the
// change was computed from (compare and swap) and bumps the generation in the same transaction. So a rule
// checked on what was read ("the administrator keeps a hardware key") still holds when the write lands,
// whether the other writer is Home Base or the root CLI.
//
// Publishing is the same lock's business: publish renames the snapshot into place inside a transaction that
// holds SQLite's write lock and checks the generation it was built from, so no publisher can replace a newer
// snapshot with an older one. The operating system releases that lock when a process dies.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PYTHON_SCRIPT = `
import json
import base64
import os
import secrets
import sqlite3
import sys

db_path = sys.argv[1]
op = sys.argv[2]
payload = json.loads(sys.stdin.read() or "{}")

conn = sqlite3.connect(db_path, isolation_level=None, timeout=5)
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA foreign_keys = ON")

SCHEMA = """
CREATE TABLE IF NOT EXISTS identity_household (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('setup', 'active', 'recovery')),
  generation INTEGER NOT NULL,
  global_epoch INTEGER NOT NULL,
  pending_administrator_login TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_members (
  member_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('parent', 'kid')),
  administrator INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  epoch INTEGER NOT NULL DEFAULT 0,
  apps TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_credentials (
  credential_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES identity_members(member_id),
  kind TEXT NOT NULL CHECK (kind IN ('synced', 'device-bound', 'hardware')),
  label TEXT NOT NULL DEFAULT '',
  orphaned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS identity_enrollment_grants (
  member_id TEXT PRIMARY KEY REFERENCES identity_members(member_id),
  code_hash TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_action_tokens (
  jti TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at TEXT NOT NULL
);
"""

MEMBER_FIELDS = ["member_id", "user_id", "login", "name", "role", "administrator", "status", "epoch", "apps", "created_at", "updated_at", "webauthn_user_handle"]
# What the passkey service (SID-005) keeps to verify a credential's assertions: added to databases from before it.
CREDENTIAL_KEY_COLUMNS = [
    ("public_key", "TEXT"), ("counter", "INTEGER NOT NULL DEFAULT 0"), ("transports", "TEXT"), ("aaguid", "TEXT"),
    ("device_type", "TEXT"), ("backed_up", "INTEGER NOT NULL DEFAULT 1"), ("root", "TEXT"), ("last_used_at", "TEXT"),
    ("handle_format", "TEXT NOT NULL DEFAULT 'legacy-v1' CHECK (handle_format IN ('legacy-v1', 'isolated-v2'))"),
    ("webauthn_user_handle", "TEXT"),
]
CREDENTIAL_FIELDS = ["credential_id", "member_id", "kind", "label", "orphaned", "created_at", "revoked_at"] + [name for name, _ in CREDENTIAL_KEY_COLUMNS]
GRANT_FIELDS = ["member_id", "code_hash", "issued_by", "created_at", "expires_at"]

def rows(sql, args=()):
    return [dict(row) for row in conn.execute(sql, args)]

def upsert(table, key, fields, record, immutable=()):
    names = ", ".join(fields)
    marks = ", ".join("?" for _ in fields)
    updates = ", ".join(f"{name}=excluded.{name}" for name in fields if name != key and name not in immutable)
    existing = conn.execute(f"SELECT * FROM {table} WHERE {key} = ?", (record[key],)).fetchone() if immutable else None
    if existing is not None:
        if any(record.get(name) is not None and record[name] != existing[name] for name in immutable):
            raise sqlite3.IntegrityError("INVALID_MEMBER_HANDLE" if table == "identity_members" else "INVALID_CREDENTIAL_HANDLE")
        # An existing corrupt credential must still be revocable. Do not run INSERT validation triggers
        # (as SQLite UPSERT does) when only its mutable fields need changing under our write lock.
        mutable = [name for name in fields if name != key and name not in immutable]
        assignments = ", ".join(f"{name} = ?" for name in mutable)
        conn.execute(f"UPDATE {table} SET {assignments} WHERE {key} = ?", [record.get(name) for name in mutable] + [record[key]])
    else:
        conn.execute(
            f"INSERT INTO {table} ({names}) VALUES ({marks}) ON CONFLICT({key}) DO UPDATE SET {updates}",
            [record.get(name) for name in fields],
        )

def emit(value):
    sys.stdout.write(json.dumps(value))

# An action token's jti is used once (D19), across processes and restarts: taken inside the caller's
# write transaction. A token at or past its expiry is refused here, whatever its verification saw a moment
# ago, and only then are spent records of expired tokens dropped: no token they name can be taken again.
# Returns "taken", "replayed" or "expired".
def take_action(action, now_seconds, now):
    if int(action["expiresAt"]) <= now_seconds:
        return "expired"
    if conn.execute("SELECT 1 FROM identity_action_tokens WHERE jti = ?", (action["jti"],)).fetchone():
        return "replayed"
    conn.execute("DELETE FROM identity_action_tokens WHERE expires_at <= ?", (now_seconds,))
    conn.execute(
        "INSERT INTO identity_action_tokens (jti, app, expires_at, consumed_at) VALUES (?, ?, ?, ?)",
        (action["jti"], action["app"], int(action["expiresAt"]), now),
    )
    return "taken"

if op == "init":
    # executescript may commit a preceding transaction. Execute these schema statements under our lock.
    conn.execute("BEGIN IMMEDIATE")
    try:
        for statement in SCHEMA.split(";"):
            if statement.strip():
                conn.execute(statement)
        present = {row["name"] for row in conn.execute("PRAGMA table_info(identity_credentials)")}
        for name, declaration in CREDENTIAL_KEY_COLUMNS:
            if name not in present:
                conn.execute(f"ALTER TABLE identity_credentials ADD COLUMN {name} {declaration}")
        member_columns = {row["name"] for row in conn.execute("PRAGMA table_info(identity_members)")}
        if "webauthn_user_handle" not in member_columns:
            conn.execute("ALTER TABLE identity_members ADD COLUMN webauthn_user_handle TEXT")
        household_columns = {row["name"] for row in conn.execute("PRAGMA table_info(identity_household)")}
        if "webauthn_v2_issued_at" not in household_columns:
            conn.execute("ALTER TABLE identity_household ADD COLUMN webauthn_v2_issued_at TEXT")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS identity_member_handle ON identity_members(webauthn_user_handle)")
        conn.execute("""CREATE TRIGGER IF NOT EXISTS identity_member_handle_insert
            BEFORE INSERT ON identity_members WHEN NEW.webauthn_user_handle IS NOT NULL AND
              (length(NEW.webauthn_user_handle) != 43 OR NEW.webauthn_user_handle GLOB '*[^A-Za-z0-9_-]*'
               OR substr(NEW.webauthn_user_handle, -1) NOT GLOB '[AEIMQUYcgkosw048]')
            BEGIN SELECT RAISE(ABORT, 'INVALID_MEMBER_HANDLE'); END""")
        conn.execute("""CREATE TRIGGER IF NOT EXISTS identity_member_handle_allocation
            BEFORE UPDATE OF webauthn_user_handle ON identity_members WHEN OLD.webauthn_user_handle IS NULL
              AND NEW.webauthn_user_handle IS NOT NULL AND
              (length(NEW.webauthn_user_handle) != 43 OR NEW.webauthn_user_handle GLOB '*[^A-Za-z0-9_-]*'
               OR substr(NEW.webauthn_user_handle, -1) NOT GLOB '[AEIMQUYcgkosw048]')
            BEGIN SELECT RAISE(ABORT, 'INVALID_MEMBER_HANDLE'); END""")
        conn.execute("""CREATE TRIGGER IF NOT EXISTS identity_member_handle_immutable
            BEFORE UPDATE OF webauthn_user_handle ON identity_members
            WHEN OLD.webauthn_user_handle IS NOT NULL AND NEW.webauthn_user_handle IS NOT OLD.webauthn_user_handle
            BEGIN SELECT RAISE(ABORT, 'INVALID_MEMBER_HANDLE'); END""")
        conn.execute("""CREATE TRIGGER IF NOT EXISTS identity_credential_handle_immutable
            BEFORE UPDATE OF handle_format, webauthn_user_handle, member_id ON identity_credentials
            WHEN NEW.handle_format IS NOT OLD.handle_format OR NEW.webauthn_user_handle IS NOT OLD.webauthn_user_handle
                 OR NEW.member_id IS NOT OLD.member_id
            BEGIN SELECT RAISE(ABORT, 'INVALID_CREDENTIAL_HANDLE'); END""")
        conn.execute("""CREATE TRIGGER IF NOT EXISTS identity_credential_handle_insert
            BEFORE INSERT ON identity_credentials
            WHEN (NEW.handle_format = 'legacy-v1' AND NEW.webauthn_user_handle IS NOT NULL)
              OR (NEW.handle_format = 'isolated-v2' AND (NEW.webauthn_user_handle IS NULL
                  OR length(NEW.webauthn_user_handle) != 43
                  OR NEW.webauthn_user_handle GLOB '*[^A-Za-z0-9_-]*'
                  OR substr(NEW.webauthn_user_handle, -1) NOT GLOB '[AEIMQUYcgkosw048]'
                  OR NEW.webauthn_user_handle IS NOT (SELECT webauthn_user_handle FROM identity_members WHERE member_id = NEW.member_id)))
            BEGIN SELECT RAISE(ABORT, 'INVALID_CREDENTIAL_HANDLE'); END""")
        conn.execute("""CREATE TRIGGER IF NOT EXISTS identity_passkey_marker_immutable
            BEFORE UPDATE OF webauthn_v2_issued_at ON identity_household
            WHEN OLD.webauthn_v2_issued_at IS NOT NULL AND NEW.webauthn_v2_issued_at IS NOT OLD.webauthn_v2_issued_at
            BEGIN SELECT RAISE(ABORT, 'INVALID_PASSKEY_MARKER'); END""")
        conn.execute("""CREATE TRIGGER IF NOT EXISTS identity_first_isolated_credential
            AFTER INSERT ON identity_credentials WHEN NEW.handle_format = 'isolated-v2'
            BEGIN UPDATE identity_household SET webauthn_v2_issued_at = COALESCE(webauthn_v2_issued_at, NEW.created_at) WHERE id = 1; END""")
        # A NULL left by a pre-upgrade member insert is allocated once under this write lock.
        for member in conn.execute("SELECT member_id FROM identity_members WHERE webauthn_user_handle IS NULL").fetchall():
            handle = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
            conn.execute("UPDATE identity_members SET webauthn_user_handle = ? WHERE member_id = ?", (handle, member["member_id"]))
        conn.execute(
            "INSERT OR IGNORE INTO identity_household (id, state, generation, global_epoch, updated_at) VALUES (1, 'setup', ?, 1, ?)",
            (int(payload["generation"]), payload["now"]),
        )
        # Recover the informational marker if v2 rows were restored without it; never allocate a new
        # credential or relabel a legacy record. Timestamps are the server's stored enrollment times.
        conn.execute("UPDATE identity_household SET webauthn_v2_issued_at = (SELECT MIN(created_at) FROM identity_credentials WHERE handle_format = 'isolated-v2') WHERE id = 1 AND webauthn_v2_issued_at IS NULL")
        # Preserve the snapshot's monotonic generation without changing authorization epochs.
        conn.execute("UPDATE identity_household SET generation = MAX(generation, ?) WHERE id = 1", (int(payload["generation"]),))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    emit({"ok": True})

elif op == "load":
    household = rows("SELECT * FROM identity_household WHERE id = 1")
    emit({
        "household": household[0] if household else None,
        "members": rows("SELECT * FROM identity_members ORDER BY created_at, member_id"),
        "credentials": rows("SELECT * FROM identity_credentials ORDER BY created_at, credential_id"),
        "grants": rows("SELECT * FROM identity_enrollment_grants ORDER BY member_id"),
    })

elif op == "commit":
    def apply():
        current = conn.execute("SELECT generation FROM identity_household WHERE id = 1").fetchone()
        if current is None or current["generation"] != payload["expectGeneration"]:
            return {"ok": False, "conflict": True}
        # A change made on the strength of the passphrase holds only while that passphrase is still stored.
        if "expectPassphraseHash" in payload:
            stored = conn.execute("SELECT passphrase_hash FROM homebase_admin_credentials WHERE id = 1").fetchone()
            if stored is None or stored["passphrase_hash"] != payload["expectPassphraseHash"]:
                return {"ok": False, "passphraseChanged": True}
        if "consumeAction" in payload:
            taken = take_action(payload["consumeAction"], payload["nowSeconds"], payload["now"])
            if taken != "taken":
                return {"ok": False, taken: True}
        generation = payload["expectGeneration"] + 1
        household = payload.get("household") or {}
        for name in ("state", "global_epoch", "pending_administrator_login"):
            if name in household:
                conn.execute(f"UPDATE identity_household SET {name} = ? WHERE id = 1", (household[name],))
        conn.execute("UPDATE identity_household SET generation = ?, updated_at = ? WHERE id = 1", (generation, payload["now"]))
        for record in payload.get("members", []):
            upsert("identity_members", "member_id", MEMBER_FIELDS, record, ("webauthn_user_handle",))
        for record in payload.get("credentials", []):
            upsert("identity_credentials", "credential_id", CREDENTIAL_FIELDS, record, ("member_id", "handle_format", "webauthn_user_handle"))
        if payload.get("revokeSessions"):
            conn.execute("DELETE FROM homebase_admin_sessions")
            conn.execute("DELETE FROM identity_enrollment_grants")
        for member_id in payload.get("deleteGrants", []):
            conn.execute("DELETE FROM identity_enrollment_grants WHERE member_id = ?", (member_id,))
        for record in payload.get("grants", []):
            upsert("identity_enrollment_grants", "member_id", GRANT_FIELDS, record)
        if "passphraseHash" in payload:
            conn.execute(
                "INSERT INTO homebase_admin_credentials (id, passphrase_hash, created_at, updated_at) VALUES (1, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET passphrase_hash = excluded.passphrase_hash, updated_at = excluded.updated_at",
                (payload["passphraseHash"], payload["now"], payload["now"]),
            )
        for entry in payload.get("audit", []):
            conn.execute(
                "INSERT INTO homebase_admin_audit (created_at, action, target, dry_run, outcome, reason) VALUES (?, ?, ?, 0, ?, ?)",
                (payload["now"], entry["action"], entry["target"], entry["outcome"], entry.get("reason")),
            )
        return {"ok": True, "generation": generation}

    conn.execute("BEGIN IMMEDIATE")
    try:
        result = apply()
    except sqlite3.IntegrityError as error:
        detail = str(error)
        if detail in ("INVALID_MEMBER_HANDLE", "UNIQUE constraint failed: identity_members.webauthn_user_handle"):
            result = {"ok": False, "handleError": "INVALID_MEMBER_HANDLE"}
        elif detail == "INVALID_CREDENTIAL_HANDLE" or detail == "NOT NULL constraint failed: identity_credentials.handle_format" or detail.startswith("CHECK constraint failed: handle_format IN ("):
            result = {"ok": False, "handleError": "INVALID_CREDENTIAL_HANDLE"}
        elif detail == "INVALID_PASSKEY_MARKER":
            result = {"ok": False, "handleError": "INVALID_PASSKEY_METADATA"}
        else:
            result = {"ok": False, "integrity": detail}
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT" if result["ok"] else "ROLLBACK")
    emit(result)

elif op == "consume":
    # payload: action {jti, app, expiresAt}, now, nowSeconds, expect {userId, state, globalEpoch, epoch}: the
    # member as the redemption saw them, which must still stand when the jti is taken.
    conn.execute("BEGIN IMMEDIATE")
    try:
        expect = payload["expect"]
        household = conn.execute("SELECT state, global_epoch FROM identity_household WHERE id = 1").fetchone()
        member = conn.execute("SELECT status, epoch FROM identity_members WHERE user_id = ?", (expect["userId"],)).fetchone()
        if (household is None or member is None or household["state"] != expect["state"] or household["global_epoch"] != expect["globalEpoch"]
                or member["status"] != "active" or member["epoch"] != expect["epoch"]):
            result = {"ok": False, "stale": True}
        else:
            taken = take_action(payload["action"], payload["nowSeconds"], payload["now"])
            result = {"ok": True} if taken == "taken" else {"ok": False, taken: True}
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT" if result["ok"] else "ROLLBACK")
    emit(result)

elif op == "publish":
    # payload: expectGeneration, file, body (the snapshot JSON, already checked by the library's parser).
    path = payload["file"]
    directory = os.path.dirname(path)
    conn.execute("BEGIN IMMEDIATE")
    try:
        current = conn.execute("SELECT generation FROM identity_household WHERE id = 1").fetchone()
        if current is None or current["generation"] != payload["expectGeneration"]:
            result = {"ok": False, "conflict": True}
        else:
            try:
                with open(path, "rb") as existing:
                    on_disk = json.loads(existing.read()).get("generation", 0)
            except (OSError, ValueError, AttributeError):
                on_disk = 0
            if isinstance(on_disk, int) and on_disk > payload["expectGeneration"]:
                result = {"ok": False, "newerOnDisk": on_disk}
            else:
                # As the library's writeSnapshot: a new file beside it (no symlink followed, no name reused),
                # synced, renamed over it, the directory synced.
                temp = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.{secrets.token_hex(6)}")
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
                try:
                    try:
                        os.write(fd, payload["body"].encode("utf-8"))
                        os.fchmod(fd, 0o644)
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                    os.rename(temp, path)
                except BaseException:
                    try:
                        os.unlink(temp)
                    except FileNotFoundError:
                        pass
                    raise
                dir_fd = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
                result = {"ok": True}
    finally:
        conn.execute("ROLLBACK")
    emit(result)

else:
    raise SystemExit(f"Unsupported directory store op: {op}")
`;

function run(dbPath, op, payload = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const result = spawnSync('python3', ['-c', PYTHON_SCRIPT, dbPath, op], { input: JSON.stringify(payload), encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'directory store failed').trim());
  return result.stdout ? JSON.parse(result.stdout) : null;
}

// The admin tables (sessions, passphrase, audit) are the state store's; it is initialised first.
function createDirectoryStore(dbPath) {
  return {
    init: ({ generation, now }) => run(dbPath, 'init', { generation, now }),
    load: () => run(dbPath, 'load'),
    commit: (change) => run(dbPath, 'commit', change),
    consume: (request) => run(dbPath, 'consume', request),
    publish: (snapshot) => run(dbPath, 'publish', snapshot),
  };
}

module.exports = { createDirectoryStore };
