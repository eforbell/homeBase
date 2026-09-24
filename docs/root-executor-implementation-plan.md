# Home Base Root Executor and Typed Operation Protocol

> **Superseded in part (2026-09-24).** This was the implementation plan for protocol v1, where Home Base submitted typed plans and secret bindings (`execute-plan`/`validate-plan`) and a `family-dinner-v1` profile hard-coded Family Dinner. The shipped design is protocol v2. Callers name actions (bootstrap, install, restart, backup, restore, uninstall), and the executor compiles every plan from the catalog (`src/operations/app-layout.js`), generates its own secrets, and supports SSH deploy keys and confirmed destructive operations. Sections 7-9 and the "no SSH" / "no destructive operations" / "executor-local secrets later" statements describe v1. For current behavior see `docs/executor-app-runbook.md`, `SECURITY.md`, and `executor/protocol.js`.


**Status:** implementation-ready plan
**Prepared for:** Terra implementation agent
**Repository:** `/Users/forbell/workspace/homeApps/homeBase`
**Required base:** PR #16, branch `feature/safe-public-installer`, reviewed head `2a2fcddc448ee43445ac6137adb40fbc17ea5204`
**Companion verification spec:** `docs/root-executor-test-spec.md`
**Implementation target branch:** `feature/root-executor-protocol`, created from the current PR #16 head

## 1. Outcome

Restore Home Base's core ability to install managed applications without weakening the safety boundary introduced by PR #16.

The implementation shall:

1. Keep the Home Base web process unprivileged, loopback-only, and under `NoNewPrivileges=true`.
2. Add a separate, root-owned, systemd socket-activated executor.
3. Replace root execution of generated shell strings with a versioned, strict typed-operation protocol over a Unix-domain socket.
4. Install and repair the executor through the root-run public installer, not through the web process.
5. Use Family Dinner as the first complete application path: host bootstrap prerequisites, repository checkout, PostgreSQL setup, environment and unit rendering, dependency install, migration, service start, nginx reload, and readiness verification.
6. Preserve dry-run/plan review and auditable job history without persisting or logging secrets.

This is a pragmatic home-lab security design. It is intended to contain web-process, manifest, and operator mistakes and to prevent an easy arbitrary-root-command path. It is not intended to resist a malicious root operator, a compromised kernel, physical host takeover, or a nation-state adversary.

## 2. Why this work is required

PR #16 intentionally installs Home Base in plan-only mode. `src/config.js:13-17` normalizes all non-legacy modes to `plan-only`, and `src/config.js:26-28` enables privileged jobs only for the explicit legacy-sudo compatibility mode. The real install route consequently returns `PRIVILEGED_EXECUTION_DISABLED` through `src/admin-auth.js:141-163`.

That is a correct safe-public-installer checkpoint, but it cannot be the final public launch behavior because app installation is the control plane's primary purpose.

The legacy execution path is not suitable for public enablement:

- `src/services/job-runner.js:213-273` iterates generated commands and executes each with `/bin/bash -lc`.
- `src/services/install-planner.js:689-748` constructs install work as interpolated shell strings.
- `src/services/bootstrap-planner.js:165-293` does the same for package installation, identities, directories, nginx, services, Tailscale, and firewall changes.
- `SECURITY.md:18-24` already defines the desired future boundary: narrow, auditable, path-contained, and free of untrusted shell interpolation.

Family Dinner is the correct first application because its catalog entry is a single Node service with a public HTTPS repository, PostgreSQL migrations, no sidecars, no timers, and no persistent storage directories (`src/catalog.js:197-273`). It exercises the platform's important path without requiring the full catalog's complexity.

## 3. Scope

### 3.1 In scope

- Versioned operation-plan JSON schema and strict runtime validation.
- A versioned newline-delimited JSON Unix-socket protocol.
- A root-owned, socket-activated executor with serialized mutation handling.
- A Home Base executor client and capability/readiness check.
- Installer support for fresh install, idempotent repair, and executor-only repair.
- Redacted operation-plan persistence and structured operation events.
- A typed Dinner-capable host-bootstrap profile.
- A typed Family Dinner install compiler and handlers.
- Exact-operation plan review in the existing UI/API.
- Failure recovery through idempotency, resumability, and explicit repair guidance.
- Documentation, threat model, operational runbook, and release gate.

### 3.2 Explicitly out of scope for the first implementation

- Converting backup, restore, uninstall, Home Base self-update, Tailscale publishing, or every catalog app to the executor.
- Generic arbitrary-command, arbitrary-script, or arbitrary-package operations.
- Automated rollback of PostgreSQL migrations or npm lifecycle scripts.
- Defense against malicious root, kernel compromise, physical takeover, or a compromised signed release.
- Multi-host orchestration.
- Mandatory cryptographic signing between two processes on the same host. Unix socket ownership is the v1 trust mechanism.
- Full parity with font synchronization, UFW mutation, and interactive `tailscale up` in the legacy bootstrap planner.

Routes outside the scoped Dinner install/bootstrap path must remain plan-only or explicitly return an unsupported-operation response. They must not silently fall back to legacy `/bin/bash -lc` execution.

## 4. Architecture decision summary

### Principles

1. **Preserve the web/runtime privilege boundary.** The web process never becomes root and never gains `sudo`.
2. **Constrain authority by data shape.** The executor accepts typed operations, not shell text.
3. **Fail closed.** Unknown protocol versions, fields, operation types, paths, repositories, packages, users, and units are rejected before any mutation.
4. **Make partial progress recoverable.** Operations are idempotent where feasible, serialized, journaled, and safe to resume.
5. **Ship one real golden path before generalizing.** Dinner proves the design; other catalog shapes follow only after evidence.

