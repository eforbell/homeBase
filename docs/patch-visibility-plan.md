# Patch Visibility Plan

Status: in progress (2026-10-22). Phase 1 of a broader patching-posture effort. Slices 1 and 2 (stream A collector and Status page section) merged in #5. Slice 3 (dependency inventory) is on `feat/dependency-inventory`.

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

1. **Inventory (executor, root, as `sovereign` for app files).** A read-only, per-app request, `dependency-inventory` (`executor/dependency-inventory.js`), reads one managed app's files with the no-follow small-file reader while assuming the `sovereign` identity. It returns `{ ecosystem, source, inventorySource, pinned, packages: [[name, version], ...], unpinned, drift, errors, floorFindings, note }`. It is per app because the protocol caps a response line at 64 KB (homeSource alone is about 5.5 KB). The web service reads Home Base's own root-owned `package-lock.json` itself. Parsers are pure functions (`src/operations/lockfiles.js`):
   - **npm:** `package-lock.json` v2/v3 `packages` map (v1 `dependencies` too), skipping `dev: true`, links, extraneous entries, and optional packages whose `os`, `cpu`, or `libc` excludes this host (glibc Linux on the host's architecture): npm lists every platform's `sharp-*` binaries but installs one.
   - **Python, what runs:** the virtualenv is always inventoried when it exists, from its `*.dist-info` directory names (no Python runs). A lockfile describes what a reinstall would bring back, not what is running: an app can be installed from an older lock, or upgraded in place.
   - **Python, the lockfile:** exact pins (`name==version`, extras, markers, and `--hash` continuations allowed), names normalized per PEP 503. `-r` includes are followed relative to the including file, confined to the checkout, read as `sovereign` without following symlinks, and bounded (depth 5, 20 files, cycles skipped). `-c` constraints and fetch options are ignored, and `-e .` is the app itself. Ranges, bare names, URLs, VCS editables, unreadable includes, and unrecognized options are unpinned or errors, so a lockfile Home Base cannot fully account for is never reported as pinned.
   - **Drift:** a locked package installed at another version, or missing, is reported separately ("Drift", with the reinstall hint). Packages installed but not locked (pip, setuptools) are not drift.
   - **No lockfile:** an app whose editable install resolves its own dependencies (bitcoin-accounting: `pip install -e .` without `--no-deps`) shows its venv, flagged unpinned: a reinstall may resolve different versions.
   - **"Pinned"** means exact versions are declared and installed. It never means "free of known vulnerabilities"; the UI says so.
2. **Advisory lookup (web service, unprivileged).** The web service sends the inventory to the [OSV](https://osv.dev) `querybatch` API, one ecosystem-agnostic source for npm and PyPI, then caches results in SQLite with a timestamp. It runs on a timer (default every 12 hours), and the operator can trigger it.
3. **Security floors (offline, always on).** `src/operations/security-floors.js` is a hand-reviewed table of minimum versions for incidents that need action on every host, dated like the runtime end-of-life table. Each app's installed packages and its lockfile are checked against it, so an incident is flagged while the advisory lookup is off, or before OSV has records for it. A finding below a floor outranks every other dependency state ("Below security floor"). First entries, from the [eMudhra/emSign CA incident](https://discuss.python.org/t/information-for-python-users-regarding-emudhra-emsign-ca-certificate-security-incident/109576) (2026-10-20): `certifi >= 2026.10.19` and `pip >= 26.2.2`.
   - pip below 26.2.2 always loads its own bundled CA list as well as the system store, so updating the host's `ca-certificates` does not fix it, and every virtualenv carries its own pip. The exception is a distribution build: Ubuntu 24.04's venv pip (24.0, from `python3-pip-whl`) is patched so its bundled certifi returns `/etc/ssl/certs/ca-certificates.crt`. The reader detects that patch by reading `pip/_vendor/certifi/core.py` (no Python runs) and keeps the finding as a note: that pip is exactly as safe as the host's CA store.
   - An app's own `certifi` (what `requests` uses) is upstream and ships its own bundle, so it is affected below 2026.10.19 regardless of the host.
4. **Result per app:** counts by severity, the fixed version when OSV knows one, and whether the fix is already on the app's upstream branch (using the existing ahead/behind check: "update available, fixes 2 high").

### Privacy decision

Sending the package inventory to OSV discloses which packages and versions this household runs (not hostnames, data, or credentials). That conflicts with the sovereign-home default, so the lookup is **off until the operator enables it** (`HOME_BASE_ADVISORY_LOOKUP=osv`), with the disclosure stated next to the switch. The inventory, lockfile freshness, and "unpinned" warnings work without it.

A future option is the offline OSV database (zip per ecosystem, refreshed by download) so only "fetch the database" leaves the host, not the inventory.

## Operator surface

`GET /api/homebase/foundation` serves the full report (summaries, package names, versions, units, PIDs, replaced-file paths) only to an unlocked admin session; together those map this host's patch gaps. Everyone else gets each check's level, and `?refresh=1` is honored only for admins, so an unauthenticated caller cannot trigger repeated apt simulations.

- **Status page, "Patch posture" section (done):** one entry per Stream A check (OK / WARN / ACTION / UNKNOWN, summary, next step), expandable lists of pending packages and stale units, and a Refresh button. It loads after the page renders because the apt simulation takes a few seconds. A stacked list rather than a table, so the next step stays visible at phone width. Stream B appears there only as Home Base's own lockfile plus a one-line roll-up linking to Apps.
- **Apps pages, per app (slice 3):** each app tile's status line gains "Deps: pinned / unpinned / no lockfile", with an "Inspect →" warning when it is not pinned. The app detail page has a Dependencies section (source, pinning, unpinned names, how to add a lockfile, and for admins the package list). Slice 4's vulnerability findings go in that same section. Both pages fetch the inventory separately, so a failure never blocks the rest of the page. `GET /api/apps/dependencies` returns `{ homebase, byAppId }`, like `/api/apps/health` and `/api/apps/updates`; the shared reading of an entry is `HB.dependencyStatus` in `public/api.js`.
- **Preflight (dropped):** the Patch posture section sits on the same page as the preflight table, so repeating its warnings there would only duplicate them. Preflight keeps gating installs on the Node.js floor alone.
- **Notifications:** the existing brrr notifier pushes once when a new critical/high finding appears, a unit goes stale, or a runtime enters its last 30 days of support. Same cooldown model as health alerts.

## Delivery slices

Each slice is mergeable and tested on its own (`node --test`, plus a VM run for anything touching the executor).

1. **Stream A collector (done):** `executor/foundation-status.js`, `foundation-status` protocol request, `foundationStatus` client call, `GET /api/homebase/foundation` (cached 5 minutes, `?refresh=1`; the executor caches 10 seconds, only to absorb bursts). `/usr/bin/apt-config` joined the executor allowlist for `apt-config dump`. Tests: `test/executor-foundation-status.test.js`. Each check returns `{ ok, level: ok|warn|fail|unknown, summary, ...details }`.
2. **Patch posture section on the Status page (done):** `public/settings.js`; route test in `test/server.test.js`.
3. **Lockfile parsers and `dependency-inventory` (done):** parsers tested against fixture lockfiles from familyDinner and helm; executor request; `GET /api/apps/dependencies` (installed apps plus Home Base, cached 10 minutes, `?refresh=1` for admins; without an unlocked admin session only per-app counts, source, and pinning, never package names or versions); the per-app indicators on the Apps pages described under Operator surface.
4. **OSV lookup:** opt-in setting, batching, SQLite cache, per-app findings in the UI.
5. **Notifications** for new findings, stale units, and approaching EOL.

## Prerequisites outside Home Base

Visibility is only as good as the lockfiles:
- **bitcoin-accounting:** commit a pinned lock (ideally hashed) instead of `pip install -e .` against unbounded ranges.
- **helm:** regenerate `requirements.lock` with hashes so a later phase can pass `--require-hashes`.
- **Every app repo:** Dependabot (or Renovate) plus `npm audit --omit=dev` / `pip-audit` in CI, so fixes arrive as lockfile PRs that the existing update flow then delivers.

## Later phases (not in this plan's scope)

Recorded here so the direction stays visible:
- **Phase 2, act:** a **trusted pip bootstrap** comes first. Today `ensure-venv` runs `python3 -m venv` and then uses that venv's pip to download every requirement over TLS; a pip whose CA trust is compromised must never be the tool that fetches its own replacement. Acceptance criteria: before any network install, the executor upgrades each venv's pip from a wheel whose SHA-256 is pinned in Home Base (shipped with the release, or fetched by URL and verified by hash before use), and refuses to run pip installs in a venv whose pip is below a security floor and not a distribution build that uses the host store. App installs then use `--require-hashes` where the lockfile has hashes (Phase 3). Then: an `apply-security-updates` executor action (backup, `apt-get update`, security + NodeSource upgrade, restart exactly the stale units, readiness check); optional managed unattended-upgrades config including the NodeSource origin; pip self-upgrade in venvs; a "rebuild dependencies" action that runs without a new commit; a supported Home Base upgrade path between release tags.
- **Phase 3, tighten:** hashed Python installs with `--require-hashes`; per-app `npm ci --ignore-scripts` where builds allow; per-app system users or a stricter app unit template (`ProtectSystem=strict`, `ReadWritePaths=`, `RestrictAddressFamilies=`); signed release checksums.

## End-to-end verification (container harness)

Run on a systemd Ubuntu 24.04 container (`docs/executor-app-runbook.md` section 8) after `install.sh --source-dir`, driving `GET /api/homebase/foundation` and the Status page:

- An older NodeSource `nodejs` shows as a pending update alongside a real `-security` update (liblzma5), and the pending check fails.
- Upgrading `nodejs` under the running services flags `homebase` and `homebase-executor` as running a replaced `/usr/bin/node`. A Node app unit (`family-dinner.service`) and a Python app unit (`helm-web.service`, replaced `/usr/bin/python3.12`) are flagged the same way, and restarting them clears the check.
- unattended-upgrades goes from not installed, to enabled without NodeSource (warn), to ok once the origin pattern is added.
- `/var/run/reboot-required` and its package list are shown.

## Host trust store

The host's own CA store is part of the foundation too: system TLS, the distribution pip, and Node.js with `--use-system-ca` all use it. On the container harness (Ubuntu 24.04, `ca-certificates 20260816ubuntu0.24.04.1`, 2026-10-22) the store still contains three emSign roots, and no update is published yet; Debian shipped one on 2026-10-20. When the distributions publish it, it comes through a security pocket and the existing pending-updates check flags it. A dedicated check (known-distrusted root fingerprints present in `/etc/ssl/certs`) is open: add it only with fingerprints from the distributions' or Mozilla's published removals, never guessed.

## Open questions

- Advisory source: OSV API (simple, discloses inventory) vs offline OSV database (private, ~hundreds of MB per ecosystem) vs both.
- Whether the stale-process check should also cover PostgreSQL and nginx, which apt upgrades usually restart themselves but not always.
- Timer cadence for the advisory lookup, and whether a lockfile change (new commit) should trigger an immediate re-check.
