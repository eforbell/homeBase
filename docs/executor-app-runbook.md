# Executor App Runbook

A checklist for moving a catalog app, or a new lifecycle action, onto the root executor. It records the rules that past reviews and VM runs actually enforced. Work through it top to bottom. Each section ends with the evidence that must exist before moving on.

Companion documents: `docs/root-executor-implementation-plan.md` (why the executor exists), `SECURITY.md` (the privilege boundary), and `docs/ubuntu-dinner-executor-vm-test.md` (the VM gate).

## 0. How the pieces fit

```
browser ──► homebase.service (unprivileged, NoNewPrivileges)
              │  names an action: { action, appId, ref, transport, site }
              ▼
        /run/homebase/executor.sock  (root:homebase-exec 0660, protocol v2)
              ▼
        homebase-executor (root)
          executor/actions.js      action ──► compiler ──► plan (+ schema/policy re-check)
          src/operations/compilers  catalog entry ──► closed set of typed operations
          executor/handlers.js     one root primitive per operation type
          src/operations/env.js    .env render + reinstall contract (shared with legacy)
```

The web process never sends plans, operations, paths, commands, or secrets. The executor compiles every plan from the root-owned catalog and generates its own secrets. It streams `plan.accepted` (plan and digest) so the job records exactly what ran.

## 1. Non-negotiable rules

Run through these on every change. Each one has already been violated once and caught.

- [ ] **Callers name actions, never operations.** New inputs go into `normalizeAction` as enums or strict patterns (catalog id, `main`/SHA, `https`/`ssh`, `isValidSite`), and nowhere else.
- [ ] **Root never interprets a sovereign-controlled path by name.**
  - Directories: `lstat`, then `open(O_DIRECTORY|O_NOFOLLOW)`, then `fchown`/`fchmod` (`filesystem.ensure-directory`).
  - Files inside sovereign-owned directories: read and write inside `runAsUser(sovereign, ...)`, synchronous calls only.
  - Root-owned destinations: `writeFileAtomic` (random temp name, `fchmod`, `fsync`, rename).