### Top decision drivers

1. Retain `NoNewPrivileges=true` and the PR #16 service hardening in `install.sh:332-360`.
2. Prevent web or manifest input from becoming an arbitrary root shell command.
3. Keep installation understandable and repairable by a competent home-lab operator.

### Options considered

#### Option A: narrow sudoers commands

Add exact helper commands to sudoers and let Home Base invoke them.

- **Pros:** least new infrastructure; familiar operator model.
- **Cons:** conflicts with `NoNewPrivileges=true`; difficult to express path/content policy safely; helper proliferation; less coherent audit stream.
- **Decision:** rejected as the supported public path. Retain `legacy-sudo` only as a private compatibility mode, as PR #16 already does.

#### Option B: systemd socket-activated root executor — selected

Run a small root process behind a root-owned Unix socket. The web process submits a complete typed plan and receives structured events.

- **Pros:** preserves web hardening; explicit protocol; centralized validation, serialization, auditing, and redaction; naturally installable and monitorable with systemd.
- **Cons:** introduces a privileged daemon and protocol that require careful testing; socket membership grants the ability to request all allowed operations.
- **Decision:** selected for v1.

#### Option C: polkit/D-Bus or transient systemd units

Model each action through a system policy framework or transient unit.

- **Pros:** native authorization and lifecycle primitives.
- **Cons:** significantly higher policy and debugging complexity for the current Node codebase and home-lab audience; does not remove the need for typed operation validation.
- **Decision:** defer. Reconsider only if multiple local callers or per-user authorization becomes a requirement.

## 5. Threat model

### 5.1 Assets

- Host root integrity and system configuration.
- App databases, documents, secrets, backups, and generated `.env` files.
- Root-owned systemd/nginx configuration.
- Catalog and release provenance.
- Operation logs and audit history.

### 5.2 Adversaries and failure sources addressed

- An unauthenticated LAN/Tailnet user reaching Home Base.
- A stolen or confused Home Base admin session.
- A compromised Home Base web process running as `homebase`.
- A malformed or malicious catalog/manifest entry.
- Path traversal, unit-name injection, repository/ref injection, symlink escape, or shell metacharacters.
- Accidental operator retry, process crash, power loss, or partial install.
- Secret leakage through plan JSON, API responses, logs, or journal output.

### 5.3 Explicit non-goals

- A malicious operator with root access.
- Kernel or container-runtime compromise.
- Physical access sufficient to replace the OS or boot media.
- A compromised trusted release artifact or GitHub account after verification.
- Sophisticated local side channels.

### 5.4 Trust boundaries

- `homebase.service` and its SQLite state are **unprivileged and potentially compromisable**.
- `homebase-executor.service`, its installed code, policy, and unit files are part of the **trusted computing base** and must be root-owned and not writable by `homebase` or `sovereign`.
- The compiled catalog/policy is trusted only after schema and policy validation. Catalog membership is not permission to pass arbitrary strings to root.
- Membership in the dedicated executor socket group authorizes submission of allowed operations. Only the `homebase` service account shall be a member.
- npm scripts and application code execute as `sovereign`, never root. They remain untrusted with respect to the host but are intentionally allowed to modify the app-owned install tree.

## 6. Target component model

### 6.1 Services and identities

Keep the existing identities separate:

- `homebase`: Home Base web/control process; owns Home Base state only.
- `sovereign`: managed app runtime/install identity; owns `/opt/sovereign-home/apps` and app data selected by policy.
- `root`: executor identity.
- `homebase-exec`: new dedicated group used only for socket access; `homebase` is its only non-root member.

Do not add `homebase` to the broad `sovereign` group as part of this work. The current bootstrap command at `src/services/bootstrap-planner.js:188-199` should not be reproduced in the typed bootstrap path.

### 6.2 systemd units

Install two new root-owned files:

`/etc/systemd/system/homebase-executor.socket`

```ini
[Unit]
Description=Home Base privileged executor socket

[Socket]
ListenStream=/run/homebase/executor.sock
SocketUser=root
SocketGroup=homebase-exec
SocketMode=0660
RemoveOnStop=true

[Install]
WantedBy=sockets.target
```

`/etc/systemd/system/homebase-executor.service`

```ini
[Unit]
Description=Home Base privileged executor
Requires=homebase-executor.socket
After=local-fs.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/sovereign-home/homebase/executor/server.js
User=root
Group=root
UMask=0077
PrivateTmp=true
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
```

`NoNewPrivileges=true` remains required on `homebase.service`, the unprivileged web control plane. It is intentionally omitted from the root executor because approved operations invoke package tooling and must support its documented privilege transitions.

The implementation agent must verify which hardening directives are compatible with package installation, systemd unit writes, PostgreSQL, and nginx operations instead of copying the example blindly. `ProtectSystem=strict` cannot be enabled unless the exact required write paths are declared. Prefer an explicit `ReadWritePaths=` set if systemd behavior is verified on Ubuntu 24.04 and Debian 12.

The executor shall consume the systemd-activated listening socket, not create a world-accessible socket itself. It shall process one mutating plan at a time and return `EXECUTOR_BUSY` for concurrent mutation attempts.

### 6.3 Installation and repair ownership

There are two different bootstrap layers; name them explicitly in code and docs:

