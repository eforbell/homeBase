# Verification Spec: Home Base Root Executor and Family Dinner Golden Path

**Plan:** `docs/root-executor-implementation-plan.md`  
**Required base:** PR #16 / `feature/safe-public-installer`  
**Primary platform:** Ubuntu Server 24.04 LTS VM with systemd  
**Secondary platform:** Debian 12 VM before public-availability claim  

## 1. Verification strategy

Use four layers:

1. **Unit:** schema, canonicalization, digest, policy, redaction, operation handlers, renderers, state migrations.
2. **Integration:** Unix-socket protocol, executor/client, root handler behavior, installer test mode, state/event persistence.
3. **End-to-end:** real systemd VM from fresh Home Base install through Dinner readiness and reboot.
4. **Observability/security:** permissions, uid/gid, logs, journal, SQLite, failure reconciliation, and hostile inputs.

Docker/container tests may supplement handler testing but do not replace VM tests for systemd socket activation, service identities, nginx, PostgreSQL, reboot, or group permissions.

## 2. Test fixtures

- Fixed operation plan fixtures under `test/fixtures/operations/`:
  - valid Dinner host-bootstrap plan;
  - valid Dinner install plan with secret references only;
  - one invalid fixture for every policy/schema boundary.
- A fake spawn adapter that records binary, argv, uid, gid, cwd, env keys, stdin digest, timeout, and kill behavior.
- Temporary managed-root layout with deliberate symlinks and ownership variations.
- Canary secrets containing characters that exercise URL encoding, shell metacharacters, newlines, and regex escaping.
- Rootful integration environment for filesystem identity/mode tests.
- Clean Ubuntu 24.04 and Debian 12 VM snapshots.

No real operator secret may be used in automated tests.

## 3. Unit tests

### 3.1 Schema and canonical digest

- Accept the exact valid v1 Dinner bootstrap/install fixtures.
- Reject missing common fields, duplicate operation IDs, forward `dependsOn`, dependency cycles, invalid risk, excessive timeout, empty operations, unknown operation type, unknown top-level field, and unknown operation field.
- Reject `command`, `script`, `shell`, arbitrary executable path, and raw secret value fields anywhere in the plan.
- Prove canonical key order does not change digest.
- Prove any semantic field change changes digest.
- Prove `secretBindings` are excluded from the plan digest.
- Prove unsupported schema versions fail closed.

### 3.2 Policy

For each policy-controlled value, include one exact allowed case and at least two denied cases:

- package name and package list;
- repository URL and scheme;
- git ref and destination;
- managed filesystem purpose/path;
- symlink parent/final target;
- uid/gid/execution identity;
- PostgreSQL role/database;
- systemd unit;
- port and readiness path;
- npm task enum;
- operation ordering;
- timeout and output cap.

Specific hostile strings:

- `../../etc/shadow`
- `/opt/sovereign-home/apps/familyDinner/../../..`
- `family-dinner.service;reboot`
- `main && id`
- `https://github.com/eforbell/familyDinner.git --upload-pack=/bin/sh`
- `npm` task `install-production;curl ...`
- package `git;reboot`
- user `sovereign root`

### 3.3 Redaction

- Redact every exact canary secret.
- Redact URL-encoded secret forms and credentials embedded in a database URL.
- Redact nested errors, stdout/stderr chunks, event payloads, and rendered plan previews.
- Do not over-redact operation IDs, hashes, timestamps, or harmless exit codes.
- Truncate output before persistence and include a `truncated: true` marker.

### 3.4 Spawn wrapper

- Prove all executions use an absolute approved binary and argv array.
- Prove no shell option is exposed.
- Prove uid/gid are required for non-root operations and npm/git use `sovereign`.
- Prove PostgreSQL operations use `postgres`.
- Prove timeout sends TERM then KILL after a bounded grace period.
- Prove environment contains only allowed keys.
- Prove stdin is not copied into error messages.
- Prove stdout/stderr caps and redaction.

### 3.5 Handlers

For each operation handler:

- successful first run;
- idempotent second run;
- validation/policy denial before spawn/write;
- child failure;
- timeout where applicable;
- output redaction;
- expected audit event fields.

Additional filesystem cases:

- atomic rename occurs in the destination directory;
- mode and owner applied before final rename where feasible;
- invalid existing symlink fails;
- parent realpath escape fails;
- existing preserved Dinner env keys survive reinstall;
- secret-bearing env content never appears in result objects.

