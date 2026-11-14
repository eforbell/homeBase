-- Pre-handle directory schema from homeBase 48ae02d, including its existing key-column migration.

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

ALTER TABLE identity_credentials ADD COLUMN public_key TEXT;
ALTER TABLE identity_credentials ADD COLUMN counter INTEGER NOT NULL DEFAULT 0;
ALTER TABLE identity_credentials ADD COLUMN transports TEXT;
ALTER TABLE identity_credentials ADD COLUMN aaguid TEXT;
ALTER TABLE identity_credentials ADD COLUMN device_type TEXT;
ALTER TABLE identity_credentials ADD COLUMN backed_up INTEGER NOT NULL DEFAULT 1;
ALTER TABLE identity_credentials ADD COLUMN root TEXT;
ALTER TABLE identity_credentials ADD COLUMN last_used_at TEXT;