1. **Trust bootstrap (`install.sh`)** — runs as root and installs or repairs Home Base code, the executor, group membership, socket/service units, state directories, and ownership. This is the only supported way to establish or repair the root trust boundary.
2. **Host bootstrap (Home Base operation plan)** — runs through the already-installed executor and provisions the Dinner-capable host baseline.

Do not make the web process install or repair its own root executor. That creates a circular trust boundary.

Fresh `install.sh` behavior:

- Create `homebase-exec` as a system group if absent.
- Create/preserve `homebase` as the runtime user and add only it to `homebase-exec`.
- Install root-owned application/executor code with no group or other write bit.
- Install and enable `homebase-executor.socket`.
- Start the socket unless `--no-start` is used.
- Start `homebase.service` after the socket is available.
- Verify `hello`/capabilities before declaring the install healthy.

Repair behavior:

- Add `--repair` to idempotently restore code ownership, group membership, executor units, socket mode, environment keys, and both services while preserving SQLite state, admin credentials, app configuration, and existing secrets.
- Add `--repair-executor` as a narrower mode that repairs only executor code, group, units, socket, and capability health.
- Refuse to overwrite an installation directory that lacks the existing managed marker, consistent with `install.sh:271-279`.
- Do not require the installed Home Base web service to be healthy before executor repair.
- Log each repaired item without printing secret-bearing environment values.

The existing installer currently preserves same-version code instead of repairing it (`install.sh:275-292`). Change this deliberately: repair mode may refresh root-owned release files from the verified archive while normal same-version reruns continue to preserve them.

## 7. Protocol contract

### 7.1 Transport

- Unix-domain stream socket at `/run/homebase/executor.sock`.
- UTF-8 newline-delimited JSON (NDJSON).
- One request per connection; zero or more event lines followed by exactly one terminal result line; server closes the connection.
- Maximum request size: 1 MiB.
- Maximum event line size: 64 KiB.
- Protocol read deadline: 10 seconds before acceptance.
- Per-operation timeout is policy-bounded; full-plan maximum is 30 minutes for the Dinner MVP.
- Reject blank, malformed, trailing-content, or unsupported-version requests. Parse JSON exactly once and use that same object for validation, digesting, policy checks, and execution so duplicate-key parser differentials cannot arise.

### 7.2 Request types

#### `hello`

Used by installer, health endpoint, and UI capability detection.

```json
{
  "protocolVersion": 1,
  "requestId": "4cad4a85-a760-4b6b-8d87-0cc41c88b77f",
  "type": "hello"
}
```

The terminal response includes executor version, protocol versions, policy version, supported operation types, maximum request size, and whether another plan is active.

#### `validate-plan`

Validates the entire redacted operation plan without mutating the host. It is used for server-side plan review and tests. Secret bindings are not required; only secret reference names are validated.

#### `execute-plan`

Executes one validated plan serially.

```json
{
  "protocolVersion": 1,
  "requestId": "c2b6a07a-632c-48c2-a9c0-65e2f5948894",
  "type": "execute-plan",
  "jobId": "481",
  "actor": {
    "kind": "homebase-admin-session",
    "auditRef": "sha256:..."
  },
  "issuedAt": "2026-09-20T14:00:00.000Z",
  "planDigest": "sha256:...",
  "plan": { "schemaVersion": 1, "operations": [] },
  "secretBindings": {
    "familyDinnerDatabasePassword": "..."
  }
}
```

The executor recomputes `planDigest` from canonical JSON excluding `secretBindings` and rejects mismatches. `issuedAt` is accepted only within a five-minute skew. `requestId` is unique for the executor process lifetime; duplicate completed requests return the stored terminal result, while duplicate in-flight requests are rejected.

Cryptographic message signing is not required in v1 because access is already restricted by the local socket. Do not invent a shared secret that would live in the same compromised web process.

### 7.3 Events and terminal results

Every response line contains `protocolVersion`, `requestId`, `jobId`, `sequence`, and `timestamp`.

Event types:

- `plan.accepted`
- `operation.started`
- `operation.output` — bounded, UTF-8-normalized, and redacted
- `operation.completed`
- `operation.failed`
- `plan.completed`
- `plan.failed`

Terminal error codes are stable machine-readable strings, including:

- `UNSUPPORTED_PROTOCOL`
- `INVALID_REQUEST`
- `INVALID_PLAN`
- `PLAN_DIGEST_MISMATCH`
- `POLICY_DENIED`
- `EXECUTOR_BUSY`
- `OPERATION_TIMEOUT`
- `OPERATION_FAILED`
- `SECRET_BINDING_MISSING`
- `REPAIR_REQUIRED`

Never place a secret binding, full environment file, database URL with credentials, session token, or raw request object in an event or journal message.

## 8. Typed operation plan schema v1

### 8.1 Plan envelope

```json
{
  "schemaVersion": 1,
  "kind": "app-install",
  "target": "family-dinner",
  "catalogRevision": "<git sha>",
  "generatedAt": "2026-09-20T14:00:00.000Z",
  "policyProfile": "family-dinner-v1",
  "operations": []
}
```

Use JSON Schema draft 2020-12. Every object in the schema must set `additionalProperties: false`. Use discriminated `oneOf` operation definitions keyed by `type`. Runtime validation must use the same checked-in schema; do not maintain an unrelated hand-written validator and JSON schema.

### 8.2 Common operation fields

Every operation has:

