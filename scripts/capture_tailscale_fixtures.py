#!/usr/bin/env python3
"""
Capture Tailscale fixture envelopes for Feature-4.

Usage:
  python3 scripts/capture_tailscale_fixtures.py
  python3 scripts/capture_tailscale_fixtures.py --hosts erebor,numenor
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import shlex
import subprocess
from typing import Any


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURE_DIR = REPO_ROOT / "test" / "fixtures" / "tailscale"


def run(cmd: list[str], timeout: int = 20) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        return 124, e.stdout or "", (e.stderr or "") + f"\n[timeout after {timeout}s]"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def envelope(command: list[str], host: str, code: int, out: str, err: str) -> dict[str, Any]:
    return {
        "capturedAt": now_iso(),
        "host": host,
        "command": command,
        "commandString": " ".join(shlex.quote(part) for part in command),
        "exitCode": code,
        "stdout": out,
        "stderr": err,
    }


def filter_status(status_json: dict[str, Any]) -> dict[str, Any]:
    peer = status_json.get("Peer") or {}
    return {
        "Version": status_json.get("Version"),
        "BackendState": status_json.get("BackendState"),
        "AuthURLPresent": bool(status_json.get("AuthURL")),
        "HealthCount": len(status_json.get("Health") or []),
        "MagicDNSSuffix": status_json.get("MagicDNSSuffix"),
        "CurrentTailnet": {
            "Name": (status_json.get("CurrentTailnet") or {}).get("Name"),
            "MagicDNSEnabled": (status_json.get("CurrentTailnet") or {}).get("MagicDNSEnabled"),
        },
        "Self": {
            "HostName": (status_json.get("Self") or {}).get("HostName"),
            "DNSName": (status_json.get("Self") or {}).get("DNSName"),
            "OS": (status_json.get("Self") or {}).get("OS"),
            "Online": (status_json.get("Self") or {}).get("Online"),
            "Active": (status_json.get("Self") or {}).get("Active"),
        },
        "PeerCount": len(peer),
        "OnlinePeerCount": sum(1 for p in peer.values() if p.get("Online")),
        "ActivePeerCount": sum(1 for p in peer.values() if p.get("Active")),
        "ServiceCount": sum(1 for p in peer.values() if p.get("Services")),
    }


def write_json(path: pathlib.Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def capture_local() -> None:
    code, out, err = run(["tailscale", "status", "--json"])
    payload: dict[str, Any] = {
        "capturedAt": now_iso(),
        "command": ["tailscale", "status", "--json"],
        "commandString": "tailscale status --json",
        "exitCode": code,
    }
    if code == 0:
        payload["snapshot"] = filter_status(json.loads(out))
    else:
        payload["stderr"] = err
        payload["stdoutSample"] = out[:400]
    write_json(FIXTURE_DIR / "status-snapshot-local-mac.json", payload)

    for name, command in [
        ("serve-config-all-local-mac.json", ["tailscale", "serve", "get-config", "--all"]),
        ("version-local-mac.json", ["tailscale", "version"]),
    ]:
        code, out, err = run(command)
        write_json(FIXTURE_DIR / name, envelope(command, "local-dev-mac", code, out, err))


def capture_remote(host: str) -> None:
    status_cmd = ["tailscale", "ssh", host, "tailscale", "status", "--json"]
    code, out, err = run(status_cmd)
    payload: dict[str, Any] = {
        "capturedAt": now_iso(),
        "command": status_cmd,
        "commandString": " ".join(shlex.quote(part) for part in status_cmd),
        "exitCode": code,
    }
    if code == 0:
        payload["snapshot"] = filter_status(json.loads(out))
    else:
        payload["stderr"] = err
        payload["stdoutSample"] = out[:400]
    write_json(FIXTURE_DIR / f"status-snapshot-{host}.json", payload)

    serve_cmd = ["tailscale", "ssh", host, "tailscale", "serve", "get-config", "--all"]
    code, out, err = run(serve_cmd)
    write_json(FIXTURE_DIR / f"serve-config-all-{host}.json", envelope(serve_cmd, host, code, out, err))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--hosts",
        default="erebor,numenor,rivendell",
        help="Comma-separated tailnet hosts to capture via tailscale ssh",
    )
    args = parser.parse_args()

    capture_local()
    for host in [h.strip() for h in args.hosts.split(",") if h.strip()]:
        capture_remote(host)
    print(f"Captured fixtures in {FIXTURE_DIR}")


if __name__ == "__main__":
    main()
