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
import os
import secrets
import sqlite3
import sys

db_path = sys.argv[1]
op = sys.argv[2]
payload = json.loads(sys.stdin.read() or "{}")

conn = sqlite3.connect(db_path, isolation_level=None, timeout=10)
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
"""

MEMBER_FIELDS = ["member_id", "user_id", "login", "name", "role", "administrator", "status", "epoch", "apps", "created_at", "updated_at"]
CREDENTIAL_FIELDS = ["credential_id", "member_id", "kind", "label", "orphaned", "created_at", "revoked_at"]
GRANT_FIELDS = ["member_id", "code_hash", "issued_by", "created_at", "expires_at"]

def rows(sql, args=()):
    return [dict(row) for row in conn.execute(sql, args)]

def upsert(table, key, fields, record):
    names = ", ".join(fields)
    marks = ", ".join("?" for _ in fields)
    updates = ", ".join(f"{name}=excluded.{name}" for name in fields if name != key)
    conn.execute(
        f"INSERT INTO {table} ({names}) VALUES ({marks}) ON CONFLICT({key}) DO UPDATE SET {updates}",
        [record.get(name) for name in fields],
    )

def emit(value):
    sys.stdout.write(json.dumps(value))

if op == "init":
    conn.executescript(SCHEMA)
    conn.execute(
        "INSERT OR IGNORE INTO identity_household (id, state, generation, global_epoch, updated_at) VALUES (1, 'setup', ?, 1, ?)",
        (int(payload["generation"]), payload["now"]),
    )
    # A directory restored from an older database, or started after a preview, must not publish a
    # generation lower than the snapshot already on disk: apps refuse a generation going backwards.
    conn.execute("UPDATE identity_household SET generation = MAX(generation, ?) WHERE id = 1", (int(payload["generation"]),))
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
        generation = payload["expectGeneration"] + 1
        household = payload.get("household") or {}
        for name in ("state", "global_epoch", "pending_administrator_login"):
            if name in household:
                conn.execute(f"UPDATE identity_household SET {name} = ? WHERE id = 1", (household[name],))
        conn.execute("UPDATE identity_household SET generation = ?, updated_at = ? WHERE id = 1", (generation, payload["now"]))
        for record in payload.get("members", []):
            upsert("identity_members", "member_id", MEMBER_FIELDS, record)
        for record in payload.get("credentials", []):
            upsert("identity_credentials", "credential_id", CREDENTIAL_FIELDS, record)
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
        result = {"ok": False, "integrity": str(error)}
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
            except (FileNotFoundError, ValueError, AttributeError):
                on_disk = 0
            if isinstance(on_disk, int) and on_disk > payload["expectGeneration"]:
                result = {"ok": False, "newerOnDisk": on_disk}
            else:
                # As the library's writeSnapshot: a new file beside it (no symlink followed, no name reused),
                # synced, renamed over it, the directory synced.
                temp = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.{secrets.token_hex(6)}")
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
                try:
                    os.write(fd, payload["body"].encode("utf-8"))
                    os.fchmod(fd, 0o644)
                    os.fsync(fd)
                finally:
                    os.close(fd)
                try:
                    os.rename(temp, path)
                except BaseException:
                    os.unlink(temp)
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
    publish: (snapshot) => run(dbPath, 'publish', snapshot),
  };
}

module.exports = { createDirectoryStore };