- `id`: stable plan-local identifier matching `^[a-z][a-z0-9-]{0,63}$`.
- `type`: closed enum discriminator.
- `title`: operator-facing description, maximum 160 characters.
- `risk`: `read`, `write`, or `destructive`; v1 Dinner uses only `read` and `write`.
- `timeoutMs`: positive integer, clamped by per-type policy.
- `idempotencyKey`: SHA-256-derived stable key for the operation inputs.
- `dependsOn`: array of earlier operation IDs only.
- `preconditions`: typed predicates, not shell strings.
- `secretRefs`: names referenced by the operation; never secret values.

No operation may contain `command`, `script`, `shell`, or an arbitrary executable path.

### 8.3 Required v1 operation types

Implement only the closed set required for trust bootstrap, Dinner-capable host bootstrap, and Dinner install:

1. `host.assert-debian-family`
   - Read `/etc/os-release`; accept supported Ubuntu/Debian versions.
   - No arbitrary file path field.

2. `package.ensure`
   - `packages` must be a subset of a compiled policy list: `git`, `ca-certificates`, `ssl-cert`, `nginx`, `postgresql`, `postgresql-client`, `nodejs`, `npm`.
   - Executor invokes `/usr/bin/apt-get` with fixed argv; no shell and no caller-supplied apt options or repositories.
   - `apt-get update` is an explicit boolean policy action, not a command string.

3. `identity.ensure-user`
   - v1 only permits the exact `sovereign` identity, system account semantics, `/opt/sovereign-home`, and `/usr/sbin/nologin`.
   - No arbitrary groups.

4. `filesystem.ensure-directory`
   - Allowed roots are compiled by purpose, not caller supplied: app root, shared asset root, backup root, config root, nginx snippets.
   - Validate normalized absolute path, existing-parent realpath, ownership, mode, and absence of symlink traversal.

5. `git.sync`
   - Repository must exactly equal the selected catalog entry's HTTPS URL; v1 does not use SSH.
   - Ref permits `main` or an immutable 40-character commit SHA for Dinner.
   - Destination must equal `/opt/sovereign-home/apps/familyDinner` after normalization.
   - Run git as `sovereign` using absolute binary path and argv.
   - Fail on a dirty existing checkout; never reset operator changes automatically.

6. `postgres.ensure-role`
   - Role name must match Dinner policy.
   - Password is supplied through a named secret binding via stdin or safely parameterized SQL; never argv.
   - Run the fixed PostgreSQL client as `postgres`, not through a shell.

7. `postgres.ensure-database`
   - Database and owner must match Dinner policy.
   - Idempotent create/owner verification.

8. `filesystem.write-managed-file`
   - Purpose enum: `app-env`, `systemd-unit`, `nginx-snippet`, `nginx-gateway`.
   - Destination is derived from purpose and validated app metadata; the plan does not provide an arbitrary system path.
   - Use a same-directory temporary file, `fsync`, restrictive mode, ownership, no-follow checks, and atomic rename.
   - Preserve configured existing environment keys for Dinner as currently declared at `src/catalog.js:250-265`.
   - Redacted plan preview shows key names and content digest, not secret values.

9. `runtime.run-npm`
   - Fixed executable path resolved at executor startup from an approved location.
   - Allowed task enum for Dinner: `install-production` and `migrate`.
   - Maps internally to argv equivalent to `npm ci --omit=dev` and `npm run db:migrate` from `src/catalog.js:208-233`.
   - Runs as `sovereign`, with cwd fixed to the Dinner checkout, bounded environment, timeout, and output redaction.
   - npm lifecycle code is intentionally trusted only at `sovereign` privilege, never root.

10. `systemd.daemon-reload`
    - No caller-controlled fields beyond common metadata.

11. `systemd.ensure-service`
    - The schema accepts a unit name, but policy permits only `family-dinner.service` in `family-dinner-v1` and only `postgresql.service`/`nginx.service` in `host-bootstrap-v1`.
    - Allowed action enum: `enable`, `restart`, `enable-and-restart`.
    - Fixed `/usr/bin/systemctl` argv.

12. `nginx.validate-and-reload`
    - Fixed `nginx -t`, then `systemctl reload nginx` only if validation succeeds.
    - Capture bounded redacted output.

13. `http.wait-ready`
    - This is unprivileged and should execute in the Home Base web process after the executor plan succeeds.
    - Destination is restricted to loopback, catalog port `3000`, and `/api/ready` from `src/catalog.js:214-222`.
    - Keep it in the operation plan for review/audit, but mark its executor as `homebase`, not `root`.

### 8.4 Policy is separate from schema

Schema validation proves shape. Policy validation proves authority. Implement both.

Policy checks must bind the plan to the compiled catalog entry and profile:

- exact repository URL and ref policy;
- exact install root, service user, database/role, port, service/unit name, and nginx destination;
- approved packages and binaries;
- allowed execution identity per operation;
- maximum timeouts and output sizes;
- dependency order;
- no destructive operations in `family-dinner-v1`.

The executor shall validate the complete plan and all referenced secrets before the first mutation. Do not discover a policy error halfway through installation.

## 9. Family Dinner golden path

### 9.1 Dinner-capable host bootstrap plan

Compile this typed sequence from a new bootstrap compiler:

1. `host.assert-debian-family`
2. `package.ensure` for the fixed Dinner baseline
3. `identity.ensure-user` for `sovereign`
4. `filesystem.ensure-directory` for `/opt/sovereign-home`, `/opt/sovereign-home/apps`, `/var/lib/sovereign-home/backups`, `/etc/sovereign-home`, and `/etc/nginx/snippets`
5. `systemd.ensure-service` equivalents for `postgresql.service` and `nginx.service` under a separate `host-bootstrap-v1` policy profile
6. `nginx.validate-and-reload` only after installing the managed gateway include required by Dinner

