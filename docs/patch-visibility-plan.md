# Patch Visibility Plan

Status: in progress (2026-10-22). Phase 1 of a broader patching-posture effort. Slices 1 and 2 (stream A collector and Status page section) are on `feat/foundation-status`, verified end to end in the container harness.

## Goal

Tell the operator, on the Status page, where the host and every managed app are behind on security fixes, without changing anything. Today Home Base hardens the install boundary well (signed NodeSource key, checksummed release, `npm ci --ignore-scripts` for its own code, typed root executor), but nothing after install tells anyone that Node, Python, OS packages, or app dependencies have fallen behind.

Visibility comes first because it is read-only, cannot break a host, and gives the later phases (applying updates) a measured baseline.

## The two patch streams

Patches reach a Sovereign Home host through two independent paths, and the operator needs a signal for each.

| | Stream A: runtimes and OS | Stream B: library dependencies |
|---|---|---|
| What | `nodejs` (NodeSource), `python3`, OpenSSL, libc, nginx, PostgreSQL, everything apt owns | npm packages in each `package-lock.json`; Python packages in each `requirements.lock` / venv |
| Fixed by | `apt upgrade` on the host | A new lockfile committed to the app (or Home Base) repo |
| Delivered by | apt, then a **restart** of every process using the old binary/library | App update (executor `install` re-runs `npm ci` / pip) or `install.sh --source-dir <checkout> --repair` for Home Base |
| Today | Nothing configures, checks, or reports it. `package.ensure` only installs missing packages; NodeSource is outside Ubuntu's default unattended-upgrades origins | Only "commits behind" from `app-update-monitor`; no vulnerability signal |

## Stream A: host foundation checks