Additional git cases:

- clean clone;
- clean fast-forward update;
- correct ref already checked out;
- dirty checkout refusal;
- wrong origin refusal;
- unexpected submodule policy refusal unless explicitly disabled/handled.

Additional PostgreSQL cases:

- role absent/present;
- database absent/present;
- correct owner verification;
- password update policy is explicit and does not silently rotate on reinstall.

### 3.6 Compiler and renderer

- Dinner catalog input produces the expected ordered operation IDs.
- Exact catalog repository, port, service, role/database, readiness path, and npm tasks appear.
- No secret value appears in compiled persisted plan.
- Human preview is deterministic and not executable as a shell script.
- Plan digest accepted by client equals digest recomputed by executor.
- Non-Dinner apps remain unsupported for typed execution.

### 3.7 State migration and reconciliation

- Existing PR #16 SQLite database upgrades without data loss.
- New columns/tables may be initialized repeatedly.
- Event sequence uniqueness is enforced.
- Flat log text is produced only from redacted events.
- Missing terminal executor event cannot produce `completed`/`installed`.
- Duplicate terminal event is idempotent.
- Home Base restart reconciles completed, failed, and in-flight executor requests deterministically.

## 4. Protocol integration tests

Run against the actual executor server in a controlled rootful environment where feasible.

- systemd-passed socket or test-injected listening fd is accepted.
- `hello` returns version/capability/policy metadata.
- `validate-plan` never mutates.
- `execute-plan` produces ordered accepted/start/output/completed/terminal events.
- malformed JSON, oversized request, oversized line, timeout, trailing content, duplicate request ID, stale `issuedAt`, wrong digest, and unsupported version return stable errors; parsing, digesting, validation, and execution all consume the same parsed object.
- one active mutation plan causes a second to receive `EXECUTOR_BUSY`.
- disconnecting the client does not turn success into ambiguity: executor completes/journals or cancels according to documented policy, and Home Base reconciles later.
- executor process crash produces a non-success state; socket activation starts a new process for the next request.
- unrelated user cannot open the socket; `homebase` can; root can.
- executor refuses startup or reports unhealthy when installed code/policy ownership is writable by `homebase` or `sovereign`.

## 5. Installer tests

Extend `test/install-script.test.js`, which asserts `NoNewPrivileges=true` for the web service, to cover:

- fresh rendering of web service, executor service, and executor socket;
- `homebase.service` remains loopback/plan-safe and does not gain sudo;
- dedicated group/user behavior;
- root ownership and modes;
- new environment keys for executor socket/protocol without enabling legacy mode;
- `--dry-run`, `--no-start`, `--repair`, and `--repair-executor`;
- same-version normal rerun preserves code/state;
- repair refreshes executor code/units and preserves state/env/secrets;
- unmanaged install root refusal;
- deleted unit restoration;
- bad socket mode/owner restoration;
- capability check failure produces actionable installer error;
- no secret value is printed.

Shell lint the installer and run its current test mode. Installer unit tests do not replace a real VM run.

## 6. API/UI integration tests

- Plan endpoint returns typed operations and redacted preview for Dinner.
- Dry run works when executor is absent.
- Real Dinner execution requires admin setup, unlock, confirmation, compatible executor, and passing host preflight.
- Absent/incompatible/busy executor returns specific operator-facing errors.
- Real non-Dinner execution returns typed-execution-not-supported and cannot reach legacy shell runner.
- Executor events appear in job status/log view with operation titles and redacted output.
- Installation record stays `planned/installing/failed` until readiness succeeds.
- Admin audit links action, target, job, request ID/digest reference, and outcome without raw session token or secrets.
- Existing PR #16 authorization/session tests remain green.

Add a test spy/invariant that fails if the Dinner route invokes `JobRunner.runCommand` or spawns `/bin/bash`/`/bin/sh`.

## 7. VM end-to-end matrix

### 7.1 Ubuntu 24.04 — required before PR ready

Start from a clean server VM snapshot.

1. Install the PR #16 + executor stacked branch with `install.sh`.
2. Verify:
   - `homebase.service` active and uid `homebase`;
   - `homebase-executor.socket` active;
   - executor starts on `hello`;
   - socket `root:homebase-exec 0660`;
   - no `/etc/sudoers.d/homebase` exists;
   - Home Base loopback health succeeds.