The first implementation may omit shared-font download, Tailscale installation, UFW mutation, and interactive Tailscale enrollment. Surface those as manual follow-up items in the plan rather than executing legacy shell from `src/services/bootstrap-planner.js:218-291`.

### 9.2 Dinner application plan

1. Ensure the app install root.
2. Clone or fast-forward the exact public Dinner repository/ref as `sovereign`.
3. Ensure the PostgreSQL role and database using an ephemeral password binding.
4. Atomically write Dinner `.env` with correct permissions and preserved non-secret customization.
5. Atomically write `family-dinner.service` and the Dinner nginx snippet.
6. Run `npm ci --omit=dev` as `sovereign`.
7. Run `npm run db:migrate` as `sovereign`.
8. Reload systemd and enable/restart `family-dinner.service`.
9. Validate nginx, then reload it.
10. Wait for `http://127.0.0.1:3000/api/ready` from the unprivileged Home Base process.
11. Mark the installation `installed` only after readiness succeeds.

If readiness fails, retain the job as failed with the exact completed operation IDs, keep the generated artifacts for inspection, and provide repair/retry instructions. Do not mark installed merely because systemd restart returned success; this corrects the current optimistic completion behavior at `src/services/job-runner.js:233-245`.

### 9.3 Secrets

For v1:

- Home Base may generate the Dinner database password in memory.
- Store only secret reference names and redacted values in `plan_json`.
- Transmit the password once in `secretBindings` over the protected local socket.
- Executor output redaction includes exact binding values and URL-encoded forms.
- The executor writes the final `.env`; the plaintext password is not returned.
- If Home Base crashes before submission, regenerate/replan. If it crashes after submission, reconcile from operation events and the installed `.env`; never copy the password into the job log.

Do not send secrets in argv or environment variables to child processes when stdin or an already-written protected file is sufficient.

## 10. Code organization and file-level work

Paths below are proposed and may be refined only if the same separation is preserved.

### 10.1 Shared schema and policy

Create:

- `schemas/homebase-operation-plan-v1.schema.json` — canonical machine schema.
- `src/operations/validate.js` — schema validation and canonicalization.
- `src/operations/digest.js` — deterministic canonical JSON and SHA-256 digest.
- `src/operations/policy.js` — catalog/profile binding and path/name/package rules.
- `src/operations/redact.js` — redacted plan/event projection.
- `src/operations/render.js` — human-readable dry-run rendering; never executable shell output.
- `src/operations/compilers/bootstrap.js` — Dinner-capable host baseline.
- `src/operations/compilers/install.js` — Dinner app operations.

Do not extend `src/manifest-schema.js:1-170` with executor authority rules. Manifest schema describes app metadata; operation schema describes privileged actions. The install compiler is the boundary between them.

Avoid a new runtime dependency if a small, complete validator can be maintained safely. If JSON Schema support would otherwise be incomplete, adding a mature validator is acceptable only with an explicit dependency rationale, pinned lockfile change, and vulnerability/license review.

### 10.2 Executor

Create:

- `executor/server.js` — systemd socket entrypoint and one-plan serialization.
- `executor/protocol.js` — NDJSON parsing, limits, envelopes, stable errors.
- `executor/context.js` — fixed binary paths, identities, managed roots, policy version.
- `executor/spawn.js` — shell-free spawn with fixed argv, uid/gid, timeout, output caps, and redaction.
- `executor/audit.js` — structured safe journal messages.
- `executor/handlers/host.js`
- `executor/handlers/package.js`
- `executor/handlers/identity.js`
- `executor/handlers/filesystem.js`
- `executor/handlers/git.js`
- `executor/handlers/postgres.js`
- `executor/handlers/runtime.js`
- `executor/handlers/systemd.js`
- `executor/handlers/nginx.js`

Handlers receive validated normalized objects, not raw JSON. No handler may invoke `/bin/sh`, `/bin/bash`, `sudo`, `eval`, `exec`, a heredoc shell, or caller-selected executable paths.

### 10.3 Home Base client and job orchestration

Create:

- `src/executor/client.js` — hello, validate, execute, timeouts, event stream.
- `src/executor/capabilities.js` — cached health/capability projection.

Refactor:

- `src/services/job-runner.js:37-52` so Dinner uses `operationSteps`, not `executionSteps`.
- `src/services/job-runner.js:213-273` into separate typed-operation and legacy-plan runners. The typed path must never call `runCommand`.
- `src/app.js:1028-1133` to validate a typed plan, check executor readiness, persist the redacted plan, and stream/store executor events.
- `src/app.js:1078-1098` to replace the legacy `sudo` preflight requirement with executor capability plus the typed bootstrap prerequisites.
- `src/admin-auth.js:141-163` so real Dinner execution requires admin unlock **and** a compatible healthy executor rather than the broad legacy privileged-jobs boolean.
- `src/config.js:13-58` to add an `executor` mode/capability without turning on `legacy-sudo`.

Keep `runCommand` only for explicitly private legacy compatibility during migration. Add an invariant test that the public installer never selects it and the Dinner execution route cannot reach it.

Render the Dinner systemd unit from validated structured runtime fields. Do not treat the existing free-form `runtime.startCommand` in `src/manifest-schema.js:19-26` as privileged authority. For Dinner v1, policy maps the runtime to the fixed executable/argv equivalent of `/usr/bin/node server.js`, with `User=sovereign`, exact working directory, exact environment-file path, and the existing hardening template.

