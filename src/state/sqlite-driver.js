const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PYTHON_SCRIPT = `
import json
import sqlite3
import sys
from pathlib import Path

db_path = Path(sys.argv[1])
op = sys.argv[2]
payload = json.loads(sys.stdin.read() or "{}")
db_path.parent.mkdir(parents=True, exist_ok=True)

conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row

SCHEMA = """
CREATE TABLE IF NOT EXISTS bootstrap_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,
  service_user TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS installations (
  app_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT,
  port INTEGER NOT NULL,
  mount_path TEXT NOT NULL,
  external_url TEXT NOT NULL,
  install_root TEXT NOT NULL,
  service_name TEXT NOT NULL,
  git_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  planned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  current_step TEXT,
  plan_json TEXT,
  log_text TEXT NOT NULL DEFAULT '',
  result_json TEXT,
  error_text TEXT
);

CREATE TABLE IF NOT EXISTS backup_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  archive_dir TEXT NOT NULL UNIQUE,
  generated_at TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  included_files_json TEXT NOT NULL DEFAULT '[]',
  job_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_update_status (
  app_id TEXT PRIMARY KEY,
  tracked_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  can_update INTEGER,
  ahead_count INTEGER NOT NULL DEFAULT 0,
  behind_count INTEGER NOT NULL DEFAULT 0,
  local_head_sha TEXT,
  remote_head_sha TEXT,
  last_checked_at TEXT NOT NULL,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS homebase_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hostname TEXT,
  domain TEXT,
  git_transport TEXT,
  git_ssh_key_path TEXT,
  health_alerts_enabled INTEGER NOT NULL DEFAULT 0,
  health_alerts_webhook_url TEXT,
  tailscale_managed_service_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS homebase_admin_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  passphrase_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS homebase_admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS homebase_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  reason TEXT,
  job_id INTEGER,
  session_token_hash TEXT
);
"""

def row_to_dict(row):
    return dict(row) if row is not None else None

def emit(value):
    sys.stdout.write(json.dumps(value))

if op == "init":
    conn.executescript(SCHEMA)
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(homebase_config)")}
    if "health_alerts_enabled" not in columns:
        conn.execute("ALTER TABLE homebase_config ADD COLUMN health_alerts_enabled INTEGER NOT NULL DEFAULT 0")
    if "health_alerts_webhook_url" not in columns:
        conn.execute("ALTER TABLE homebase_config ADD COLUMN health_alerts_webhook_url TEXT")
    if "tailscale_managed_service_id" not in columns:
        conn.execute("ALTER TABLE homebase_config ADD COLUMN tailscale_managed_service_id TEXT")
    installation_columns = {row["name"] for row in conn.execute("PRAGMA table_info(installations)")}
    if "managed_by" not in installation_columns:
        conn.execute("ALTER TABLE installations ADD COLUMN managed_by TEXT")
    conn.commit()
    emit({"ok": True})

elif op == "load_state":
    plans = [row_to_dict(row) for row in conn.execute(
        "SELECT generated_at, service_user FROM bootstrap_plans ORDER BY id DESC LIMIT 20"
    )]
    installations = {}
    for row in conn.execute(
        "SELECT * FROM installations ORDER BY name"
    ):
        record = row_to_dict(row)
        update_row = conn.execute(
            "SELECT * FROM app_update_status WHERE app_id = ?",
            (record["app_id"],),
        ).fetchone()
        update_status = None
        if update_row is not None:
            update_status = {
                "appId": update_row["app_id"],
                "trackedRef": update_row["tracked_ref"],
                "status": update_row["status"],
                "canUpdate": None if update_row["can_update"] is None else bool(update_row["can_update"]),
                "aheadCount": update_row["ahead_count"] or 0,
                "behindCount": update_row["behind_count"] or 0,
                "localHeadSha": update_row["local_head_sha"] or "",
                "remoteHeadSha": update_row["remote_head_sha"] or "",
                "lastCheckedAt": update_row["last_checked_at"],
                "lastError": update_row["last_error"] or "",
            }
        installations[record["app_id"]] = {
            "appId": record["app_id"],
            "name": record["name"],
            "purpose": record["purpose"] or "",
            "port": record["port"],
            "mountPath": record["mount_path"],
            "externalUrl": record["external_url"],
            "installRoot": record["install_root"],
            "serviceName": record["service_name"],
            "ref": record["git_ref"],
            "status": record["status"],
            "plannedAt": record["planned_at"],
            "updatedAt": record["updated_at"],
            "managedBy": record.get("managed_by") or "",
            "updateStatus": update_status,
        }
    def serialize_job(row):
        return {
            "id": row["id"],
            "kind": row["kind"],
            "target": row["target"],
            "status": row["status"],
            "dryRun": bool(row["dry_run"]),
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
            "currentStep": row["current_step"],
            "error": row["error_text"],
        }

    jobs = [
        serialize_job(row)
        for row in conn.execute(
            "SELECT * FROM jobs ORDER BY id DESC LIMIT 20"
        )
    ]
    active_jobs = [
        serialize_job(row)
        for row in conn.execute(
            "SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY id DESC"
        )
    ]
    backups = [
        {
            "id": row["id"],
            "appId": row["app_id"],
            "archiveDir": row["archive_dir"],
            "generatedAt": row["generated_at"],
            "dryRun": bool(row["dry_run"]),
            "status": row["status"],
            "includedFiles": json.loads(row["included_files_json"] or "[]"),
            "jobId": row["job_id"],
            "createdAt": row["created_at"],
        }
        for row in conn.execute(
            "SELECT * FROM backup_records ORDER BY generated_at DESC LIMIT 50"
        )
    ]
    emit({
        "version": 2,
        "bootstrapPlans": [
            {"generatedAt": item["generated_at"], "serviceUser": item["service_user"]}
            for item in plans
        ],
        "installations": installations,
        "jobs": jobs,
        "activeJobs": active_jobs,
        "backups": backups,
    })

elif op == "add_bootstrap_plan":
    conn.execute(
        "INSERT INTO bootstrap_plans (generated_at, service_user) VALUES (?, ?)",
        (payload["generatedAt"], payload["serviceUser"]),
    )
    conn.commit()
    emit({"ok": True})

elif op == "upsert_installation":
    record = payload["record"]
    conn.execute(
        """
        INSERT INTO installations (
          app_id, name, purpose, port, mount_path, external_url,
          install_root, service_name, git_ref, status, planned_at, updated_at, managed_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id) DO UPDATE SET
          name=excluded.name,
          purpose=excluded.purpose,
          port=excluded.port,
          mount_path=excluded.mount_path,
          external_url=excluded.external_url,
          install_root=excluded.install_root,
          service_name=excluded.service_name,
          git_ref=excluded.git_ref,
          status=excluded.status,
          planned_at=excluded.planned_at,
          updated_at=excluded.updated_at,
          managed_by=COALESCE(excluded.managed_by, installations.managed_by)
        """,
        (
            record["appId"],
            record["name"],
            record.get("purpose", ""),
            record["port"],
            record["mountPath"],
            record["externalUrl"],
            record["installRoot"],
            record["serviceName"],
            record["ref"],
            record["status"],
            record["plannedAt"],
            record["updatedAt"],
            record.get("managedBy") or None,
        ),
    )
    conn.commit()
    emit({"ok": True})

elif op == "create_job":
    job = payload["job"]
    cursor = conn.execute(
        """
        INSERT INTO jobs (
          kind, target, status, dry_run, created_at, current_step, plan_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job["kind"],
            job["target"],
            job["status"],
            1 if job.get("dryRun") else 0,
            job["createdAt"],
            job.get("currentStep"),
            job.get("planJson"),
        ),
    )
    conn.commit()
    emit({"id": cursor.lastrowid})

elif op == "append_job_log":
    conn.execute(
        """
        UPDATE jobs
        SET log_text = COALESCE(log_text, '') || ?
        WHERE id = ?
        """,
        (payload["text"], payload["jobId"]),
    )
    conn.commit()
    emit({"ok": True})

elif op == "update_job":
    fields = payload["fields"]
    allowed = {
        "status": "status",
        "startedAt": "started_at",
        "finishedAt": "finished_at",
        "currentStep": "current_step",
        "resultJson": "result_json",
        "errorText": "error_text",
        "planJson": "plan_json",
    }
    assignments = []
    params = []
    for key, column in allowed.items():
        if key in fields:
            assignments.append(f"{column} = ?")
            params.append(fields[key])
    if assignments:
        params.append(payload["jobId"])
        conn.execute(
            f"UPDATE jobs SET {', '.join(assignments)} WHERE id = ?",
            params,
        )
        conn.commit()
    emit({"ok": True})

elif op == "get_job":
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (payload["jobId"],)).fetchone()
    if row is None:
        emit(None)
    else:
        emit({
            "id": row["id"],
            "kind": row["kind"],
            "target": row["target"],
            "status": row["status"],
            "dryRun": bool(row["dry_run"]),
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
            "currentStep": row["current_step"],
            "planJson": row["plan_json"],
            "log": row["log_text"],
            "resultJson": row["result_json"],
            "error": row["error_text"],
        })

elif op == "get_latest_job_by_kind":
    row = conn.execute(
        "SELECT * FROM jobs WHERE kind = ? ORDER BY id DESC LIMIT 1",
        (payload["kind"],),
    ).fetchone()
    if row is None:
        emit(None)
    else:
        emit({
            "id": row["id"],
            "kind": row["kind"],
            "target": row["target"],
            "status": row["status"],
            "dryRun": bool(row["dry_run"]),
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
            "currentStep": row["current_step"],
            "planJson": row["plan_json"],
            "log": row["log_text"],
            "resultJson": row["result_json"],
            "error": row["error_text"],
        })


elif op == "get_latest_completed_real_job_by_kind":
    row = conn.execute(
        "SELECT * FROM jobs WHERE kind = ? AND dry_run = 0 AND status = 'completed' ORDER BY id DESC LIMIT 1",
        (payload["kind"],),
    ).fetchone()
    if row is None:
        emit(None)
    else:
        emit({
            "id": row["id"],
            "kind": row["kind"],
            "target": row["target"],
            "status": row["status"],
            "dryRun": bool(row["dry_run"]),
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
            "currentStep": row["current_step"],
            "planJson": row["plan_json"],
            "log": row["log_text"],
            "resultJson": row["result_json"],
            "error": row["error_text"],
        })

elif op == "list_running_jobs_by_kind":
    jobs = [
        {
            "id": row["id"],
            "kind": row["kind"],
            "target": row["target"],
            "status": row["status"],
            "dryRun": bool(row["dry_run"]),
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
            "currentStep": row["current_step"],
            "planJson": row["plan_json"],
            "log": row["log_text"],
            "resultJson": row["result_json"],
            "error": row["error_text"],
        }
        for row in conn.execute(
            "SELECT * FROM jobs WHERE kind = ? AND status = 'running' ORDER BY id DESC",
            (payload["kind"],),
        )
    ]
    emit(jobs)

elif op == "list_unfinished_jobs":
    jobs = [
        {
            "id": row["id"],
            "kind": row["kind"],
            "target": row["target"],
            "status": row["status"],
            "dryRun": bool(row["dry_run"]),
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
            "currentStep": row["current_step"],
            "planJson": row["plan_json"],
            "log": row["log_text"],
            "resultJson": row["result_json"],
            "error": row["error_text"],
        }
        for row in conn.execute(
            "SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY id ASC", (),
        )
    ]
    emit(jobs)

elif op == "record_backup":
    record = payload["record"]
    conn.execute(
        """
        INSERT INTO backup_records (
          app_id, archive_dir, generated_at, dry_run, status,
          included_files_json, job_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(archive_dir) DO UPDATE SET
          app_id=excluded.app_id,
          generated_at=excluded.generated_at,
          dry_run=excluded.dry_run,
          status=excluded.status,
          included_files_json=excluded.included_files_json,
          job_id=excluded.job_id,
          created_at=excluded.created_at
        """,
        (
            record["appId"],
            record["archiveDir"],
            record["generatedAt"],
            1 if record.get("dryRun") else 0,
            record["status"],
            json.dumps(record.get("includedFiles", [])),
            record.get("jobId"),
            record["createdAt"],
        ),
    )
    conn.commit()
    emit({"ok": True})

elif op == "list_backups":
    backups = [
        {
            "id": row["id"],
            "appId": row["app_id"],
            "archiveDir": row["archive_dir"],
            "generatedAt": row["generated_at"],
            "dryRun": bool(row["dry_run"]),
            "status": row["status"],
            "includedFiles": json.loads(row["included_files_json"] or "[]"),
            "jobId": row["job_id"],
            "createdAt": row["created_at"],
        }
        for row in conn.execute(
            "SELECT * FROM backup_records WHERE app_id = ? ORDER BY generated_at DESC",
            (payload["appId"],),
        )
    ]
    emit(backups)

elif op == "delete_backups":
    conn.execute(
        "DELETE FROM backup_records WHERE app_id = ?",
        (payload["appId"],),
    )
    conn.commit()
    emit({"ok": True})

elif op == "set_managed_by":
    # The upsert only ever keeps or advances managed_by; this is the one explicit way to change it back.
    conn.execute(
        "UPDATE installations SET managed_by = ? WHERE app_id = ?",
        (payload.get("managedBy") or None, payload["appId"]),
    )
    conn.commit()
    emit({"ok": True})

elif op == "delete_installation":
    conn.execute(
        "DELETE FROM installations WHERE app_id = ?",
        (payload["appId"],),
    )
    conn.execute(
        "DELETE FROM app_update_status WHERE app_id = ?",
        (payload["appId"],),
    )
    conn.commit()
    emit({"ok": True})

elif op == "upsert_app_update_status":
    record = payload["record"]
    conn.execute(
        """
        INSERT INTO app_update_status (
          app_id, tracked_ref, status, can_update, ahead_count, behind_count,
          local_head_sha, remote_head_sha, last_checked_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id) DO UPDATE SET
          tracked_ref=excluded.tracked_ref,
          status=excluded.status,
          can_update=excluded.can_update,
          ahead_count=excluded.ahead_count,
          behind_count=excluded.behind_count,
          local_head_sha=excluded.local_head_sha,
          remote_head_sha=excluded.remote_head_sha,
          last_checked_at=excluded.last_checked_at,
          last_error=excluded.last_error
        """,
        (
            record["appId"],
            record.get("trackedRef", "main"),
            record.get("status", "check-failed"),
            None if record.get("canUpdate") is None else (1 if record.get("canUpdate") else 0),
            int(record.get("aheadCount", 0)),
            int(record.get("behindCount", 0)),
            record.get("localHeadSha", ""),
            record.get("remoteHeadSha", ""),
            record["lastCheckedAt"],
            record.get("lastError", ""),
        ),
    )
    conn.commit()
    emit({"ok": True})

elif op == "list_app_update_statuses":
    rows = [
        {
            "appId": row["app_id"],
            "trackedRef": row["tracked_ref"],
            "status": row["status"],
            "canUpdate": None if row["can_update"] is None else bool(row["can_update"]),
            "aheadCount": row["ahead_count"] or 0,
            "behindCount": row["behind_count"] or 0,
            "localHeadSha": row["local_head_sha"] or "",
            "remoteHeadSha": row["remote_head_sha"] or "",
            "lastCheckedAt": row["last_checked_at"],
            "lastError": row["last_error"] or "",
        }
        for row in conn.execute(
            "SELECT * FROM app_update_status ORDER BY app_id"
        )
    ]
    emit(rows)

elif op == "get_homebase_config":
    row = conn.execute(
        "SELECT hostname, domain, git_transport, git_ssh_key_path, health_alerts_enabled, health_alerts_webhook_url, tailscale_managed_service_id, updated_at FROM homebase_config WHERE id = 1"
    ).fetchone()
    if row is None:
        emit(None)
    else:
        emit({
            "hostname": row["hostname"],
            "domain": row["domain"],
            "gitTransport": row["git_transport"],
            "gitSshKeyPath": row["git_ssh_key_path"] or "",
            "healthAlertsEnabled": bool(row["health_alerts_enabled"]),
            "healthAlertsWebhookUrl": row["health_alerts_webhook_url"] or "",
            "tailscaleManagedServiceId": row["tailscale_managed_service_id"] or "svc:home",
            "updatedAt": row["updated_at"],
        })

elif op == "set_homebase_config":
    record = payload["record"]
    conn.execute(
        """
        INSERT INTO homebase_config (
          id, hostname, domain, git_transport, git_ssh_key_path, health_alerts_enabled, health_alerts_webhook_url, tailscale_managed_service_id, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          hostname=excluded.hostname,
          domain=excluded.domain,
          git_transport=excluded.git_transport,
          git_ssh_key_path=excluded.git_ssh_key_path,
          health_alerts_enabled=excluded.health_alerts_enabled,
          health_alerts_webhook_url=excluded.health_alerts_webhook_url,
          tailscale_managed_service_id=excluded.tailscale_managed_service_id,
          updated_at=excluded.updated_at
        """,
        (
            record["hostname"],
            record["domain"],
            record["gitTransport"],
            record.get("gitSshKeyPath", ""),
            1 if record.get("healthAlertsEnabled") else 0,
            record.get("healthAlertsWebhookUrl", ""),
            record.get("tailscaleManagedServiceId", "svc:home"),
            record["updatedAt"],
        ),
    )
    conn.commit()
    emit({"ok": True})

elif op == "get_admin_credential":
    row = conn.execute(
        "SELECT passphrase_hash, created_at, updated_at FROM homebase_admin_credentials WHERE id = 1"
    ).fetchone()
    if row is None:
        emit(None)
    else:
        emit({
            "passphraseHash": row["passphrase_hash"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        })

elif op == "set_admin_credential":
    record = payload["record"]
    conn.execute(
        """
        INSERT INTO homebase_admin_credentials (
          id, passphrase_hash, created_at, updated_at
        ) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          passphrase_hash=excluded.passphrase_hash,
          updated_at=excluded.updated_at
        """,
        (
            record["passphraseHash"],
            record["createdAt"],
            record["updatedAt"],
        ),
    )
    conn.commit()
    emit({"ok": True})

elif op == "create_admin_session":
    record = payload["record"]
    conn.execute(
        """
        INSERT INTO homebase_admin_sessions (
          token_hash, created_at, expires_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET
          created_at=excluded.created_at,
          expires_at=excluded.expires_at
        """,
        (
            record["tokenHash"],
            record["createdAt"],
            record["expiresAt"],
        ),
    )
    conn.commit()
    emit({"ok": True})

elif op == "get_admin_session":
    row = conn.execute(
        "SELECT token_hash, created_at, expires_at FROM homebase_admin_sessions WHERE token_hash = ?",
        (payload["tokenHash"],),
    ).fetchone()
    if row is None:
        emit(None)
    else:
        emit({
            "tokenHash": row["token_hash"],
            "createdAt": row["created_at"],
            "expiresAt": row["expires_at"],
        })

elif op == "delete_admin_session":
    conn.execute(
        "DELETE FROM homebase_admin_sessions WHERE token_hash = ?",
        (payload["tokenHash"],),
    )
    conn.commit()
    emit({"ok": True})

elif op == "delete_all_admin_sessions":
    conn.execute("DELETE FROM homebase_admin_sessions")
    conn.commit()
    emit({"ok": True})

elif op == "prune_admin_sessions":
    conn.execute(
        "DELETE FROM homebase_admin_sessions WHERE expires_at <= ?",
        (payload["nowIso"],),
    )
    conn.commit()
    emit({"ok": True})

elif op == "create_admin_audit":
    record = payload["record"]
    cursor = conn.execute(
        """
        INSERT INTO homebase_admin_audit (
          created_at, action, target, dry_run, outcome, reason, job_id, session_token_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record["createdAt"],
            record["action"],
            record["target"],
            1 if record.get("dryRun") else 0,
            record["outcome"],
            record.get("reason"),
            record.get("jobId"),
            record.get("sessionTokenHash"),
        ),
    )
    conn.commit()
    emit({"id": cursor.lastrowid})

elif op == "list_admin_audit":
    limit = int(payload.get("limit", 50))
    if limit < 1: limit = 1
    if limit > 200: limit = 200
    rows = [
        {
            "id": row["id"],
            "createdAt": row["created_at"],
            "action": row["action"],
            "target": row["target"],
            "dryRun": bool(row["dry_run"]),
            "outcome": row["outcome"],
            "reason": row["reason"],
            "jobId": row["job_id"],
            "sessionTokenHash": row["session_token_hash"],
        }
        for row in conn.execute(
            "SELECT * FROM homebase_admin_audit ORDER BY id DESC LIMIT ?",
            (limit,),
        )
    ]
    emit(rows)

else:
    raise SystemExit(f"Unsupported sqlite driver op: {op}")
`;

function runSqliteOp(dbPath, op, payload = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const result = spawnSync('python3', ['-c', PYTHON_SCRIPT, dbPath, op], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'sqlite driver failed').trim());
  }

  return result.stdout ? JSON.parse(result.stdout) : null;
}

module.exports = {
  runSqliteOp,
};
