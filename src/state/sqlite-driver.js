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
"""

def row_to_dict(row):
    return dict(row) if row is not None else None

def emit(value):
    sys.stdout.write(json.dumps(value))

if op == "init":
    conn.executescript(SCHEMA)
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
        }
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
            "error": row["error_text"],
        }
        for row in conn.execute(
            "SELECT * FROM jobs ORDER BY id DESC LIMIT 20"
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
          install_root, service_name, git_ref, status, planned_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          updated_at=excluded.updated_at
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