### 10.4 State and events

The current `jobs` table stores one plan blob and flat log text (`src/state/sqlite-driver.js:41-55`), while admin audit is separate (`src/state/sqlite-driver.js:107-117`). Add:

- `plan_digest TEXT`
- `operation_schema_version INTEGER`
- `executor_protocol_version INTEGER`
- `executor_request_id TEXT`
- `executor_state TEXT`

Add a `job_operation_events` table:

- `job_id INTEGER NOT NULL`
- `sequence INTEGER NOT NULL`
- `operation_id TEXT`
- `event_type TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `payload_json TEXT NOT NULL` — already redacted
- unique `(job_id, sequence)`

Keep `log_text` as a human-readable projection for the existing UI, but derive it from redacted events. Migrations must be idempotent using the repository's existing `PRAGMA table_info` pattern at `src/state/sqlite-driver.js:126-134`.

### 10.5 Installer and systemd assets

Refactor `install.sh:294-388` to install both services and verify executor health. Prefer checked-in unit templates under:

- `deploy/homebase.service`
- `deploy/homebase-executor.socket`
- `deploy/homebase-executor.service`

If templating inside `install.sh` remains simpler for v1, add snapshot tests for the complete rendered units. Either approach must leave root-owned mode `0644` units and root-owned non-writable executor code.

Update:

- `docs/install.md`
- `SECURITY.md`
- `docs/architecture.md`
- a new `docs/executor-protocol.md`
- a new `docs/executor-repair.md`

## 11. Implementation sequence and gates

Each phase is a reviewable checkpoint. Do not combine the first root mutation implementation with an unreviewed generic operation mechanism.

### Phase 0 — branch and baseline lock

1. Fetch PR #16 and confirm the base head.
2. Create `feature/root-executor-protocol` from `feature/safe-public-installer`.
3. Run `npm test` and the PR #16 installer tests before changes.
4. Record the base commit in the new branch/PR description.

Commands:

```bash
git switch feature/safe-public-installer
git pull --ff-only
git switch -c feature/root-executor-protocol
npm test
```

If PR #16 has advanced from `2a2fcdd`, rebase the plan branch onto the current PR head and re-run baseline tests. Do not silently implement against `main`.

**Gate:** clean baseline, exact base recorded, no source change yet.

### Phase 1 — contracts, compiler, and policy with no execution

1. Add canonical schema, validator, digest, redaction, renderer, and policy profiles.
2. Add the Dinner bootstrap and install compilers.
3. Have `buildInstallPlan` return `operationPlan` for Dinner while preserving current shell preview temporarily for non-Dinner callers.
4. Expose typed dry-run output from the existing plan API.
5. Add all schema/policy negative tests before any handler exists.

**Gate:** Dinner's exact plan validates; traversal, extra fields, arbitrary packages/repos/units/executables fail; dry-run contains no secret and no executable shell script.

### Phase 2 — socket skeleton and trust bootstrap

1. Add executor protocol/server with `hello` and `validate-plan` only.
2. Add executor client and capability health.
3. Extend `install.sh` for fresh install, `--repair`, and `--repair-executor`.
4. Install/enable the socket; keep mutation disabled.
5. Verify group membership, unit ownership, socket mode, request limits, and unsupported-version handling on Ubuntu 24.04 VM.

**Gate:** a fresh install and repair both produce a healthy compatible executor; `homebase.service` retains `NoNewPrivileges=true`; no mutation operation is accepted.

### Phase 3 — safe base handlers

Implement host assertion, identity, directory, managed-file, systemd, nginx, and shell-free spawn primitives. Add handler tests before enabling the next handler.

**Gate:** path/symlink/unit-name/output/timeout tests pass under rootful integration tests; no code path uses a shell.

### Phase 4 — Dinner-capable host bootstrap

Implement fixed package installation and core service enablement. Route the new Dinner-capable bootstrap profile through the executor. Keep Tailscale/font/UFW work as manual/plan-only.

**Gate:** on a clean Ubuntu 24.04 VM, Home Base installs/repairs the executor and the typed bootstrap establishes git, Node/npm, nginx, PostgreSQL, `sovereign`, and managed directories. A second run is a no-op or verified reconciliation.

### Phase 5 — Family Dinner end-to-end install

Implement git, PostgreSQL, npm, config, service, nginx, and readiness behavior. Change the Dinner execute route to require executor capability and use no legacy shell runner.

**Gate:** Dinner installs from the UI/API on a clean bootstrapped VM, `/api/ready` succeeds, reboot preserves service health, and re-execution is idempotent. No root child process runs npm, app code, or migrations.

### Phase 6 — recovery, reconciliation, and audit

1. Reconcile Home Base restart against executor events/request IDs.
2. Implement retry from the first incomplete idempotent operation.
3. Verify config writes are atomic and nginx is not reloaded after invalid config.
4. Add bounded output, redaction tests, BUSY behavior, and repair messages.
5. Document manual recovery for non-rollbackable npm/migration failures.

**Gate:** kill/restart tests produce a failed or reconciled job, never a false `installed` state; repair restores a deliberately damaged executor unit/socket without losing Home Base state.

### Phase 7 — independent review and PR readiness

1. Run the full companion test spec.
2. Perform an independent security/code review focused on the executor TCB.
3. Fix all actionable high/medium findings and rerun affected/full tests.
4. Open a stacked PR targeting `feature/safe-public-installer`, not `main`, while PR #16 remains open.
5. Test the combined branch on the operator's real test host before merging.

Recommended integration order:

1. Keep PR #16 open.
2. Open the executor PR stacked on PR #16.
3. Test the stacked branch on the test host.
4. Merge PR #16.
5. Retarget/update the executor PR to `main`, verify the diff did not change unexpectedly, rerun tests, then merge.

## 12. Commit/PR slices for the Terra agent

Keep commits small and Lore-compliant.

1. **Define privilege as typed, reviewable data**
   Schema, validation, policy, redaction, Dinner compiler, tests.
2. **Establish a repairable executor trust boundary**
   Socket/server/client hello, systemd units, installer fresh/repair, tests.
3. **Constrain root mutations to explicit handlers**
   Base handlers, spawn wrapper, audit, adversarial tests.
4. **Provision the minimum host baseline for Dinner**
   Package/identity/layout/core services, idempotency tests.
5. **Prove Home Base can install Family Dinner safely**
   Git/Postgres/npm/unit/nginx/readiness, state events, UI/API integration.
6. **Make failures diagnosable and recoverable**
   Reconciliation, repair docs, kill/retry tests, security docs.

Each commit message must explain why and include `Confidence`, `Scope-risk`, `Tested`, and `Not-tested` trailers where relevant, per repository guidance.

## 13. Acceptance criteria

All are release gates unless marked follow-up.

### Boundary and protocol

- `homebase.service` still runs as `homebase`, binds loopback, and contains `NoNewPrivileges=true`.
- The public installer creates no sudoers rule and does not enable `legacy-sudo`.
- `/run/homebase/executor.sock` is root-owned, group `homebase-exec`, mode `0660`; an unrelated local user cannot connect.
- Executor code, policy, and units are root-owned and not group/other writable.
- Unknown protocol/schema versions, operation types, and extra fields fail before mutation.
- The Dinner typed execution path has no reachable `/bin/bash`, `/bin/sh`, `sudo`, `eval`, or arbitrary executable invocation.
- Concurrent mutation plans produce one active plan and one deterministic `EXECUTOR_BUSY` result.

### Installer and repair

- Fresh Ubuntu 24.04 install enables a healthy executor socket and healthy Home Base web service.
- `install.sh --repair-executor` restores a deleted unit, incorrect socket mode, and incorrect executor-code ownership.
- Repair preserves SQLite state, admin setup, existing Dinner `.env`, and generated secrets.
- `--no-start` installs/enables units without starting either application service.

### Dinner golden path

- Typed host bootstrap is idempotent on a clean Ubuntu 24.04 VM.
- Family Dinner clones only the configured HTTPS repository/ref into its exact managed destination.
- npm install and migration run with uid/gid `sovereign`, not root.
- PostgreSQL role/database creation is idempotent and the password is absent from argv, API responses, SQLite plan JSON, job logs, and journal output.
- systemd and nginx files are atomically written to exact approved paths with expected mode/owner.
- nginx reload occurs only after `nginx -t` succeeds.
- The installation becomes `installed` only after `http://127.0.0.1:3000/api/ready` succeeds.
- Reboot brings Dinner back healthy; a second install reconciles without replacing preserved config values.
- A dirty Dinner checkout is rejected with operator guidance rather than reset.