- [ ] **Root never runs git in a sovereign-owned repository.** Its config (`core.fsmonitor`, hooks) executes code. Root works only in the root-owned mirror (`/var/lib/sovereign-home/git-mirrors/`) with `ROOT_GIT_CONFIG`. Sovereign reaches the mirror through `GIT_CONFIG_SYSTEM=/etc/sovereign-home/sovereign.gitconfig`.
- [ ] **Untrusted code runs as `sovereign`, never root:** npm/pip installs, migrations, app scripts.
- [ ] **No `EnvironmentFile=` pointing into app directories.** systemd reads it as root before switching to `User=`. The app must load `.env` itself (see 3.1).
- [ ] **Secrets never cross the socket or enter argv or env.** They are generated in `executor/actions.js` (`SECRET_GENERATORS`), reused on reinstall, and delivered through stdin or files written as the owner. Output is redacted in `execute.js`/`spawn.js`.
- [ ] **Shared state keeps its owner.** `/opt/sovereign-home` stays root-owned (it holds the executor's code); only `apps/` belongs to sovereign.
- [ ] **Fail closed and say why.** Unknown field → `INVALID_REQUEST`. Not allowed → `POLICY_DENIED` with operator guidance. Never fall back to legacy shell execution (`rejectLegacyExecution`).
- [ ] **Don't re-harden the executor unit.** `NoNewPrivileges`, `RestrictSUIDSGID`, `ProtectHome` and a strict `UMask` break apt/dpkg and buy nothing for a process that starts units (see `SECURITY.md`).

## Shape support matrix

`src/operations/app-layout.js` decides what the executor can compile. It refuses anything else with a specific reason, never half-compiling an app. Keep this table in sync with it.

| Shape | Supported | Notes |
|---|---|---|
| Node runtime, `npm ci --omit=dev` | yes | |
| Commands `node <script.js> [--flags]`, `npm run <script>` | yes | parsed to fixed argv; anything else is refused |
| Postgres database | yes | simple identifiers, not `postgres`/`template*`/`pg_*`, and unique across the catalog |
| apt `systemPackages` | yes | allowed per app on top of the bootstrap baseline |
| Storage at exactly `/var/lib/sovereign-home/<app id>/<name>` (`storage.absoluteRoot`) | yes | root-owned `<app id>` parent, sovereign `0750` leaf and sub-paths |
| Unit names | yes | main service, sidecars, and timers must be the app id or start with `<app id>-`, and be unique |
| Sidecars without nginx | yes | extra `.service` with catalog `Environment=` values (simple tokens only) |
| Timers (`onCalendar`, `onBootSec`, `onUnitActiveSec`, `randomizedDelaySec`) | yes | oneshot service + timer |
| Upload limit (`network.clientMaxBodySize`, e.g. `55M`) | yes | rendered as `client_max_body_size` |
| Storage inside the install root (`storage.paths` without `absoluteRoot`) | **no** | family-help, home-ops, helm (`.secrets`: Schwab OAuth tokens) |
| Sidecars published through nginx | **no** | bug-base |
| Env referencing sidecar ports (`{{sidecar.<name>.port}}`) | **no** | family-pulse, bug-base: ports must be reserved in the catalog before the executor allocates them |
| Python runtime / venv | **no** | helm, bitcoin-accounting (see [Python apps and adopting legacy installs](#python-apps-and-adopting-legacy-installs)) |
| Database bootstrap from a SQL file (`database.bootstrap: schema-file`) | **no** | bitcoin-accounting |
| Custom nginx proxying (`preserveMountPath`, `upstreamPath`, extra headers) | **no** | the Python apps |
| SQLite databases | **won't do** | bitcoin-accounting is Postgres-only under Home Base (decision 2026-09-24); drop its SQLite path when Python lands |

An app is installable only when it compiles **and** appears in `INSTALLABLE_APPS` (`executor/actions.js`) after passing this runbook. Today that's family-dinner and home-source.

## 2. Survey the app

Fill this in before writing code. Record the answers in the PR description.

| Question | Where to look | Why it matters |
|---|---|---|
| Runtime kind and install command | `catalog.runtime` | Node (`npm ci --omit=dev`) exists. Python/venv needs new closed task types |
| Start command and every other entry point (sidecars, timers, migrate) | `catalog.runtime/sidecars/timers/database.migrationCommand` | Each becomes a structured argv in a unit template, never a shell string |
| Does **every** entry point load `.env` itself (dotenv or equivalent)? | the app repo: `server.js`, `bin/*`, `db/migrate.js` | Executor units have no `EnvironmentFile=`. If not, fix the app first |
| Readiness endpoint | `catalog.network.health.readinessPath` | "Installed" is recorded only after readiness passes |
| apt packages | `catalog.systemPackages` | Must be added to the package policy allowlist explicitly |
| Database: engine, name, user, `urlEnvKey`, SQLite option | `catalog.database` | Role/database ops are per-app policy, and DB wiring is reused on reinstall |
| Storage roots and sub-paths | `catalog.storage` | Sovereign-owned `0750` directories under root-owned parents; also in backup/restore scope |
| Sidecars (ports, nginx) and timers (schedules) | `catalog.sidecars/timers` | More units, snippets, and ports |
| Env placeholders used | `templatePlaceholders(app.config.env)` | Every one must resolve in strict mode (see 4) |
| `preserveExistingKeys` | `catalog.config` | Part of the reinstall contract |
| nginx needs (body size, extra headers, preserved mount path) | `catalog.network.notes`, sidecar `nginx` | Snippet template parameters. **A requirement that only appears in `notes` is not implemented anywhere.** Turn it into a structured field (as with `clientMaxBodySize`) and render it in both the executor and legacy snippets |

Evidence: a completed survey table.

## 3. App-side prerequisites

1. **Env loading.** Every entry point loads `.env` from its working directory. Dinner and homeSource do this with `require('dotenv').config()` on line 1.
2. **Readiness** returns non-2xx until the database is reachable and migrations have run.
3. **Migrations** are idempotent and runnable repeatedly as the app user.

Evidence: grep output (or a code reference) for each entry point.

## 4. Environment files (`src/operations/env.js`)

Reinstall contract (verbatim from the module header). An existing non-empty value **survives** when:
1. the key is in `config.preserveExistingKeys`
2. the catalog default is `''` (operator-supplied)
3. the default is a generated secret (`{{secret1}}`..`{{secret3}}`)
4. it is database wiring (`DATABASE_URL`, `PG*`, `DB_BACKEND`, `SQLITE_DB_PATH`)
5. the key name looks sensitive (`SECRET|TOKEN|PASSWORD|PASSPHRASE|API_KEY|CLIENT_ID|AUTH_`)
6. the key is not in the template (operator-added)

Everything else is **re-derived on every install**, so hostname, port, mount and timezone changes propagate.

Executor-specific rules:
- Render with `strict: true`. An unresolved placeholder refuses the install (`ENV_TEMPLATE_UNRESOLVED`); it never writes `''`.
- The context must provide every placeholder the app uses. Site values (`hostname`, `domain`, `householdTimezone`) arrive in the action and ride inside the plan's `app-env` step, where policy validates them (`isValidSite`).
- The runtime environment (`NODE_ENV`, or `PYTHONUNBUFFERED` for Python) is written into `.env`, because executor units set no `Environment=`.
- Database passwords are reused from existing wiring (`readExisting…Password` via `resolveExistingDbContext`). Wiring for a different role or database is refused, not overwritten.
- `{{secretN}}` values are generated fresh each render as *candidates*; rule 3 keeps existing ones.

Checklist:
- [ ] Add the app's placeholders to the executor context builder (`buildEnvContext`) if any are new.
- [ ] Extend `test/env-parity.test.js` with an executor-vs-legacy case for the app: fresh install and reinstall-with-edits, with outputs equal to legacy plus the runtime env.
- [ ] If legacy behavior is intentionally changed, regenerate `test/fixtures/env/legacy-golden.json` in its own reviewed commit and explain why.

Evidence: parity tests green.

## 5. Compiler, schema, and policy

1. **Compiler** (`src/operations/compilers/`): map the catalog entry to the existing closed operation types. Prefer parameterizing an existing operation by catalog-derived values over adding a new operation type.
2. **Schema** (`schemas/homebase-operation-plan-v1.schema.json`): every new field is an enum or a strict pattern, with `additionalProperties: false`.
3. **Policy** (`src/operations/policy.js`): bind each value to the catalog entry (repository, destination, unit names, ports, packages, database/role). Schema proves shape; policy proves authority.
4. **Units and snippets** are rendered from structured catalog fields inside the executor, never from caller data. `execStart` becomes a fixed argv under the app root.
5. **Installable list:** add the app to `INSTALLABLE_APPS` (`executor/actions.js`) only when everything above is true.

Evidence: `plan-action` output for the app, reviewed operation by operation.

## 6. Handlers (root primitives)

For each new or changed handler:
- [ ] Inputs come only from the validated operation. Paths are derived, never taken from the operation.
- [ ] Binaries are in `spawn.js` `ALLOWED_BINARIES`, with fixed argv and `shell: false`. Env keys are in `ALLOWED_ENV_KEYS`, with values built from fixed strings.
- [ ] Ownership changes follow section 1 (fd-based, or `runAsUser`).
- [ ] Idempotent, so a second run is a no-op or a verified reconciliation.
- [ ] Destructive operations (`risk: destructive`) need the destructive-action policy: a verified backup first, explicit confirmation, and backups kept on uninstall.
- [ ] Unit tests with `test/fixtures/fake-fs.js`, including a symlink-swap or race case where ownership is involved.

## 7. Web wiring

- [ ] The route checks `capabilities.installableApps` (or the relevant action capability) and returns 409 `TYPED_EXECUTION_NOT_SUPPORTED` otherwise.
- [ ] The job runner uses `startTypedActionJob`. "Installed" or "done" is recorded only in `afterExecution`, after readiness.
- [ ] Update checks work through `app-update-status` (catalog `repoKey` gives mirror and checkout paths).
- [ ] Legacy sudo routes for the action stay refused in executor mode.

## 8. Verification

1. `npm test` is green, and `node --test test/env-parity.test.js` is green.
2. **Container harness** (fresh systemd Ubuntu 24.04, about 3 minutes):
   ```bash
   # image: ubuntu:24.04 + systemd systemd-sysv dbus curl git ca-certificates python3 sudo openssh-client
   docker run -d --name hbvm --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
     --tmpfs /run --tmpfs /run/lock homebase-vm:24.04
   # copy a snapshot of the checkout in (COPYFILE_DISABLE=1 tar ...), commit it inside, then:
   bash install.sh --source-dir /src/homeBase
   # private repos: point the catalog HTTPS URL at a local bare copy, container-only
   git config --system url."file:///srv/<repo>.git".insteadOf https://github.com/eforbell/<repo>.git
   ```
   Drive the **web API**, not the socket: `POST /api/admin/setup`, then `POST /api/bootstrap/execute`, then `POST /api/apps/<id>/execute`, each with `{dryRun:false, confirm:'EXECUTE'}`. Then check:
   - the job completes, and `planJson.digestVerified` is true
   - readiness passes directly and through `https://127.0.0.1/<mount>/` (nginx gateway)
   - every unit runs as `sovereign` (`ps -o user= -C node`)
   - a reinstall keeps operator `.env` edits and the DB password, and re-derives derived keys
   - no generated secret appears in `home-base.sqlite3` or `journalctl -u homebase -u homebase-executor`
   - update status goes up-to-date, then behind 1 after an upstream push, then up-to-date after reinstalling
3. **Independent security review** of the diff (a separate reviewer, never self-approval), with findings fixed or explicitly deferred.
4. **VM gate** on the operator's host (`docs/ubuntu-dinner-executor-vm-test.md`).

## 9. Commit and ship

- Lore trailers: `Constraint`, `Rejected`, `Confidence`, `Scope-risk`, `Tested`, `Not-tested`.
- Refresh hosts with `install.sh --repair` (not `--repair-executor`, because the executor loads `src/`).
- Protocol changes bump `PROTOCOL_VERSION` together with the installer probe and `isProtocolCompatible`.

## Lessons from homeSource (the first multi-shape app)

- **Test real behavior, not just readiness.** homeSource passed readiness while every upload over 1 MB was rejected by nginx (413). The limit existed only as a catalog note. Exercise the app's main job (upload, send, import) through the gateway.
- **Reinstall is its own test.** The first reinstall surfaced a port guard that treated the app's own port as a conflict. Always run a second install with operator edits.
- **Executor installs pin the catalog port.** Only a *different* app holding the port is a conflict (`PORT_CONFLICT`). The legacy planner instead counts the app's own port as taken on reinstall and picks the next one.
- **Check every entry point loads `.env`**: server, sidecars, timer scripts, migrations. homeSource's five did.

## Lifecycle actions and recovery

- **Actions:** install (update = install again), restart, backup, restore, uninstall. Every one compiles from the catalog layout (`src/operations/compilers/lifecycle.js`), and dry-runs preview the executor's plan (`plan-action`).
- **Destructive operations** (`backup.restore`, `postgres.drop-database`, `filesystem.remove-*`, stopping units) must declare `risk: "destructive"` and are allowed only in the restore and uninstall profiles.
- **Restore order:** `backup.verify` (archive exists, database-backed apps have a dump, `pg_restore --list` and `tar -tzf` integrity reads), then a safety backup, then stop, restore, start, and readiness. Nothing stops until the source is proven usable. A dump-less archive is refused, never partially restored.
- **Backup records** are written the moment each `backup.create` step completes, so a safety backup stays in the inventory even if the rest of the action fails. Uninstall keeps records when it keeps backups.
- **Reconciliation:** the executor journals every accepted action (`/var/lib/homebase-executor/jobs/<jobId>.json`, root-only, last 200). If Home Base loses the connection after acceptance, or restarts mid-job, it asks `action-status` for the real outcome and settles the job through the same code path as a live job. An executor restart marks in-flight entries `interrupted`, and the job fails with re-run guidance (steps are idempotent).
- **Operator recovery** when a job looks wrong: `sudo cat /var/lib/homebase-executor/jobs/<jobId>.json` shows the accepted plan, completed steps, and error. `journalctl -u homebase-executor` has the step output.
- **Re-running after an interruption:**
  - **Install, restart, backup:** re-run; every step is idempotent.
  - **Restore:** re-run. It verifies the source again, takes a new safety backup of the current (possibly half-restored) state, and restores again. The earlier safety backup stays in the inventory.
  - **Uninstall:** re-run. Its safety backup covers *what remains*: it checks whether the database still exists (and dumps it if so) and backs up whatever `.env` and storage are left, so an uninstall interrupted after dropping the database or removing the checkout completes on the next run. Every removal step tolerates already-removed parts.
  - The executor refuses a new job only while another is running (`EXECUTOR_BUSY`) or a repair holds the maintenance flag (`EXECUTOR_MAINTENANCE`); Home Base waits and retries both.

## Python apps and adopting legacy installs

This is the next milestone, and it is what retires legacy-sudo mode. **Both production hosts need it:** erebor runs helm and numenor runs bitcoin-accounting, and both are Python. The execution mode is set per host, not per app, so a host moves to the executor only when **every** app on it compiles. For both hosts that means Python support **and** `adopt` must be finished first. Legacy install plans are frozen (fixes only, owner decision 2026-09-25); route any new install-plan work here instead.

Suggested order:
1. Python runtime support.
2. Storage inside the install root (helm).
3. Schema-file bootstrap (bitcoin-accounting).
4. Proxying that keeps the mount path.
5. `adopt`: test it in the container harness against a host built with legacy mode from `main`, then adopt erebor, then numenor.

### Python runtime (`runtime/python.js`)

Legacy behavior (`src/services/install-planner.js`), which is what production has today:
- `python3 -m venv .venv`, then `pip install --upgrade pip`, then the catalog `runtime.installCommand`, all as `sovereign` through `sudo -u`.
- Units run `runtime.startCommand` with `.venv/bin/...` expanded against the install root. They set `EnvironmentFile=<installRoot>/.env`, and `PYTHONUNBUFFERED=1` comes from the unit.

Executor requirements:
- **Replace `runtime.installCommand` with typed catalog fields.** A shell string can't be checked by policy. Suggested operations:
  - `python.ensure-venv` (interpreter: the system `python3`; venv path fixed at `.venv` inside the install root)
  - `python.pip-install` with either `requirements: <lockfile>` or `editable: true` plus `noDeps`
  - create in-root storage directories through the storage operations, not a shell `install -d`

  All of these run as `sovereign` through `spawn.js`; add `python3` and the venv's `python` to its allowlist, with the venv path checked against the install root.
- **`PYTHONUNBUFFERED=1` goes into `.env`,** because executor units set no `Environment=` (see section 4). Both apps call `load_dotenv` (helm in `schwab_helm/config.py`, bitcoin-accounting in `db/__init__.py`). Check that each one finds the install-root `.env` from the unit's `WorkingDirectory`, and for bitcoin-accounting check that the web entry point imports `db` before it reads config.
- **Installs download from PyPI.** Add a preflight or plan check for outbound HTTPS, with a clear error; don't let pip time out on its own. Pin with lockfiles: helm installs from `requirements.lock`, but bitcoin-accounting runs a bare `pip install -e .`, so a reinstall can pick up different dependency versions. Add a lockfile to bitcoin-accounting (app-side prerequisite, section 3) before its executor install.
- **Rebuild venvs; never repair them in place.** A venv is tied to the interpreter that created it. After an OS Python upgrade, create a new venv next to the old one, install into it, pass the readiness check, then swap. The same code serves `adopt` and updates.

### Helm (erebor)

- **Storage inside the install root: `.secrets`** holds the Schwab OAuth tokens. Losing it means re-authorizing with Schwab, which has no sandbox. Requirements:
  - Directory 0700, owned by `sovereign`. The main unit keeps `UMask=0077` (`service.umask`), and timers that write tokens (`helm-token-refresh`) need the same umask.
  - Backups include it, and restores bring it back at 0700. The legacy backup already archives in-root storage paths (`backup-planner.js`, relative to the install root); keep that archive name (`.secrets.tgz`) so both modes read each other's backups.
  - Uninstall's safety backup must include it. A removed checkout takes in-root storage with it, unlike `storage.absoluteRoot`. Tell the operator so on the uninstall screen.
  - Longer term, consider moving it to `storage.absoluteRoot` (`/var/lib/sovereign-home/helm/secrets`). That changes helm's config and needs a one-time move, so do it as its own step, not inside `adopt`.
- **Five timers, with their calendars carried over exactly:**
  - `helm-sync` pins `America/New_York`.
  - `helm-monitor` is `persistent: false` on purpose, so a missed market-hours slot is not run late.
  - Timer execs are `.venv/bin/helm ...`, which run inside the install root.
- **Migrations:** `.venv/bin/python migrations/run_migration.py`, run as `sovereign` with the app's DB credentials. They must not need the database owner beyond the app role.
- **nginx keeps the mount path** (`preserveMountPath: true`, `/helm/`). Helm expects `HELM_WEB_BASE_PATH=/helm`. The Schwab OAuth callback may need a dedicated HTTPS route (see the catalog notes). Record what erebor serves today before changing the nginx renderer.

### bitcoin-accounting (numenor)

- **Postgres only** (decision 2026-09-24). Before adopting, confirm numenor's `.env` points at Postgres. If it has ever used SQLite, migrate that data first. Remove the SQLite option from the catalog (`engine: postgres-or-sqlite` becomes `postgres`) in the same change as Python support.
- **The schema file is not idempotent, and legacy runs it as `postgres`.** Legacy runs `psql -d bitcoin_accounting -f src/sql/tables.sql` through `sudo -u postgres` on **every** install and update:
  - The file uses plain `CREATE TABLE` without `ON_ERROR_STOP`, so re-runs print errors and still exit 0.
  - Its `GRANT` statements give `bitcoin_accountant` only DML on tables it does not own.

  Consequences on a legacy host:
  - The tables are probably owned by `postgres`. Check on numenor with `\dt` in `psql`.
  - The executor's restore runs `pg_restore` as the **app role** and can't drop or recreate tables it doesn't own.
  - `migrations/001_add_soft_delete_columns.sql` says it must run as the table owner, and it is not wired into `migrationCommand`.

  Executor requirements:
  - Run the schema only on an **empty** database (check with `psql` as `postgres`, read-only, like uninstall's `whatRemains` check), with `ON_ERROR_STOP=1`, as the app role, so the app role owns its tables.
  - `adopt` needs a typed `postgres.transfer-ownership` step: run as `postgres`, reassign the app database's tables, sequences and views to the app role, and refuse if the database has objects outside `public`.
  - App side (section 3): make `tables.sql` idempotent, and add 001 (and future migrations) to `migrationCommand` so they run as the app role once it owns the tables.
- **Mount-path contradiction in the catalog.** `network.preserveMountPath: true`, but the catalog note says "reverse proxy must strip the external subpath". Check what numenor serves today (`/etc/nginx/...snippets/bitcoin-accounting.conf`) and fix the catalog to match before the executor renders it.
- Readiness is `/api/ready`, liveness `/api/health`. `bitcoin-accounting-web-init` is a startup check (`SELECT 1` plus a backend check), not a migration runner, despite being the `migrationCommand`.

### The `adopt` action

`adopt` takes over an app that legacy-sudo installed, without reinstalling it or changing its data. It is a destructive-profile action (`app-adopt-v1`): it rewrites units and may change database ownership.

What differs on a legacy install:

| Legacy state | Executor state | `adopt` step |
|---|---|---|
| Units set `EnvironmentFile=<installRoot>/.env` (read by root-run systemd) | No `EnvironmentFile=`; the app loads `.env` | Rewrite units from the catalog layout. Check the app actually loads `.env` itself first; if not, it's an app-side prerequisite |
| `.env` written by the legacy planner | Rendered through `env.js` with existing values reused | Re-render through `env.js` in strict mode. The golden snapshots guarantee the same output; any difference is a bug, so refuse and show it |
| Checkout cloned by `sovereign` from the origin URL | Checkout fetched from the root-owned mirror under `/var/lib/sovereign-home/git-mirrors` | Create the mirror at the checkout's current commit and repoint the checkout's remote. Don't re-clone: the checkout holds in-root storage (helm `.secrets`) |
| Checkout and venv ownership unchecked | `sovereign` owns the checkout; root never follows links into it | Verify (don't `chown -R` as root) that everything is owned by `sovereign`; refuse on anything else, including symlinks that leave the install root |
| DB tables may be owned by `postgres` (bitcoin-accounting) | App role owns its objects | `postgres.transfer-ownership` |
| nginx snippet from the legacy renderer | Managed snippet from the executor renderer | Render, `nginx -t`, reload (existing operations) |
| Legacy venv, of unknown interpreter version | Venv built by the executor | Build a new venv as `sovereign`, then swap. Keep the old venv until readiness passes |

Plan order:
1. `backup.create`, the safety backup, covering in-root storage.
2. Build the new venv and mirror. This is read-only as far as the running app is concerned.
3. Stop the units.
4. Rewrite the units and `.env`, then transfer ownership.
5. `daemon-reload`, then start the units.
6. Wait for readiness.
7. Remove the old venv.

**Failure and rollback.** If readiness fails, restore the previous units, `.env` and venv from the safety state and restart. Record in the journal which steps completed, so that re-running `adopt` is safe (as with uninstall's resumability). Ownership transfer is the one step that isn't reversed; it is harmless for legacy mode, because the app role still has its grants.

**Switching the host.** Only after every app on the host has been adopted:
1. Run `install.sh` to add the executor. This is the trust bootstrap; the UI can't do it.
2. Set `HOME_BASE_EXECUTION_MODE=executor` in the unit's `EnvironmentFile`. Remember that Home Base does not read a checkout `.env`.
3. Restart Home Base.
4. Remove the legacy sudoers entry.

Until the mode is switched, `adopt` runs through the executor on a host that is still in legacy mode. So either allow `adopt` in legacy mode as the only executor action, or run adoption with the host in executor mode for all apps at once. Decide and record which before building it; the first is gentler on production.

**Verification before production:**
- In the container harness, build a host in legacy mode from the last legacy-capable `main`, with helm and bitcoin-accounting (fake Schwab credentials; a `.secrets` sentinel file).
- Adopt, then check that `.env` is byte-identical, the `.secrets` sentinel is intact, the timers are listed with the same calendars, and the tables are owned by the app role.
- Back up, restore and uninstall through the executor.
- Interrupt `adopt` at each step and re-run it.

## Architecture roadmap (from the independent architecture review, 2026-09-25)

The design was approved with conditions; the conditions (early-disconnect reconciliation, atomic repair quiescing, resumable uninstall, the production upgrade step) are met. These are the agreed follow-ups, in priority order:

1. **Retire legacy-sudo mode.** Freeze it (fixes only). Add a typed `adopt` action that takes over an existing legacy install (re-own the checkout, rewrite units without `EnvironmentFile=`, reuse `.env` through `env.js`). Migrate production app by app once Python compiles (helm is on production), then delete the legacy planners, sudo routes, and `runCommand`. Target: one release after Python support.
2. **Backup authenticity.** Every app shares the `sovereign` user, so any compromised app can rewrite any app's backups. Record each archive's sha256 in the root-owned journal when it is created, and check it in `backup.verify`. Longer term: one uid per app. `lookupUser('sovereign')` is the seam to plan for before Python apps arrive.
3. **Borrowed identity.** `runAsUser` changes the whole process's euid, and it is safe only because everything inside it is synchronous. Move sovereign-side file work into a small helper process spawned with a uid, so the kernel enforces the identity.
4. **Bind previews to runs** for destructive actions: pass the previewed plan's digest (minus timestamps) and refuse a mismatch. Set `catalogRevision` from the release version.
5. **Durability details.** Replay protection that survives an executor restart (check the journal's requestId before running). Distinguish "pruned" from "never started". Serialize typed jobs in the web process instead of retrying `EXECUTOR_BUSY`. Show the journal entry (via `action-status`) on the job page instead of telling operators to `sudo cat` it.
6. **Structure.** Split `executor/handlers.js` into pure renderers (`render/`) and domain handlers. Extract `executor/fs-safety.js` (`runAsUser`, `writeFileAtomic`, `lstatOrNull`, `deny`). Add per-runtime modules (`runtime/node.js`, `runtime/python.js`) so new shapes stop growing `appLayout()`.
7. **Operability.** A typed self-update action (or at least a UI banner with the exact `install.sh --repair` command), since executor hosts cannot update from the UI.

Catalog strain, in expected order: sidecar ports (keep them reserved in the catalog), storage inside the install root, Python.

## Known gaps

- Tailscale installation is not a typed operation.
- Ports are the catalog's preferred ports (by design); a conflicting app must be moved before an executor install.
- The shapes marked **no** in the support matrix.
- Removing bitcoin-accounting's SQLite option from the catalog (Postgres-only decision), done alongside Python support.
- Python, in-root storage, schema-file bootstrap, mount-path-preserving proxying and `adopt`: see [Python apps and adopting legacy installs](#python-apps-and-adopting-legacy-installs).
