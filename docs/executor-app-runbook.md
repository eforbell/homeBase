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
| Storage inside the install root (`storage.paths` without `absoluteRoot`) | **no** | family-help, home-ops |
| Sidecars published through nginx | **no** | bug-base |
| Env referencing sidecar ports (`{{sidecar.<name>.port}}`) | **no** | family-pulse, bug-base: ports must be reserved in the catalog before the executor allocates them |
| Python runtime / venv | **no** | helm, bitcoin-accounting |
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

## Known gaps

- Lifecycle actions (restart, update, backup, restore, uninstall) are not executor actions yet.
- Tailscale installation is not a typed operation.
- Ports are the catalog's preferred ports (by design); a conflicting app must be moved before an executor install.
- The shapes marked **no** in the support matrix.
- Removing bitcoin-accounting's SQLite option from the catalog (Postgres-only decision), done alongside Python support.