### Failure behavior

- Invalid path traversal, symlink escape, package, repository, ref, identity, unit, port, and executable tests all fail closed.
- Executor crash, Home Base crash, and host reboot during a plan result in a reconciled/failed job with no false success.
- Output limits and timeouts terminate work predictably and preserve a redacted terminal event.
- Executor unavailable/incompatible disables real execution but leaves planning/dry-run functional.
- Unsupported non-Dinner app execution remains visibly unavailable; it never falls back to legacy shell execution.

### Verification

- `npm test` passes.
- New unit, integration, installer, protocol, hostile-input, and VM end-to-end tests in the companion spec pass.
- Independent reviewer finds no actionable high/critical issue and all accepted medium findings are fixed or documented with explicit deferral.

## 14. Pre-mortem

### Failure 1: `runtime.run-npm` becomes an accidental root shell escape

**Cause:** generic executable/argv/cwd or environment fields are accepted, or npm runs as root.
**Early warning:** tests construct a non-Dinner cwd, caller-selected binary, or observe uid 0.
**Mitigation:** task enum maps internally to fixed argv; exact realpath; fixed uid/gid; minimal env; no shell; root-uid assertion test in every runtime handler.

### Failure 2: socket permissions make the executor locally available to unintended users

**Cause:** socket mode/group drift, broad group membership, or installer repair omission.
**Early warning:** `stat` is not `root:homebase-exec 0660` or another user can complete `hello`.
**Mitigation:** dedicated group, installer verification/repair, unit tests and VM negative connection test, startup refusal when socket metadata is unexpected.

### Failure 3: a partial Dinner install is reported as successful

**Cause:** systemd restart succeeds but migration/readiness fails, or Home Base crashes before state update.
**Early warning:** job status is `installed` while `/api/ready` fails or terminal executor event is missing.
**Mitigation:** terminal-plan event plus unprivileged readiness is the only success transition; operation event table; reconciliation on startup; kill/restart tests.

### Failure 4: typed plan preview and actual root behavior drift

**Cause:** UI renders legacy shell steps while executor runs different operations, or handler adds implicit behavior.
**Early warning:** golden-plan snapshot differs from handler audit events.
**Mitigation:** typed plan is the single source; renderer consumes it; executor emits an event per operation; parity assertion matches accepted digest and completed operation IDs.

