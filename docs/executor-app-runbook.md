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
- [ ] **Secrets never cross the socket or enter argv or env.** They are generated in `executor/actions.js` (`SECRET_GENERATORS`), reused on reinstall, and delivered through stdin or files written as the owner. Output is redacted in `execute.js`/`spawn.js`. One exception: the app's own database password goes to `pg_dump`/`pg_restore`/`psql` children as `PGPASSWORD`. Those children run as sovereign, which can already read the app's `.env`, and the password is passed in their `secrets` list for redaction.
- [ ] **Shared state keeps its owner.** `/opt/sovereign-home` stays root-owned (it holds the executor's code); only `apps/` belongs to sovereign.
- [ ] **Fail closed and say why.** Unknown field → `INVALID_REQUEST`. Not allowed → `POLICY_DENIED` with operator guidance. Never fall back to legacy shell execution (`rejectLegacyExecution`).
- [ ] **Don't re-harden the executor unit.** `NoNewPrivileges`, `RestrictSUIDSGID`, `ProtectHome` and a strict `UMask` break apt/dpkg and buy nothing for a process that starts units (see `SECURITY.md`).

## Shape support matrix

`src/operations/app-layout.js` decides what the executor can compile. It refuses anything else with a specific reason, never half-compiling an app. Keep this table in sync with it.

| Shape | Supported | Notes |
|---|---|---|
| Node runtime, `npm ci --omit=dev` | yes | |
| Commands `node <script.js> [--flags]`, `npm run <script>` | yes | parsed to fixed argv; anything else is refused |
| Python runtime (`runtime.python`: `requirements`, `editable`, `editableNoDeps`) | yes | helm, bitcoin-accounting. `ensure-venv` builds `.venv` with the system `python3` and rebuilds it (`--clear`) when the interpreter version changes; pip installs the lockfile, then the checkout. Adds `python3`, `python3-venv` to the app's packages |
| Commands `.venv/bin/<tool> [token ...]` | yes | Python apps only; absolute argv under the checkout; `{{port}}` is the only placeholder; tokens only, no absolute paths or `..`. Venv tools and `python3` may run only as a non-root uid (`spawn.js`) |
| Postgres database | yes | simple identifiers, not `postgres`/`template*`/`pg_*`, and unique across the catalog. `urlEnvKey` may be any `*DATABASE_URL` key (helm) |
| No database (`database: { engine: 'none', bootstrap: 'none' }`) | yes | home-drop. The manifest requires the block; `'none'` takes no names or migrations and compiles to no `postgres.*` steps, no `databasePassword` secret, and no dump in backups. Data lives in `storage.paths` |
| Database bootstrap from a SQL file (`database.bootstrap: schema-file`, `database.schemaFile`) | yes | bitcoin-accounting. Runs as the **app role**, with `ON_ERROR_STOP` in one transaction, and only while the database has no objects in `public`, so the app role owns its tables |
| apt `systemPackages` | yes | allowed per app on top of the bootstrap baseline |
| Storage at exactly `/var/lib/sovereign-home/<app id>/<name>` (`storage.absoluteRoot`) | yes | root-owned `<app id>` parent, sovereign `0750` leaf and sub-paths |
| Storage inside the checkout (`storage.paths` without `absoluteRoot`) | yes | family-help, home-ops, bug-base (`uploads`), helm (`.secrets`). Created **as sovereign**, `0700`, after the clone; backed up as `<path>.tgz` (legacy names); removed with the checkout on uninstall (the safety backup holds it) |
| Unit names | yes | main service, sidecars, and timers must be the app id or start with `<app id>-`, and be unique |
| Sidecars | yes | extra `.service` with catalog `Environment=` values (simple tokens only) |
| Sidecar ports (`sidecars[].port`, `{{sidecar.<name>.port}}`) | yes | reserved in the catalog (family-pulse 3004, bug-base 3006: the ports legacy assigns). Every port is unique across the catalog |
| Sidecars published through nginx (`sidecars[].nginx`: `mountPathSuffix`, `upstreamPath`) | yes | bug-base-mcp at `/bugs/mcp/`, in the app's own snippet |
| Timers (`onCalendar`, `onBootSec`, `onUnitActiveSec`, `randomizedDelaySec`) | yes | oneshot service + timer; calendars carried over exactly (including an explicit timezone) |
| Upload limit (`network.clientMaxBodySize`, e.g. `55M`) | yes | rendered as `client_max_body_size` |
| Mount-path-preserving proxying (`network.preserveMountPath`) | yes | helm, bitcoin-accounting: `proxy_pass` without a URI |
| Household timezone | yes | every process unit gets `Environment=TZ=<householdTimezone>` (the host clock may be UTC, as on erebor) |
| Custom `upstreamPath` / `extraProxyHeaders` on an app | **no** | no catalog app uses them |
| SQLite databases | **won't do** | bitcoin-accounting is Postgres-only under Home Base (decision 2026-09-24) |

An app is installable only when it compiles **and** appears in `INSTALLABLE_APPS` (`executor/actions.js`) after passing this runbook. Since 2026-09-25 that is every catalog app: all ten were installed, reinstalled and exercised in the container harness (see section 8).

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

Storage paths (`storage.absoluteRoot`):
- An env key whose catalog default points inside `storage.absoluteRoot` (family-pulse's `FP_TRANSACTION_FILES_DIR`, home-source's `STORAGE_PATH`) is re-derived on reinstall like any other default, **not** preserved. Backups archive the catalog root, so a custom value would leave backups and the app pointing at different directories.
- Moving an existing install to the catalog path is a manual migration: stop the service, move the directory to `<absoluteRoot>/<subpath>` owned by `sovereign:sovereign` (mode 0750), set the key in `.env`, start the service, then run a backup and confirm `<subpath>.tgz` is in it.
- Restore re-applies these keys after writing `.env.backup` (`storageEnvOverrides` in `src/operations/env.js`, used by both restore paths), so a backup taken before the key existed still points the app at the archived root.

Executor-specific rules:
- Render with `strict: true`. An unresolved placeholder refuses the install (`ENV_TEMPLATE_UNRESOLVED`); it never writes `''`.
- The context must provide every placeholder the app uses. Site values (`hostname`, `domain`, `householdTimezone`) arrive in the action and ride inside the plan's `app-env` step, where policy validates them (`isValidSite`).
- `NODE_ENV` is written into `.env` (Node apps read it after dotenv loads). Settings the interpreter needs **before** it starts (`TZ`, `PYTHONUNBUFFERED`) go into the unit as fixed `Environment=` lines instead; `.env` is loaded too late for them.
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

### Python runtime

**Status (2026-09-25): built.** The notes below are the original spec; where they differ, the support matrix above describes what shipped. Differences: `PYTHONUNBUFFERED` is set in the unit (a value in `.env` would arrive after the interpreter started); venvs are rebuilt in place with `--clear` when the interpreter version changes, rather than swapped, because venv scripts hardcode their absolute path; `pip install --upgrade pip` is not run; there is no separate PyPI preflight (pip runs with `--timeout 30 --retries 2`, so an offline host fails in about a minute with pip's own error). bitcoin-accounting still installs unpinned (`editable` only) until its repo ships a lockfile.

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

**Status (2026-09-26): built**, with option 1: the host stays in legacy-sudo mode while its apps move to the executor one at a time. Verified in two harnesses. One recreates erebor: Ubuntu 24.04, NodeSource Node 22, a legacy web checkout owned by `homebase`, NOPASSWD sudoers, and five legacy-installed apps. The other recreates numenor: Linux Mint 21.3 (jammy), NodeSource Node 20, PostgreSQL 14, Python 3.10, and bitcoin-accounting tables owned by `postgres`.

`adopt` takes over an app that legacy-sudo installed, in place: same checkout, data, and `.env` values. It compiles from the install plan (`buildAppAdoptPlan`, profile `app-adopt-v1`, destructive) with these differences:

| Step | Why |
|---|---|
| `nginx.assert-app-include` first (`nginx -T` as root, parsed by `src/operations/nginx-config.js`) | Legacy hosts serve apps from an operator-managed server block that includes `/etc/nginx/snippets/*.conf` (erebor's `erebor.forbell.com` site, numenor's `nginx.conf`). The executor's snippets live in `/etc/nginx/sovereign-home.d/`, so **that same block** must include it too, in every block that serves legacy snippets. Refuses, before changing anything, with the exact line to add |
| `backup.create` safety backup | Covers in-checkout storage (helm `.secrets`), `.env`, and the database |
| No managed gateway | `nginx.ensure-gateway` also leaves an operator gateway alone whenever the active config already includes `sovereign-home.d`, so later executor updates never take over `default_server` |
| `postgres.transfer-ownership` after `ensure-database` | Legacy ran schema files as `postgres`. It hands the app role its public tables, views, standalone sequences (column-owned ones move with their table), enum/domain/range/composite types, and functions and procedures. Refuses databases with other schemas. On numenor this moves 9 objects. It runs as superuser inside a database the app owns, so `search_path` is pinned to `pg_catalog, pg_temp` and every operator and function is schema-qualified; otherwise an operator the app planted in `public` would run as superuser (the CVE-2018-1058 class, reproduced on PostgreSQL 14 and 16 before the fix). Every other script the executor runs as `postgres` starts with the same `SET search_path` |
| `nginx.retire-legacy-snippets` right after the new snippet is written | Both snippets in one server would be duplicate locations. Removes the app's own `snippets/<app>.conf` and those of its nginx-published sidecars, keeping root-only copies in `/var/lib/homebase-executor/retired-nginx-snippets/<app>/`. Shared snippets (fonts, snakeoil) are untouched |
| Credentials are never generated | An app without database wiring in its `.env` is refused ("install it instead") |

The rest is the install plan: git sync repoints `origin` at the root-owned mirror and fast-forwards (no re-clone; untracked files such as helm's `.cache/` never block). The venv is reused when the interpreter matches. `.env` is re-rendered through the reinstall contract, so secrets and operator keys come through byte-identical, now `sovereign` 0640. Units are rewritten without `EnvironmentFile=` and with `TZ=`, timers keep their calendars exactly, and the plan ends with a readiness check.

**Web side.** Installations have a `managed_by` column. On a legacy-sudo host, `executorManagesApp()` sends adopted apps' install/update, restart, backup, restore, uninstall, and update checks to the executor; everything else stays on legacy. `POST /api/apps/:id/adopt/execute` previews by default, and the app page has an "Executor adoption" card. The executor fetches with its own key (`HOME_BASE_EXECUTOR_GIT_TRANSPORT`), while `HOME_BASE_GIT_TRANSPORT` keeps serving legacy apps.

**Moving a legacy host (operator steps):**
0. Update the legacy web checkout to a release that has adopt (its usual self-update), and check that `/etc/sovereign-home/homebase.env` sets `HOME_BASE_STATE_DB` under `/var/lib/sovereign-home/homebase` (erebor does). Without it, the legacy web keeps state in its own checkout, and the switch refuses.
1. Clone homeBase as root (no release is published yet, and the executor must never be built from the legacy web checkout, which `homebase` owns), then add the executor from that clone: `sudo GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes" git clone --branch main git@github.com:eforbell/homeBase.git /root/homebase-src && sudo bash /root/homebase-src/install.sh --source-dir /root/homebase-src --add-executor --git-ssh-key <key>`. Use the same clone (pulled to the same commit) for `--switch-to-executor`. This installs a root-owned executor in `/opt/homebase-executor` beside the legacy service and writes the root-owned marker `/etc/sovereign-home/legacy-coexistence`; the executor accepts `adopt` only while it exists. Mode, sudoers, and the web checkout are untouched, but the web service restarts once to join the executor's socket group, so the command refuses while legacy jobs run (`--force` overrides). The key must be able to read every app repository (erebor's account-level key works); it is copied root-only. Re-run `--add-executor` after each web self-update so both run the same code.
2. Add `include /etc/nginx/sovereign-home.d/*.conf;` right next to `include /etc/nginx/snippets/*.conf;`, **inside every server block that has that line** (erebor: the `erebor.forbell.com` site; numenor: the `http` server in `nginx.conf`). Then `sudo nginx -t && sudo systemctl reload nginx`. Adopt reads `nginx -T` and refuses unless each server block serving legacy snippets also has the new include. An include in another block or at `http` level would still pass `nginx -t` while the public route disappears.
3. Adopt each app from its page: preview, then run. Other apps keep working through legacy meanwhile. Adopt refuses an app whose legacy install is not at the catalog's path, mount path, and port. Moving it would break whatever outside Home Base points at the old one. The first step reports which server blocks it found serving legacy snippets; check that this matches your config. An app newly installed during coexistence installs the legacy way and must be adopted too before the switch.
4. `sudo bash install.sh --switch-to-executor`. It refuses while any installed app is not adopted (`--force` does not skip this), and it refuses `--no-start`, because it removes the sudo policy only after the new service has started and answered. It saves the env file and web unit to `/etc/sovereign-home/switch-backup-<time>/`, moves the legacy checkout aside (kept), installs the managed hardened service, and sets executor mode with auto-bootstrap off. It also makes the env file root-owned and takes `homebase` out of the `sovereign` group before the web restarts. Only after the service answers does it remove the sudoers policy, the coexistence marker, and the coexistence copy. It warns if `homebase` still has sudo rules from anywhere else.
5. Delete app-readable copies of the git key (erebor: `/opt/sovereign-home/.ssh/id_founder_homebase`) once nothing legacy remains.

**If an adopt fails.** The app is marked "adoption incomplete". Every action except adopt refuses for it, because the failed run may already have rewritten its units, `.env`, git remote, and nginx snippet (the old processes and nginx config keep running until something reloads them). Fix the cause shown in the job (PyPI, nginx include placement, and so on) and re-run adopt. It is idempotent and picks up where it stopped. A snippet swap that nginx rejects is undone on the spot, and a venv rebuild that fails restores the previous venv.

**Rolling back one adopt by hand** (for example to go back to legacy for an app):
1. Return the app to legacy routing first. For an adopt that did not finish, use **Abandon adopt** on its page (`POST /api/apps/<app>/adopt/abandon` with `confirm: "ABANDON"`, admin only, refused while a job runs). The response lists the remaining steps. For a completed adopt: `sudo sqlite3 /var/lib/sovereign-home/homebase/home-base.sqlite3 "UPDATE installations SET managed_by = NULL WHERE app_id = '<app>'"`.
2. Point the checkout back at GitHub. Legacy git runs as sovereign and cannot use the root-owned mirror: `sudo -u sovereign git -C /opt/sovereign-home/apps/<repoKey> remote set-url origin <repository url>`.
3. Copy the retired snippet back from `/var/lib/homebase-executor/retired-nginx-snippets/<app>/` into `/etc/nginx/snippets/`, delete `/etc/nginx/sovereign-home.d/<app>.conf`, then `sudo nginx -t && sudo systemctl reload nginx`.
4. Run a legacy reinstall of the app from its page; it rewrites the units with `EnvironmentFile=`. The ownership transfer stays; it is harmless for legacy.

**If `--switch-to-executor` stops partway.** Re-run it: when the env already says `executor` but the sudoers file and `/opt/homebase-executor` are still there, it resumes. To go back to legacy instead:
1. `sudo systemctl stop homebase`.
2. Move `/opt/sovereign-home/homebase.legacy-<time>` back to `/opt/sovereign-home/homebase`, after moving any half-installed managed copy out of the way.
3. Restore `homebase.env` and `homebase.service` from `/etc/sovereign-home/switch-backup-<time>/`.
4. `sudo usermod -a -G sovereign homebase` if it was removed.
5. `sudo systemctl daemon-reload && sudo systemctl start homebase`.

**Notes.**
- Adopt tracks `main` (or the pinned SHA the legacy record has). A legacy install on another branch is fast-forwarded to `main`, so the preview is also an update.
- Operator edits made directly in a legacy snippet are not carried over; the retired copy keeps them for reference.
- Downgrading the web below a release that knows `managed_by` would run legacy plans against adopted apps; don't.

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
- bitcoin-accounting installs unpinned Python dependencies (no lockfile in its repo yet).
- bitcoin-accounting's `migrations/001_add_soft_delete_columns.sql` is not wired into `migrationCommand`. Fresh installs don't need it (`tables.sql` already has the columns); a database created from an older `tables.sql` (possibly numenor's) does, so check during `adopt`.