A new read-only executor request, `foundation-status`, beside `host-status`. Like `executor/host-status.js` it takes no caller input: every command and path is fixed in the collector. It runs as root because several facts (other units' `/proc/<pid>` entries, apt state) are not visible to the sandboxed web service.

| Check | Source | Signal |
|---|---|---|
| Node.js version and line | `dpkg-query` version of `nodejs` (the executor's own `process.versions.node` when Node is unpackaged); bundled release-line table (EOL dates, reviewed each release) | Version; days to EOL; warn under 90 days, fail past EOL |
| Node.js origin | `dpkg-query` version of `nodejs` (`…nodesource…` suffix) | NodeSource vs distribution; NodeSource line vs `NODE_PROVISION_MAJOR` |
| Python version | `dpkg-query` version of `python3` (the executor never runs `python3` as root) | Version; EOL from the same bundled table |
| Pending updates | `apt-get -s -o Debug::NoLocking=1 dist-upgrade` (simulation, no lock) | Total count; count from `-security` pockets; whether `nodejs` is among them |
| Package-list freshness | Overall: newest of `/var/lib/apt/periodic/update-success-stamp` and the `/var/lib/apt/lists/*_InRelease` mtimes. Per source: each list's mtime | Warn if nothing was refreshed in 7 days, or if a security pocket's list is older than 7 days or NodeSource's older than 45: that source has stopped being fetched even though others are fresh. apt dates each list by the repository's own publication time (Last-Modified), not by the fetch, so only sources that publish often are judged; a frozen release pocket (Ubuntu's `noble`, dated April 2024) is listed but never flags |
| Automatic updates | `apt-config dump` (`APT::Periodic::Unattended-Upgrade`, `Unattended-Upgrade::Origins-Pattern` / `Allowed-Origins`); `dpkg-query` for `unattended-upgrades` | Enabled or not; whether the NodeSource origin is allowed |
| Reboot required | `/var/run/reboot-required`, `/var/run/reboot-required.pkgs` | Kernel/libc updates waiting on a reboot |
| Stale processes | For `homebase`, `homebase-executor`, and every managed app/sidecar unit: `systemctl show -p MainPID`, then `/proc/<pid>/exe` and `/proc/<pid>/maps` for `(deleted)` entries | Units still running a replaced `node`/`python3` binary or shared library: patched on disk, not in memory |

Notes:
- `apt-get update` is **not** run by this check (that is a host mutation and a network call). Freshness is reported instead; refreshing lists belongs to Phase 2.
- The stale-process check is the most valuable single signal: it is the gap between "apt installed the fix" and "the fix is live".
- The bundled EOL table lives in `src/operations/runtime-lifecycle.js` with its review date, so a stale table is itself visible.
- **OK needs positive evidence.** A failed probe reports `unknown`, never a fallback that looks healthy: a failed `dpkg-query` leaves Node.js unknown (only a Node.js dpkg reports *absent* falls back to the executor's own version), and a unit whose `/proc` entries cannot be read (anything but the process having exited) leaves the stale-process check unknown, as does inspecting zero units.
- Every check that is not ok carries a `hint`: the next step, as a copyable command where there is one.
- NodeSource's Release file says `Origin: . nodistro`, so the unattended-upgrades pattern is `Unattended-Upgrade::Origins-Pattern:: "origin=. nodistro";`. Verified in the container harness: with it, `unattended-upgrade --dry-run` upgrades `nodejs`; without it, `nodejs` is held at its installed version.

## Stream B: dependency vulnerability checks

Split by privilege so no root process talks to an advisory service:

1. **Inventory (executor, root, as `sovereign` for app files).** A new read-only request, `dependency-inventory`, reads each managed app's lockfile with the existing no-follow small-file reader, plus Home Base's own `package-lock.json`. It returns a normalized list of `{ ecosystem, name, version }` per app, nothing else. Parsers are pure functions (`src/operations/lockfiles.js`):
   - npm: `package-lock.json` v2/v3 `packages` map, skipping `dev: true` entries (installs use `--omit=dev`).
   - Python: `requirements.lock` exact pins (`name==version`). Apps without a lock (bitcoin-accounting today) fall back to `pip list --format=json` from the venv, flagged as "unpinned: installed versions, not reproducible".
2. **Advisory lookup (web service, unprivileged).** The web service sends the inventory to the [OSV](https://osv.dev) `querybatch` API, one ecosystem-agnostic source for npm and PyPI, then caches results in SQLite with a timestamp. It runs on a timer (default every 12 hours), and the operator can trigger it.
3. **Result per app:** counts by severity, the fixed version when OSV knows one, and whether the fix is already on the app's upstream branch (using the existing ahead/behind check: "update available, fixes 2 high").

### Privacy decision

Sending the package inventory to OSV discloses which packages and versions this household runs (not hostnames, data, or credentials). That conflicts with the sovereign-home default, so the lookup is **off until the operator enables it** (`HOME_BASE_ADVISORY_LOOKUP=osv`), with the disclosure stated next to the switch. The inventory, lockfile freshness, and "unpinned" warnings work without it.

A future option is the offline OSV database (zip per ecosystem, refreshed by download) so only "fetch the database" leaves the host, not the inventory.

## Operator surface

`GET /api/homebase/foundation` serves the full report (summaries, package names, versions, units, PIDs, replaced-file paths) only to an unlocked admin session; together those map this host's patch gaps. Everyone else gets each check's level, and `?refresh=1` is honored only for admins, so an unauthenticated caller cannot trigger repeated apt simulations.

- **Status page, "Patch posture" section (done):** one entry per Stream A check (OK / WARN / ACTION / UNKNOWN, summary, next step), expandable lists of pending packages and stale units, and a Refresh button. It loads after the page renders because the apt simulation takes a few seconds. A stacked list rather than a table, so the next step stays visible at phone width. The Stream B summary ("3 apps with known vulnerabilities; 1 unpinned") joins it in slice 4.
- **App detail page:** dependency findings for that app next to the existing update badge.
- **Preflight (dropped):** the Patch posture section sits on the same page as the preflight table, so repeating its warnings there would only duplicate them. Preflight keeps gating installs on the Node.js floor alone.
- **Notifications:** the existing brrr notifier pushes once when a new critical/high finding appears, a unit goes stale, or a runtime enters its last 30 days of support. Same cooldown model as health alerts.

## Delivery slices

Each slice is mergeable and tested on its own (`node --test`, plus a VM run for anything touching the executor).

1. **Stream A collector (done):** `executor/foundation-status.js`, `foundation-status` protocol request, `foundationStatus` client call, `GET /api/homebase/foundation` (cached 5 minutes, `?refresh=1`; the executor caches 10 seconds, only to absorb bursts). `/usr/bin/apt-config` joined the executor allowlist for `apt-config dump`. Tests: `test/executor-foundation-status.test.js`. Each check returns `{ ok, level: ok|warn|fail|unknown, summary, ...details }`.
2. **Patch posture section on the Status page (done):** `public/settings.js`; route test in `test/server.test.js`.
3. **Lockfile parsers and `dependency-inventory`:** pure parsers with fixture lockfiles from the real apps; executor request.
4. **OSV lookup:** opt-in setting, batching, SQLite cache, per-app findings in the UI.
5. **Notifications** for new findings, stale units, and approaching EOL.

## Prerequisites outside Home Base

Visibility is only as good as the lockfiles:
- **bitcoin-accounting:** commit a pinned lock (ideally hashed) instead of `pip install -e .` against unbounded ranges.
- **helm:** regenerate `requirements.lock` with hashes so a later phase can pass `--require-hashes`.
- **Every app repo:** Dependabot (or Renovate) plus `npm audit --omit=dev` / `pip-audit` in CI, so fixes arrive as lockfile PRs that the existing update flow then delivers.

## Later phases (not in this plan's scope)

Recorded here so the direction stays visible:
- **Phase 2, act:** an `apply-security-updates` executor action (backup, `apt-get update`, security + NodeSource upgrade, restart exactly the stale units, readiness check); optional managed unattended-upgrades config including the NodeSource origin; pip self-upgrade in venvs; a "rebuild dependencies" action that runs without a new commit; a supported Home Base upgrade path between release tags.
- **Phase 3, tighten:** hashed Python installs with `--require-hashes`; per-app `npm ci --ignore-scripts` where builds allow; per-app system users or a stricter app unit template (`ProtectSystem=strict`, `ReadWritePaths=`, `RestrictAddressFamilies=`); signed release checksums.

## End-to-end verification (container harness)

Run on a systemd Ubuntu 24.04 container (`docs/executor-app-runbook.md` section 8) after `install.sh --source-dir`, driving `GET /api/homebase/foundation` and the Status page:

- An older NodeSource `nodejs` shows as a pending update alongside a real `-security` update (liblzma5), and the pending check fails.
- Upgrading `nodejs` under the running services flags `homebase` and `homebase-executor` as running a replaced `/usr/bin/node`. A Node app unit (`family-dinner.service`) and a Python app unit (`helm-web.service`, replaced `/usr/bin/python3.12`) are flagged the same way, and restarting them clears the check.
- unattended-upgrades goes from not installed, to enabled without NodeSource (warn), to ok once the origin pattern is added.
- `/var/run/reboot-required` and its package list are shown.

## Open questions

- Advisory source: OSV API (simple, discloses inventory) vs offline OSV database (private, ~hundreds of MB per ecosystem) vs both.
- Whether the stale-process check should also cover PostgreSQL and nginx, which apt upgrades usually restart themselves but not always.
- Timer cadence for the advisory lookup, and whether a lockfile change (new commit) should trigger an immediate re-check.