3. Run Dinner-capable typed host bootstrap.
4. Verify packages, identities, directories, nginx, PostgreSQL, and idempotent second run.
5. Configure/unlock admin and execute Dinner install through UI/API.
6. Verify repository origin/ref, file modes/owners, uid/gid of npm/migration, database ownership, service unit, nginx validation, and `/api/ready`.
7. Re-run Dinner install; verify no secret rotation and preserved configured keys.
8. Reboot; verify Home Base, executor socket activation, nginx, PostgreSQL, Dinner service, and Dinner readiness.
9. Damage only executor unit/socket/code ownership; run `--repair-executor`; verify recovery and preserved Home Base/Dinner state.
10. Capture redacted evidence commands and outputs for the PR.

### 7.2 Debian 12 — required before changing Home Base to “Available”

Repeat fresh install, typed bootstrap, Dinner install, reboot, and executor repair. Document any package/binary/systemd differences. Do not broaden policy with arbitrary paths to paper over distribution differences; add an explicit supported-platform mapping.

## 8. Fault-injection tests

On the Ubuntu VM, snapshot before each test:

- kill executor during git sync;
- kill executor after env write but before systemd reload;
- kill Home Base while executor continues;
- reboot during npm install;
- make nginx config invalid before validation;
- stop PostgreSQL before role/database operation;
- make Dinner checkout dirty;
- fill target filesystem enough to fail atomic write;
- remove one secret binding;
- submit two installs concurrently;
- replace an allowed directory with a symlink to `/etc`;
- make executor code group-writable.

For every case verify:

- no false installed state;
- stable terminal/reconciled error;
- no secret leak;
- no unmanaged path mutation;
- retry/repair instructions are accurate;
- a supported rerun either safely continues or refuses with a precise manual action.

## 9. Secret-leak audit

Use a unique canary secret, then search after success and failure:

- Home Base HTTP/API capture;
- Home Base SQLite database, including `plan_json`, `log_text`, result/error fields, and operation events;
- `journalctl -u homebase`;
- `journalctl -u homebase-executor`;
- installer output;
- process list captured during PostgreSQL/npm operations;
- test artifacts and screenshots.

The canary may exist only in the protected final Dinner `.env` and PostgreSQL credential state. Any other hit is a release blocker.

## 10. Static and review checks

- Search executor and typed Dinner path for `/bin/bash`, `/bin/sh`, `sudo`, `eval`, `exec`, `shell: true`, and string command construction.
- Search for child-process calls outside the centralized spawn wrapper.
- Search for writes to `/etc`, `/opt`, `/var/lib`, and `/run` outside approved handlers/installer.
- Review every `uid`, `gid`, `cwd`, env, path, unit, repo/ref, and timeout source.
- Review all event/error serialization through the redactor.
- Review installer ownership/mode behavior on new and existing hosts.
- Independent reviewer must trace one hostile Dinner request from API input to executor rejection and one valid request to every root mutation.

## 11. Required command evidence

At minimum, retain output from:

```bash
npm test
shellcheck install.sh
systemd-analyze verify /etc/systemd/system/homebase.service \
  /etc/systemd/system/homebase-executor.socket \
  /etc/systemd/system/homebase-executor.service
systemctl status homebase homebase-executor.socket --no-pager
systemctl show homebase -p User -p NoNewPrivileges -p FragmentPath
stat -c '%U:%G %a %n' /run/homebase/executor.sock
getent group homebase-exec
curl --fail http://127.0.0.1:3080/api/homebase/health
curl --fail http://127.0.0.1:3000/api/ready
systemctl is-active family-dinner nginx postgresql
journalctl -u homebase -u homebase-executor --since '<test start>' --no-pager
```

If `shellcheck` is unavailable locally, run it in CI or the VM and report the gap before PR review.

## 12. Exit criteria

The implementation is complete only when:

- every acceptance criterion in the main plan has recorded evidence;
- Ubuntu 24.04 fresh install, repair, bootstrap, Dinner install, rerun, and reboot pass;
- Debian 12 status is explicitly recorded before any “Available” label decision;
- canary secret audit has zero unexpected hits;
- the public Dinner route cannot reach legacy shell execution;
- independent security/code review has no unresolved critical/high finding;
- actionable medium findings are fixed or explicitly accepted by the owner with rationale;
- the stacked PR clearly names PR #16 as its base and includes rollback/testing notes.