### Failure 5: a secret leaks through persistence or output

**Cause:** full request/plan logging, child argv/environment, error serialization, or flat job log projection.
**Early warning:** canary secret found by recursive search of SQLite, API capture, or journal.
**Mitigation:** redacted stored plan, ephemeral secret bindings, stdin/protected files, centralized redactor, canary leakage test across all storage/output surfaces.

## 15. ADR

### Decision

Adopt a systemd socket-activated, root-owned Home Base executor using a versioned typed-operation plan and NDJSON event protocol. Install and repair it only through the root-run public installer. Prove the boundary through a Dinner-capable bootstrap and Family Dinner install before converting the wider catalog.

### Drivers

- PR #16 correctly removes unsafe ambient privilege but leaves public Home Base unable to install apps.
- The existing shell-string runner is too broad for public enablement.
- A home-lab operator needs an understandable, inspectable, repairable system rather than enterprise authorization infrastructure.

### Alternatives considered

- Narrow sudoers helper commands.
- polkit/D-Bus or transient systemd units.
- Keeping plan-only execution indefinitely.

### Why chosen

The selected design preserves the web service's `NoNewPrivileges` boundary, concentrates privileged policy in a small auditable component, maps directly to systemd operations familiar to the target audience, and supports structured job progress and repair without granting generic root execution.

### Consequences

- The executor and its policy become security-critical code requiring independent review.
- Socket group membership is powerful and must remain narrow.
- The first release supports fewer operations/apps than the legacy private path.
- Schema and protocol versions must be maintained compatibly.
- Failure recovery is explicit and idempotent rather than magically transactional.

### Follow-ups

- Convert backup/update/restore/uninstall only after Dinner evidence is accepted.
- Add stronger destructive-operation confirmation and verified-backup gates before restore/uninstall.
- Evaluate executor-local secret generation after the v1 protocol is stable.
- Evaluate SSH repository support only with strict known-host and key policy.
- Expand one catalog shape at a time: simple Node app, Node with storage, Python, sidecar, timer.

## 16. Terra implementation handoff

### Read first

1. This plan and `docs/root-executor-test-spec.md`.
2. `SECURITY.md:1-48`.
3. `install.sh:271-388`.
4. `src/config.js:13-58`.
5. `src/admin-auth.js:141-163`.
6. `src/app.js:1028-1133`.
7. `src/services/job-runner.js:37-52` and `src/services/job-runner.js:213-273`.
8. `src/services/install-planner.js:689-788`.
9. `src/services/bootstrap-planner.js:141-313`.
10. `src/catalog.js:197-273`.
11. `src/manifest-schema.js:1-170`.
12. `src/state/sqlite-driver.js:41-55` and `src/state/sqlite-driver.js:107-134`.

### Non-negotiable implementation constraints

- Do not weaken or remove `NoNewPrivileges=true` from `homebase.service`.
- Do not add `homebase` to sudoers or run the web process as root.
- Do not add a generic root `command`, `script`, executable, path, package, repo, unit, user, or environment operation.
- Do not run npm, application code, or migrations as root.
- Do not persist/log secret bindings.
- Do not silently fall back to `legacy-sudo` when the executor is unavailable.
- Do not claim Dinner installed until readiness succeeds.
- Do not broaden to the rest of the catalog before the Dinner gate passes.

### Permitted judgment calls

- Exact module names and factoring.
- Whether unit templates are checked in or rendered, provided tests cover complete output.
- Choice of JSON Schema validator, provided schema/runtime validation cannot drift and the dependency decision is documented.
- Exact structured event payloads, provided stable common fields, limits, redaction, and terminal semantics remain.
- Whether executor event retention lives only in SQLite or additionally uses journald, provided secrets never enter either.

### Stop and escalate to the lead if

- Dinner cannot be installed without introducing an arbitrary root command primitive.
- A required systemd hardening directive conflicts with core execution and the safe relaxation is not obvious.
- PostgreSQL credential handling would require secrets in argv, logs, or persisted plan JSON.
- The current Family Dinner repository has diverged from the catalog assumptions enough to change the operation model.
- PR #16 changes its privilege boundary or installer ownership model while implementation is underway.
- Test-host behavior differs materially from the Ubuntu 24.04 VM baseline.

### Completion report required from Terra

Return:

- branch and commit list;
- changed-file summary by phase;
- final operation/schema/protocol versions;
- exact fresh-install, repair, bootstrap, and Dinner test commands with outputs summarized;
- VM distribution/version used;
- security-review findings and fixes;
- known gaps/non-goals;
- PR URL and base branch;
- an explicit statement whether any legacy shell path remains reachable from public Dinner execution.

## 17. Execution recommendation

Use a single Terra implementation owner for schema/executor coherence, with independent review after Phase 2 and Phase 5. Parallel implementation is not recommended across the schema, executor, and client until the protocol contract is committed because all three share a security boundary. Test and documentation work may run in parallel after Phase 2.

Recommended handoff prompt:

> Implement `docs/root-executor-implementation-plan.md` from the current PR #16 branch, using `docs/root-executor-test-spec.md` as the verification contract. Work phase by phase, preserving all non-negotiable constraints and stopping at each gate for fresh test evidence. Keep the executor protocol and operation plan schema as the single source of truth. Family Dinner is the only app execution path in scope. Open a stacked PR against `feature/safe-public-installer`, run an independent security/code review, and fix all actionable findings before reporting completion.
