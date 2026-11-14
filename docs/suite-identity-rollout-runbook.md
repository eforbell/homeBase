# Suite identity rollout runbook

For the operator of a Home Base host. It takes a host from today's ingress (one TCP gateway, every app behind its own sign-in) to:
1. **the socket switchover**: every service hostname reaches nginx through its own Unix socket, every app listens on loopback or its own socket, sensitive apps run as their own users, and Home Base itself is reached at its own service hostname;
2. **the tailnet sign-in**: Home Base keeps a household directory with passkeys, and apps switch, one at a time, from their own sign-in to the member's tailnet identity.

Each part ends at a **stop point**: a state the host can stay in for as long as you like. Nothing here is required. A host that never starts keeps today's ingress, and its apps keep their own sign-in.

**Status.** The original socket/tailnet sequence ran on a test VM; Part B also ran on one production host. The isolated-account feature has software and supported-Linux test evidence, but physical/provider/deployed-stack acceptance and release gates remain open. The amendment below is an operator draft, not evidence of a new production rollout.

**Placeholders.** `<host>` is the host's MagicDNS name, `<tailnet>` the tailnet domain (`<name>.ts.net`), `<instance>` this household's instance name, `<app>` a catalog app ID, `<key>` a sensitive app's service key (`pulse`, `source`, `helm`, `bitcoin-accounting`).

## Choose the starting point

Use this runbook as the host procedure; do not start a second, parallel cutover.

| Host state | Start here | Preserve |
| --- | --- | --- |
| Fresh supported Linux host, no Home Base | [Release gate](#release-gate-for-instance-isolated-passkeys), then [A0: install and bootstrap](#a0-fresh-host-install-and-bootstrap), then A1 through D | SSH access and the chosen instance name |
| Installer-managed Home Base, directory off | [Release gate](#release-gate-for-instance-isolated-passkeys), then A1 | Existing database, configuration and app credentials |
| Socket ingress complete, directory off | Release gate and A1/A2/A4; A6 if guards are off, then verify B9 and start C after the report period | Existing services and approvals; do not cut over twice |
| Directory active, existing keys work | Release gate and A1/A2/A4, then [healthy active-suite checks](#upgrade-a-healthy-active-suite); C5/C6 only where needed, then C7 | Working legacy credentials, roles, app grants and suite database; no recovery or re-enrollment |
| Directory active, shared key stopped matching | Release gate and A1/A2/A4.1–A4.2, then [incident recovery](#roll-out-without-flipping-the-working-key-again); remaining app updates after recovery | Any working credential and the other suite; no second ingress cutover |
| Directory in setup/recovery | Release gate and A1/A2; A4.1–A4.2 unless already verified on the selected commit. Only after the dependency probe passes, confirm the socket address and finish C4/recovery; app updates follow activation | Existing account namespace; do not reset or re-claim the household |

### Release gate for instance-isolated passkeys

**Production stop gate:** Check source-landing status in Home Base [PR #60](https://github.com/eforbell/homeBase/pull/60) and sovereignAuth [PR #7](https://github.com/eforbell/sovereignAuth/pull/7). Source merges, advisory code reviews and software/container tests do not authorize production. Before using the feature on a production host, record:

- the approved, merged Home Base commit and its final-main sovereignAuth pin, with matching lockfile;
- the required independent/security reviews and the two-suite physical-key/synced-provider rehearsal;
- the tested OS, running Node/Python/SQLite versions, maintenance owner, backup location and rollback limits.

For an authorized disposable-VM rehearsal, you may select an explicitly reviewed candidate commit instead; record it as a candidate, not a release. Do not use a moving branch name as the deployment record or treat a prerelease dependency feature pin as the final production pin. Keep the existing non-production suite on an independent identity database, not a production database clone.

Define the plan before changing the host: target instance, tailnet DNS domain, administrator tailnet login, installed apps to switch, and apps that must remain on their own sign-in. The instance/tag identify the suite operationally; the persisted opaque handles isolate its new credentials. Changing the tag does not migrate keys.

## Rules

- **Rehearse on a test VM first.** A production host changes only after the same steps have passed there, including a rollback.
- **One host at a time, one step at a time.** Do each step's checks before the next step. When a check fails, stop and go to [Recovery](#recovery); don't improvise forward.
- **Have a way back in that doesn't depend on Serve:** an SSH session to the host, open before you start, over its tailnet IP or your LAN. Serve changes don't touch SSH.
- **Order matters both ways.** Forward: ingress, then Home Base, then apps. Back: apps to their own sign-in first, then Home Base, then ingress. Never give apps a TCP path while any of them trusts identity headers; Home Base refuses this too.
- **Keep the old credentials:** the Home Base admin passphrase (in a password manager) and every app's own passphrases and PINs, until each app has run on tailnet identity for your whole rollback window.
- **Never, from a root shell:**
  - write the whole Serve configuration back (`tailscale serve set-config --all`, `set-raw`) or reset it: it silently changes other services (see [Tailscale behaviors](#tailscale-behaviors-this-depends-on));
  - remove a Serve service Home Base manages by hand: the rollback can't put back what it didn't retire itself;
  - reopen `:3080` or a TCP listener to get back in;
  - edit `SOVEREIGN_AUTH_MODE` or `SOVEREIGN_HOMEBASE_UID` in an app's `.env`: use the Network page.

## Part A. Prepare

A0 installs a fresh host; A4 refreshes code and restarts services. Run them in an approved maintenance window. The inventory/backup checks are read-only except for writing protected backups. Part B changes the ingress. Run the guarded `bash` blocks in Bash; their subshells stop on a failed check without closing your SSH session. Set each env key once; edit an existing assignment/remove duplicates instead of repeating an append command.

### A0. Fresh-host install and bootstrap

Skip this subsection on an existing managed host. Use [install.md](install.md) for supported Ubuntu/Debian versions, runtime provisioning and private-repository access. Install/connect Tailscale using its [Linux installation procedure](https://tailscale.com/docs/install/linux); keep an SSH route that does not depend on Home Base or Serve. Joining the tailnet is not app membership.

1. Populate a **root-owned** source checkout at `/root/homebase-src` through approved GitHub access. The example uses HTTPS; private repositories need the host's approved read-only credentials. The installer and its npm dependency fetches must work as root. The executor's `--git-ssh-key` option handles private managed-app fetches; it is not a substitute for access needed to obtain the source/dependency in the first place.
   ```sh
   sudo git clone https://github.com/eforbell/homeBase.git /root/homebase-src
   ```
   If that directory exists, inspect it rather than cloning over it. Set `HOMEBASE_COMMIT` to the approved 40-character commit from the release/rehearsal record, and `INSTALLER_VERSION` to the reviewed installer version label (for example, `v0.1.0` only where that label applies):
   ```bash
   (
   set -euo pipefail
   : "${HOMEBASE_COMMIT:?set the approved immutable Home Base commit}"
   : "${INSTALLER_VERSION:?set the reviewed installer version label}"
   test "$(sudo git -C /root/homebase-src status --porcelain)" = ""
   sudo git -C /root/homebase-src fetch origin
   sudo git -C /root/homebase-src checkout --detach "$HOMEBASE_COMMIT"
   test "$(sudo git -C /root/homebase-src rev-parse HEAD)" = "$HOMEBASE_COMMIT"
   sudo bash /root/homebase-src/install.sh --source-dir /root/homebase-src --version "$INSTALLER_VERSION" --dry-run
   )
   ```
   Inspect the preview. If it succeeds and matches the maintenance plan, apply in a separate command:
   ```bash
   (
   set -euo pipefail
   : "${HOMEBASE_COMMIT:?set the approved immutable Home Base commit}"
   test "$(sudo git -C /root/homebase-src status --porcelain)" = ""
   test "$(sudo git -C /root/homebase-src rev-parse HEAD)" = "$HOMEBASE_COMMIT"
   : "${INSTALLER_VERSION:?set the reviewed installer version label}"
   sudo bash /root/homebase-src/install.sh --source-dir /root/homebase-src --version "$INSTALLER_VERSION"
   systemctl is-active homebase homebase-executor.socket
   )
   ```
   The installer installs services, not the app suite or the host bootstrap. It refuses an existing unsupported Node runtime instead of replacing it under other services. Follow the Node upgrade procedure first if needed; do not change system runtimes mid-cutover.
2. From the operator workstation, open the setup-only SSH tunnel:
   ```sh
   ssh -N -L 3080:127.0.0.1:3080 <you>@<host>
   ```
   Open `http://127.0.0.1:3080/admin`, configure/unlock the admin passphrase, and store it in the operator's password manager. In Config, set the intended host/domain and review **Bootstrap / repair host** before running the typed bootstrap. Check its completed job and preflight results:
   ```sh
   systemctl is-active nginx postgresql
   sudo nginx -t
   ```
   Do not enable `HOME_BASE_DIRECTORY` yet. Passphrase setup here is not C4's claim of the tailnet administrator.
3. Install the selected apps from their Home Base pages in their own sign-in mode, one at a time. Complete their initial setup and record their local credentials; check health and take an app backup before proceeding. Use the supported executor/adoption procedure for apps that predate Home Base management. Keep automatic bootstrap off and confirm changes through the typed plans, not shell commands pasted into the web service.

**Stop point A0.** Managed web/executor and host bootstrap are healthy; chosen apps work locally behind the existing gateway. Continue A1. Leave the directory off through Part B so you can finish publishing/moving the ingress before passkey setup restricts privileged changes.

### A1. Check the starting point

```sh
sudo grep -E '^HOME_BASE_(EXECUTION_MODE|STATE_DB|DATA_DIR|IDENTITY_SIGNING_KEY|INSTANCE)=' /etc/sovereign-home/homebase.env
systemctl is-active homebase homebase-executor.socket
tailscale version
```

- `HOME_BASE_EXECUTION_MODE=executor`, and both units `active`. A host still on the legacy sudo installer moves to the executor first: [executor-app-runbook.md](executor-app-runbook.md), "Moving a legacy host".
- `HOME_BASE_STATE_DB` points under `/var/lib/sovereign-home/homebase`. Home Base keeps its other files beside it. (Before a fix from this rollout, a host with only `HOME_BASE_STATE_DB` kept them in its checkout, where they couldn't be written. Updating Home Base fixes that.)
- Tailscale 1.104.4 or later, the version these steps were checked on.

### A2. Back up, and write down where things are

Confirm the service's **effective** database and signing-key paths, including systemd overrides (`systemctl cat homebase` and A1's filtered env check); do not publish the unfiltered unit/env output or source its environment file in a shell. The paths below are the installer defaults. Adjust them if configured differently, and stop if the database is missing or the path is ambiguous. Keep enrollment, revocation and signing-key rotation paused during the backup. Treat every backup as secret and root-only.

```bash
(
set -euo pipefail
DB=/var/lib/sovereign-home/homebase/home-base.sqlite3
KEY=/var/lib/sovereign-home/homebase/identity-signing-key.pem
DIRECTORY_NEVER_ENABLED=no  # set yes only after confirming it has never been enabled
sudo test -f "$DB"
D=$(sudo mktemp -d /root/homebase-rollout-XXXXXXXX)
sudo chmod 0700 "$D"
printf 'Protected rollback directory: %s\n' "$D"
sudo tar czf "$D/etc-nginx.tgz" /etc/nginx
sudo tar czf "$D/etc-sovereign-home.tgz" /etc/sovereign-home
sudo python3 - "$DB" "$D/home-base.sqlite3" <<'PYTHON'
import pathlib, sqlite3, sys
source = sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)
with sqlite3.connect(sys.argv[2]) as backup:
    source.backup(backup)
    assert backup.execute('PRAGMA quick_check').fetchall() == [('ok',)]
source.close()
PYTHON
if sudo test -f "$KEY"; then
  sudo cp -p "$KEY" "$D/identity-signing-key.pem"
  KEY_DIR=$(dirname "$KEY")
  KEY_NAME=$(basename "$KEY")
  RETIRED="$KEY_DIR/${KEY_NAME%.*}-retired.json"
  if sudo test -f "$RETIRED"; then
    sudo cp -p "$RETIRED" "$D/identity-signing-key-retired.json"
  fi
  sudo cmp "$KEY" "$D/identity-signing-key.pem"
else
  test "$DIRECTORY_NEVER_ENABLED" = yes || { printf '%s\n' 'STOP: effective signing key missing' >&2; exit 1; }
  printf '%s\n' 'Never-enabled directory: no signing key to copy.'
fi
sudo test -s "$D/home-base.sqlite3"
sudo tailscale serve status --json | sudo tee "$D/serve-status.json" >/dev/null
if ! sudo tailscale serve get-config --all | sudo tee "$D/serve-config.json" >/dev/null; then
  printf '%s\n' 'STOP: database/key backups exist, but Serve capture is incomplete. See A3 root-handler check before proceeding.' >&2
  exit 1
fi
)
```

If the directory has ever been enabled, require the effective signing key and verify its backup before continuing. A never-enabled host has no key yet. Confirm never-enabled status from the operator history and database state before allowing a missing key; an existing household row, or uncertainty about prior use, is reason to stop for investigation. Also copy any configured data-directory control files such as `ingress-confirmations.json` into the protected directory; do not replace the SQLite backup with a live database file copy. Record the printed backup path and the current code/dependency commits. These backups support case-specific recovery; restoring an old database can undo revocations and is not routine rollback.

Then back up every installed app from its page in Home Base (**Backup**).

### A3. Read-only checks

```sh
tailscale status --self --peers=false                  # tagged? which tags?
sudo tailscale serve status --json                     # every service and node-level entry, with its frontend
sudo ss -ltnp                                          # who listens where: 0.0.0.0, 127.0.0.1, sockets
sudo nginx -T | grep -nE 'include|listen|stream'       # what nginx actually loads
systemctl list-units --type=service --no-legend --plain | awk '{print $1}' \
  | while read -r u; do echo "$u $(systemctl show "$u" -p User --value)"; done | grep ' sovereign'   # which user each app runs as
```

Must pass before Part B:
- [ ] `sudo tailscale serve get-config --all > /dev/null; echo $?` prints `0`. It fails with `root handler not set` when any service, even one that isn't Home Base's, has only a path handler. Home Base reads this command to see what it has published, so while it fails, every service looks unpublished and the Network page can't go past B5. Give that service a root handler, or wait for Home Base to stop depending on this command; don't start Part B.

Write down:
- [ ] **How you reach Home Base today.** Home Base listens on loopback `:3080` only; you reach it through Serve, either a node-level entry or the old managed service. If it is the old managed service, the cutover (B4) takes that way away before Home Base's new address exists (B5). Either way, set up the fallback below before Part B.
- [ ] **Serve services that aren't Home Base's** (a Lightning node, another app). Home Base never changes them; check they are unchanged at the end of Part B.
- [ ] **The old managed service** (usually `svc:home`, or one named after the host). The cutover retires it from this host, and a rollback puts it back. If it has already been removed by hand, a rollback can't restore it.
- [ ] **nginx's shape.** Does `/etc/nginx/nginx.conf` include `sites-enabled` inside its `http` block? Does any server block of yours include `/etc/nginx/sovereign-home.d/*.conf` (an adopted host)? Is there a `stream` block (an Electrum server, for example)? Step B3 depends on all three.
- [ ] Which units run as `sovereign`, and which as `sovereign-<key>`.
- [ ] Any node-level Serve entry on `:443`. A rollback needs nginx to bind 443, and that entry would block it.

### A4. Install the selected Home Base code, then update every app

**Code rollback gate:** Before selecting any older commit, inspect `webauthn_v2_issued_at` with [the read-only diagnostic](#diagnose-metadata-without-exposing-keys). After it is set, do not install a pre-compatibility binary: it lacks a startup guard and can issue shared handles again. An older commit is not safe merely because the installer accepts its version label. A null marker is necessary for considering a pre-feature rollback, not proof that other schema/ingress changes are reversible; use only a rehearsed, approved rollback. After isolated issuance, keep a reviewed compatible build and use Recovery for failed access instead.

On an existing installer-managed host, use a maintenance window with no running executor job and no credential enrollment. The installer also checks idle state. If it cannot confirm that state, stop; do not add `--force`. Do not use this path over an unmanaged checkout or legacy sudo install; use the migration procedure linked in A1. `--repair --dry-run` briefly creates an executor maintenance flag and checks idle state, then releases it; it is not entirely read-only or a complete validation of Node, source, dependencies or the eventual repair.

1. Select the approved immutable `HOMEBASE_COMMIT` in the clean root-owned source checkout, as in A0. Stop if it has local modifications; do not reset or clean them away. Preserve the **installed** version marker when refreshing source:
   ```bash
   (
   set -euo pipefail
   : "${HOMEBASE_COMMIT:?set the approved immutable Home Base commit}"
   test "$(sudo git -C /root/homebase-src status --porcelain)" = ""
   sudo git -C /root/homebase-src fetch origin
   sudo git -C /root/homebase-src checkout --detach "$HOMEBASE_COMMIT"
   test "$(sudo git -C /root/homebase-src rev-parse HEAD)" = "$HOMEBASE_COMMIT"
   INSTALLER_VERSION=$(sudo cat /opt/sovereign-home/homebase/.homebase-version)
   sudo bash /root/homebase-src/install.sh --source-dir /root/homebase-src --version "$INSTALLER_VERSION" --repair --dry-run
   )
   ```
   Inspect the preview. If it succeeds and matches the maintenance plan, apply in a separate command:
   ```bash
   (
   set -euo pipefail
   : "${HOMEBASE_COMMIT:?set the approved immutable Home Base commit}"
   test "$(sudo git -C /root/homebase-src status --porcelain)" = ""
   test "$(sudo git -C /root/homebase-src rev-parse HEAD)" = "$HOMEBASE_COMMIT"
   INSTALLER_VERSION=$(sudo cat /opt/sovereign-home/homebase/.homebase-version)
   BEFORE_START=$(systemctl show homebase -p ExecMainStartTimestampMonotonic --value)
   sudo bash /root/homebase-src/install.sh --source-dir /root/homebase-src --version "$INSTALLER_VERSION" --repair
   test "$(systemctl show homebase -p ExecMainStartTimestampMonotonic --value)" != "$BEFORE_START"
   systemctl is-active homebase homebase-executor.socket
   test "$(sudo cat /opt/sovereign-home/homebase/.homebase-source-commit)" = "$HOMEBASE_COMMIT"
   systemctl show homebase -p MainPID -p ExecMainStartTimestamp
   )
   ```
   The recorded source commit must equal the selected commit, and the web process must have restarted. `--repair` refreshes web, executor, shared modules and locked dependencies while preserving state/configuration. A same-version rerun without it preserves old code; `--repair-executor` is not the full refresh. The installed version label and source commit are different records: this is source repair, not a supported version-marker upgrade. Do not edit the marker to bypass a refusal. A failed apply can leave partially refreshed code/dependencies even when the source marker changed. Stop, fix the cause and rerun the same selected apply; do not restart a mixed tree by hand or infer success from the marker alone.
2. Confirm the new service and its locked passkey dependency agree **before any key registration**. Run the following with the binary of the running service; it creates only transient in-memory options, with no browser/authenticator or database enrollment:
   ```bash
   (
   set -euo pipefail
   PID=$(systemctl show homebase -p MainPID --value)
   test "${PID:-0}" -gt 0
   sudo "/proc/$PID/exe" --version
   sudo "/proc/$PID/exe" - /opt/sovereign-home/homebase <<'NODE'
   const assert = require('node:assert/strict');
   const path = require('node:path');
   const { createWebAuthn } = require(path.join(process.argv[2], 'node_modules/sovereign-auth'));
   (async () => {
     const service = createWebAuthn({ rpID: 'deployment-probe.invalid', requireUserHandle: true });
     const expected = Buffer.alloc(32, 7).toString('base64url');
     const request = { hostname: 'test.deployment-probe.invalid', member: { userId: 'deployment-probe', userHandle: expected }, purpose: 'enroll' };
     const options = await service.registrationOptions(request);
     assert.equal(options.user.id, expected);
     await assert.rejects(service.registrationOptions({ ...request, member: { userId: 'deployment-probe' } }));
     console.log('Locked passkey dependency: explicit handles and strict mode OK');
   })().catch((error) => { console.error(error.message); process.exitCode = 1; });
   NODE
   )
   ```
   This child-process probe checks installed files/API, not the old daemon's module cache. Use it together with the restart/start-time check. After C3 (or on a directory already enabled), open the tailnet Passkeys page and confirm the running backend supplies instance/format diagnostics. On `PASSKEY_LIBRARY_MISMATCH`, stop enrollment and repair the install/restart; do not reset the key or work around it with an old binary.
3. Update each app from its page, one at a time. After the update, every app listens on loopback only (`HOST=127.0.0.1`) or, for socket apps, on its own socket. Anything that used an app's port directly (`http://<host>:3000/…`, a bookmark, a script) must now use its Home Base address.
4. Check each app is healthy on its page before the next. A red badge between the Home Base refresh and app updates is real: health checks still reach an app on its old port until it is updated.

### A5. Move each sensitive app to its own user

A sensitive app installed before its own user existed still runs as the shared `sovereign` user. Its page's **Runs as** card says so. One app at a time, while it is still on its own sign-in:

1. Its page → **Runs as** → preview, then **Move to its own user** (type `MOVE`). It takes a safety backup, stops the app, creates `sovereign-<key>`, hands over its checkout, storage, backups and `.env`, rewrites its units, starts it and waits for it. Expect a minute or two of downtime. Don't create mounts inside the app's folders while it runs.
2. Check on the host:
   ```sh
   systemctl show <unit> -p User --value                       # sovereign-<key>, for every unit of the app
   sudo ls -la /run/sovereign-apps/<app>                        # drwxr-s--- sovereign-<key> www-data, and srw-rw---- app.sock
   sudo -u sovereign curl -s --unix-socket /run/sovereign-apps/<app>/app.sock http://localhost/<health>   # must fail
   sudo -u www-data  curl -s --unix-socket /run/sovereign-apps/<app>/app.sock http://localhost/<health>   # answers
   ```
   - [ ] `sudo -u sovereign` can't read its `.env` or list its checkout, storage or backups;
   - [ ] nothing listens on its old port (`sudo ss -ltnp`);
   - [ ] a page that reads data works, and its log has no `password authentication failed`;
   - [ ] update, backup and restart still work.
3. Then the next app.

If the move stops part way (a failure, a reboot), every other plan for that app refuses until **Move to its own user** runs again: it carries on from where it stopped, as the app's own user. Two known causes:
- *"… must be owned by root before … can be handed over"*: a host set up by the legacy installer, with a Home Base from before the fix, left `/var/lib/sovereign-home/<app>` owned by the shared user. `sudo chown root:root` and `sudo chmod 755` that one directory, then move again.
- A mount inside the app's folders: the move refuses any mount it finds there. Unmount it, then move again.

The move is one way: there is no move-back action. If the app misbehaves afterwards, **Restore** the safety backup the move took; the files stay with the new user, and the app stays on its socket. A problem with the socket itself is undone only by a Home Base release whose catalog sets the app back to `runtime.listen: 'tcp'`, followed by an update of the app. Neither path has been rehearsed.

### A6. Start Home Base's request guards in report mode (optional, start early)

The guards need a few days of reports before you enforce them in step C1, so start them now if you plan Part C:

```sh
echo 'HOME_BASE_REQUEST_GUARDS=report' | sudo tee -a /etc/sovereign-home/homebase.env
sudo systemctl restart homebase
journalctl -u homebase -n 50 | grep 'request guards: report'
```

Use Home Base as usual, from every browser and device that opens it.

**Stop point A.** Same addresses, same sign-ins. Apps on loopback or sockets, sensitive apps on their own users.

## Part B. The socket switchover

Plan a quiet hour. **Apps are unreachable from the cutover (B4) until their service is published (B5, B7):** usually a few minutes each, plus 35–40 seconds for each new hostname's first certificate. Home Base stays reachable the whole time.

### B1. Tailnet console

Merge the policy examples into the existing document, preserving unrelated rules/groups. Review the console policy tests before applying. Use the official [Services](https://tailscale.com/docs/features/tailscale-services) and [tags](https://tailscale.com/docs/features/tags) references if the console differs from the tested baseline.

1. **Choose the instance name**: lowercase letters, digits and single dashes, at most 24 characters, starting with a letter (`smith`). It prefixes every service. **Changing it after the cutover isn't supported** (see [Tailnet rename](#tailnet-rename)), so choose carefully.
2. **Define the services** on the console's Services page, each with port `tcp:443`:
   - `svc:<instance>-home`: every low-friction app, by path (`/dinner/`, `/plan/`, …);
   - `svc:<instance>-homebase`: Home Base itself, and later all passkey management;
   - `svc:<instance>-<key>` for each **installed** sensitive app.
3. **Preserve operator SSH access before tagging.** Add/review the grant for the operator to reach this host on SSH, keep the original session open, then test a second connection after the policy/tag change. Tagging changes the server's network identity; do not rely on a user-owned-device rule still applying. **Give this host its own tag**, owned by the administrator alone and held by no other machine, then add it to the host on the Machines page:
   ```jsonc
   "tagOwners": { "tag:<instance>-host": ["<administrator login>"] }
   ```
4. **Approve only that tag** for each service:
   ```jsonc
   "autoApprovers": { "services": {
     "svc:<instance>-home":     ["tag:<instance>-host"],
     "svc:<instance>-homebase": ["tag:<instance>-host"],
     "svc:<instance>-pulse":    ["tag:<instance>-host"]
   } }
   ```
   Never approve a tag that several hosts share. Any host holding it can become an approved standby, with a valid certificate for the hostname, and take the service's traffic when this host stops serving. Home Base refuses to publish while another host is approved, but the policy is the boundary.
5. **Review each service's existing approvals** and remove any host but this one. Tightening approvers doesn't revoke approvals that already exist.
6. **Grant members the addresses they use.** A member not granted an address gets a DNS error for it, not a refusal. All members using the Home Base launcher, including kids without passkeys, need `svc:<instance>-homebase`. It hosts their app list and onboarding welcome as well as passkey management; reaching it does not grant administrator access. App services still need their own network grants.
   ```jsonc
   { "src": ["group:family"], "dst": ["svc:<instance>-home", "svc:<instance>-homebase", "svc:<instance>-pulse"], "ip": ["tcp:443"] }
   ```
7. **Turn on Tailnet Lock** if it isn't on, so a leaked tagged auth key can't add a host without a trusted signature.

Done in another order, this host can lose its approvals while a stale host keeps its own.

### B2. Home Base settings

```sh
echo 'HOME_BASE_INSTANCE=<instance>' | sudo tee -a /etc/sovereign-home/homebase.env
sudo systemctl restart homebase
```

Home Base's configured domain must be the tailnet domain.

**How Home Base verifies the service hosts.** Choose one:
- **Automatic (recommended).** Create a trust credential (OAuth client, Settings → Trust credentials) with **Services: Read**, **Devices → Core: Read** and **Policy File: Read** only, and store it readable by Home Base alone:
  ```sh
  read -rs -p 'client id: ' ID; echo; read -rs -p 'client secret: ' SECRET; echo
  printf 'TS_OAUTH_CLIENT_ID=%s\nTS_OAUTH_CLIENT_SECRET=%s\n' "$ID" "$SECRET" \
    | sudo install -m 400 -o homebase -g homebase /dev/stdin /etc/sovereign-home/tailscale-api.env
  unset ID SECRET
  ```
  Home Base then lists every host of each service, standbys included, requires exactly one approved host (this one), and warns about shared approver tags and extra tag holders. **Never give it write scopes:** a credential that can approve hosts could approve an attacker's machine.
- **By hand.** Without a credential, you check each service's page in the console yourself and press **I checked the console: no other host is approved** on the Network page. A confirmation lasts 30 days; once Home Base is active (Part C) it needs the hardware key.

### B3. nginx (adopted or custom hosts only)

Skip this if `/etc/nginx/nginx.conf` already includes `sites-enabled` in its `http` block and none of your own server blocks include `/etc/nginx/sovereign-home.d/*.conf`. The cutover checks both and refuses, before changing anything, if either is wrong.

Otherwise, **right before B4**, because your apps stop answering through your own site from the moment you save this:
1. Remove `include /etc/nginx/sovereign-home.d/*.conf;` from your own server block. Keep the rest of the site. Kept, it would go on serving apps over TCP, where any local process can pretend to be a member.
2. Inside the `http` block of `/etc/nginx/nginx.conf` add:
   ```nginx
   include /etc/nginx/sites-enabled/sovereign-home*;
   ```
   **Use the pattern, with the `*`.** The gateway file doesn't exist until the cutover writes it, and nginx refuses an include of a missing file but accepts a pattern that matches nothing yet. Keep everything else in the file, including any `stream` block.
3. `sudo nginx -t && sudo systemctl reload nginx`.

### B4. Cut over

**First, a way into Home Base that doesn't depend on Serve.** From your computer, leave this running:
```sh
ssh -N -L 3080:127.0.0.1:3080 <you>@<host>
```
Open `http://localhost:3080/` and check that you can unlock admin there. An open SSH shell alone isn't enough: you need the Network page to publish Home Base's new service.

Then: Network page → **Cut over to per-service sockets**. In one job it:
- creates the socket directories (`/run/sovereign-serve`, root only; `/run/homebase-identity`, Home Base and nginx);
- writes the socket gateway (one server block per service, no TCP listener) and the identity check;
- re-renders every installed app's nginx snippet for its service;
- reloads nginx, and checks that nginx really loaded the gateway and every service socket answers;
- retires the old managed service from this host. Serve services Home Base didn't create are not touched.

**Home Base stays on loopback `:3080`.** It moves in B6, once its new address works. If you reached it through the old managed service, use the SSH tunnel above until B5.

Check:
- [ ] The job succeeded. Its last line names the instance, `Home Base on port 3080`, and the app snippets it wrote.
- [ ] `sudo nginx -T | grep -c 'sovereign-ingress: sockets'` prints `1`.
- [ ] `sudo ss -ltnp | grep -E ':(80|443) '` shows only tailscaled's listeners on the host's tailnet addresses.
- [ ] `journalctl -u homebase -n 50 | grep 'identity lookups on /run/homebase-identity/identity.sock'`.

If it fails, see [Recovery](#recovery). **Roll back ingress** on the same page undoes it.

### B5. Publish Home Base's service, and open it

Network page → `homebase` row → **Publish**. Home Base refuses while another host is approved for it. Then:
- [ ] The row shows `verified` (automatic) or, after you confirm it by hand, `confirmed`.
- [ ] `https://<instance>-homebase.<tailnet>/` opens Home Base from your own device. The first certificate takes 35–40 seconds. With an API credential Home Base fetches it while publishing; without one, your first visit waits for it (up to a minute).

**Don't go on until that address loads.** If it doesn't: is this host approved for the service in the console, and does your device's grant include it?

### B6. Move Home Base to its socket

Network page → **Move Home Base to its socket**. It refuses until its service is published on this host and nginx reaches Home Base through it. With an API credential it also opens the new address itself; without one, you confirm that you opened it.

From then on `:3080` is no longer Home Base. Pages redirect to `https://<instance>-homebase.<tailnet>/` (same path), other requests get `421 HOME_BASE_MOVED`, and only `GET /api/homebase/health` still answers there, for the installer. That closes the loopback port to a local process that could pass as a member.

- [ ] `https://<instance>-homebase.<tailnet>/` works, signed in as before.
- [ ] The old `:3080` address redirects to it.

### B7. Publish the other services

`home`, then each sensitive app, one at a time, from the Network page. After each:
- [ ] `verified` (or `confirmed`);
- [ ] `https://<service>.<tailnet>/<app>/` loads each app on it.

### B8. Update every app, so each learns its new address

The cutover rewrote nginx, not the apps' `.env` files. Update each app from its page. Then each app's addresses (`APP_URL`, `APP_PUBLIC_URL`, `HELM_PUBLIC_URL`, local font URLs) use its service hostname.

**External callbacks.** An update re-renders callback addresses, unless the app keeps them:
- **Family Plan:** `GOOGLE_REDIRECT_URI` moves to `https://<instance>-home.<tailnet>/plan/api/google-calendar/oauth/callback`. Add it in the Google Cloud console before anyone reconnects a calendar. Keep the old one listed through the rollback window.
- **Family Pulse:** `PLAID_OAUTH_REDIRECT_URI` and `PLAID_ENV` are kept as you set them. Plaid uses the redirect URI only inside webviews (an iOS wrapper); desktop and mobile browsers use a popup. Whether to register a tailnet address with Plaid, or keep a public callback, is your call: Plaid doesn't separate sandbox from production redirect URIs.
- **Helm:** `SCHWAB_CALLBACK_URL` is yours to set and updates keep it. If it points at the host's old address, change it at Schwab and in Helm together.

### B9. Verify

From a member's device, and from the host. The full list, including forged-header and cross-site checks, is in [Verification checklists](#verification-checklists); these are the ones to do now:
- [ ] Every installed app loads at `https://<service>.<tailnet>/<app>/`, and `…/<app>` (no slash) redirects to `…/<app>/` on the same hostname, never `localhost`.
- [ ] An app's mount on another service's hostname is refused (404).
- [ ] `curl -k https://127.0.0.1/` on the host fails: no TCP listener.
- [ ] Each Serve service you recorded in A3 that isn't Home Base's is unchanged (`sudo tailscale serve status --json`).
- [ ] Update, backup and restart work for one app of each kind.

### B10. Tell members

New addresses; update bookmarks and the iOS wrapper's start URL.

**Stop point B.** Every service on its own hostname over sockets; Home Base on its socket; every app still on its own sign-in. A host can run like this indefinitely. Retire the `:3080` redirect later (Part D).

## Part C. The tailnet sign-in

### C1. Enforce Home Base's request guards

If guards are off, perform A6 and collect its report period first. If already in report mode, review the existing period; if already enforced, verify its checks without resetting it. After A6's few days:
```sh
journalctl -u homebase | grep 'would refuse'
```
Each line names the method, path, reason, `Origin` and `Sec-Fetch-Site`. Home Base's own pages should cause none; a line you don't expect names the page or client to fix first. Then set `HOME_BASE_REQUEST_GUARDS=enforce` and restart Home Base.

- [ ] Home Base's pages, jobs and settings work as before, and a link to Home Base from another app opens it.

### C2. Health alerts

Config → **Health alerts**: tick **Enable critical health alerts**, set the **Health alert webhook URL**, press **Save config**, then **Send test alert** (it uses the saved settings), and check that it arrives. With alerts on, opening recovery sends a notice naming the tailnet account that did it, which is how you learn if it wasn't you. A notice that fails to send is logged, and doesn't stop recovery.

### C3. Turn on the household directory

```sh
sudo sed -i '/^HOME_BASE_IDENTITY_PREVIEW=/d' /etc/sovereign-home/homebase.env
echo 'HOME_BASE_DIRECTORY=on' | sudo tee -a /etc/sovereign-home/homebase.env
sudo systemctl restart homebase
journalctl -u homebase -n 50 | grep 'household directory: publishing'
```

On a newly initialized identity database, Home Base comes up in **setup**. Confirm B6 is complete before this step: passkeys cannot be enrolled through the SSH tunnel or old port. An existing database may instead be active/recovering; do not re-claim it, turn the directory off, or reset it just to repeat this walkthrough. Follow the starting-point table and account-upgrade section. During setup/recovery, finish credentials before attempting the remaining privileged changes.

### C4. Set up the administrator

On `https://<instance>-homebase.<tailnet>/admin`:
1. For first setup only, unlock with the passphrase from the intended administrator's **own, untagged user device**. Confirm the displayed tailnet login before claiming the household. The tagged server is not the administrator's browser identity.
2. Under **Passkeys**, register:
   - a synced passkey, for daily use;
   - a hardware security key, with **It's a hardware security key** ticked (it must prove its maker; only keys from a vendor sovereignAuth pins count);
   - a second hardware key, kept offline as a spare.
3. On the compatible build, newly enrolled entries must show **Isolated**; confirm the instance and check the actual credentials. Stop on a namespace/library error rather than deleting entries or falling back to shared handles. **Finish setup with my hardware key.** Home Base becomes **active**. That tap also opens admin for 8 hours.
4. **Without an API credential, confirm each service again.** Confirmations from Part B were made with the passphrase; once Home Base is active, an app can switch only on a service confirmed with the hardware key. On the Network page press **I checked the console: no other host is approved** for each service, after checking the console again. Until you do, **Use tailnet identity** doesn't appear.
5. Confirm that the UI offers the passphrase only for **Enter recovery**. Do not enter it merely as a read-only test: entering recovery ends sessions across the suite. Test that state transition on the rehearsal host or in an approved production recovery window. From now on **Unlock admin with a passkey** opens admin, and **Lock admin** closes it in that browser. Adding or removing an administrator passkey, and every privileged plan, asks for the hardware key each time.

Home Base signs its sessions with its own key, beside its database. Rotate it under **Signing key** on the Passkeys card (hardware key each time); tick **It may have been exposed** only if it may have been, because that ends every session at once.

### C5. Add members, and enroll passkeys only when needed

1. Ask the person to open `https://<instance>-homebase.<tailnet>/` from their own device, signed in to the tailnet as themselves. The welcome page names their account and explains that the administrator must add them. Once ingress has observed the visit, the page confirms that the account is visible in Members for a day. If it does not, check their tailnet connection and Home Base service grant before continuing.
2. Admin → **Members** → **Add a member** → **Check again**. Pick their role (**parent** or **kid**: there is no default) and **Add member**. Their visible welcome page checks every 10 seconds while awaiting admission, then switches to **Your apps**. They can also select **Check again**. Only the administrator grants membership and app access.
3. Passkeys are not required to discover apps or use low-friction apps. Kids' supported, scoped views in sensitive apps also stay at tailnet level (D7). For a member who needs passkey-protected access, use **Issue enrollment code** on their row. The code works once, for 15 minutes, only on Home Base's own address. Give it to them in person; they use **Have a passkey enrollment code?** on Home or open Admin, enter it under **Passkeys**, and register one. Enrollment does not grant membership or app access.

By default a member reaches every installed app except trading and Bitcoin accounting, which only the administrator reaches. To change one member's apps, open **Change apps** in their row on the Members card and choose the default or a list of the apps installed here. A change ends the passkey confirmations they gave apps; an app asks again when it needs one.

### C6. Switch each app

The installed app version and the selected Home Base catalog must both support the switch. In this branch the declared support is:

| Apps | Service / target mode |
| --- | --- |
| Family Help, Family Dinner, Family Plan, Fast to Eat, Home Ops, Remind Me | Shared `svc:<instance>-home`; eligible for tailnet identity after the deployed-version checks |
| Family Pulse | Dedicated `svc:<instance>-pulse`; eligible after its own-user/socket and version checks |
| Home Source | Dedicated `svc:<instance>-source`; eligible after its own-user/socket and version checks |
| Helm, Bitcoin Accounting | Dedicated services/sockets, but **no catalog tailnet-mode declaration in this branch**; keep their own sign-in |
| Bug Base, Home Drop | **No catalog tailnet-mode declaration in this branch**; keep their own sign-in |

Re-check the actual release catalog and the Network row, not only this table. A service hostname, socket, or Home Base app grant does not prove an app implements identity-aware authorization. If the deployment requires every installed app to use suite identity, hold acceptance until the missing app integrations ship; do not set its env mode by hand or mark it complete because another app works. Preserve network/ingress protections for apps kept local as well as their own credentials.

Per eligible app, starting with a low-friction one:
1. **Update it** to a version that supports tailnet identity (its Network row stops saying "this version can't use tailnet identity yet").
2. Network page → its row → **Use tailnet identity**, with the hardware key. Home Base offers it only when the host is cut over, the app's service is published and verified (or confirmed), and the app supports it. The executor checks again, then writes the mode into the app's `.env` and restarts it. It refuses, saying why, when:
   - the app isn't on its socket (update it);
   - its address isn't its service hostname yet (update it: step B8);
   - a sensitive app still runs as `sovereign` (step A5).
3. **Link members**, once, where the app requires a mapping: each parent opens `https://<service>.<tailnet>/<app>/`, lands on its **link** page, and matches each household member to the app's own person. A sensitive app asks for a passkey first.
4. Check:
   - [ ] each member lands as themselves;
   - [ ] a kid sees only what kids see, and parent-only actions refuse them;
   - [ ] someone without access sees "ask whoever runs Home Base";
   - [ ] a sensitive app asks parents for a passkey, about once a month per device.
5. Back out: **Return to its own sign-in** on the same row. Its own passphrases and PINs still work.

### C7. Operator acceptance and handoff

Before declaring this host complete, record:
- [ ] Exact Home Base/dependency commits, running runtime versions, instance/tag/domain and backup references; no unresolved release gate.
- [ ] Home Base on its strict tailnet socket address, directory **active**, correct administrator identity, actual passkey checks and the expected **Isolated** or retained **Legacy (compatible)** entries. The passphrase opens recovery, not active admin by itself.
- [ ] Each targeted supported app shows tailnet mode and passes parent/kid/access-denied checks. Each excluded/unsupported app is listed as **local**, with its own sign-in verified. A narrower result is not "all installed apps converted."
- [ ] Each member has the intended app list and local-person mappings; no enrollment code substituted for admission, network access or app permission.
- [ ] For multiple suites using one hardware key, perform [the two-suite account checks](#roll-out-without-flipping-the-working-key-again) on the actual devices/providers, in both orders, and after service restarts. Keep any still-working legacy second credential; a software fixture is not this acceptance result.
- [ ] During the next approved privileged plan, observe the hardware-every-time confirmation. Do not launch an unapproved mutation just to test the prompt. Keep read-only checks separate from changes.
- [ ] Health alerts, backup/restore evidence and one switched app's return-to-local rehearsal are recorded; other Serve services remain unchanged.
- [ ] Operator handoff includes recovery credentials/storage, the code downgrade floor after `webauthn_v2_issued_at`, the unsupported active-directory ingress rollback, and the maintenance owner/rollback window.

**Stop point C.** Members sign in with their tailnet identity in each verified switched app; explicitly excluded apps retain their own sign-in.

## Part D. Clean-up

After the rollback window:
- Retire the `:3080` redirect: `HOME_BASE_LOOPBACK=off` in `homebase.env`, then restart Home Base. Nothing listens on `:3080` afterwards, and the installer checks health on the socket. A rollback of the ingress opens it again.
- Remove the old provider callback URLs you kept listed in B8.
- Retire an app's own passphrases and PINs only after it has run on tailnet identity for the whole window. That ends its way back to its own sign-in.
- Remove rehearsal-only grants, services, tags and credentials.
- Keep the Home Base passphrase: it opens setup and recovery.

## Recovery

By symptom. Each of the first four happened on the first production host, and the fix is now in Home Base; if you meet one, the host's Home Base is older than this runbook, so update it first.

**The cutover refuses: "nginx wouldn't load the socket gateway".** nginx.conf doesn't include `sites-enabled` in its `http` block. Do step B3, then run the cutover again. (Before the fix, the cutover went ahead, nginx ignored the gateway and still reloaded, and Home Base recorded success.)

**The cutover refuses: a server block "includes /etc/nginx/sovereign-home.d".** Your own site still serves the apps over TCP. Step B3.1.

**A publish or the cutover fails with "want to serve "http", but port 443 is already serving "https" for svc:…"** naming a service that isn't Home Base's. An older Home Base wrote the whole Serve configuration back, which Tailscale reads differently from what it exported. Update Home Base: it now changes one service at a time. If you must publish by hand, do only that service:
```sh
sudo tailscale serve --bg --yes --service=svc:<instance>-<key> --https=443 unix:/run/sovereign-serve/<key>.sock
```
Never clear or rewrite the other service.

**"I checked the console…" fails with `ENOENT` on `ingress-confirmations.json`.** An older Home Base looked for its files in its checkout. Update Home Base. If it persists, set `HOME_BASE_DATA_DIR=/var/lib/sovereign-home/homebase` (the directory holding `HOME_BASE_STATE_DB`) and restart Home Base while no job runs. Never make the checkout writable.

**Home Base can't be reached: `:3080` redirects and the new address doesn't load.** (Before the fix, the first cutover could move Home Base before its new service existed.) From the root shell; this opens no TCP path:
1. Publish its service by hand:
   ```sh
   sudo tailscale serve --bg --yes --service=svc:<instance>-homebase --https=443 unix:/run/sovereign-serve/homebase.sock
   ```
2. In the console, check this host is approved for that service, and your device's grant includes it.
3. `sudo nginx -T | grep -c 'sovereign-ingress: sockets'` must print `1`. If `0`, nginx isn't loading the gateway: step B3.2.
4. `sudo nginx -t && sudo systemctl reload nginx`, then `sudo journalctl -u nginx -n 5` to check the reload wasn't rejected. (`nginx -T` shows the files on disk, not what the running workers loaded.)
5. Wait 35–40 seconds for the first certificate, then open the address.

**A new address gives a DNS error.** The member's grant doesn't include that service: addresses nobody is granted aren't sent to their devices at all (B1.6).

**A new address times out on first use.** The first certificate takes 35–40 seconds. Otherwise the host isn't approved for the service yet, or another host is (B1.5).

**A service you published by hand waits for approval.** It had no approver when the host first advertised it. Adding the approver afterwards doesn't approve it; approve it on the service's console page. To avoid this, for a service added later (a sensitive app installed after Part B), define it, add its approver and add it to the members' grant, all before publishing.

**nginx won't reload, or `nginx -t` fails.** Fix it before any rollback, move or re-run: Home Base's parts of the configuration are fixed, so the problem is in something already there (your site, a snippet, a certificate). A rollback whose reload failed has already written the TCP gateway; fix nginx and run the rollback again.

**Home Base refuses something its own pages or a tool you use need (`request_refused`) after C1.** Set `HOME_BASE_REQUEST_GUARDS=report` and restart Home Base: requests go through again, and the log says what enforce refuses. Fix that page or client, then enforce again. `off` removes the guards entirely; once members use passkeys, the guards are what stops a page on another hostname from acting on Home Base as them, so prefer `report`.

**An app won't start after Use tailnet identity.** It refuses to start on a bad configuration rather than starting open. `journalctl -u <unit> -n 30` names the setting. **Return to its own sign-in** brings it back at once; then update the app and switch again.

**An app shows "can't check who you are right now".** It can't read the household directory. Check `systemctl is-active homebase` and `journalctl -u homebase | grep 'household directory'`. The app picks the directory up again by itself.

**A member sees "doesn't know you yet".** They aren't a member, are disabled, or the app isn't in their app list (C5). **"Almost there"**: a parent hasn't linked them in that app yet (C6.3).

**The administrator has lost a key or a shared key stopped matching after enrollment on another suite.** Stop registrations through unpatched builds and follow [the isolated-account upgrade](#roll-out-without-flipping-the-working-key-again). Enter recovery with the passphrase only where needed; register/check the missing hardware credential, keep any second credential that still works, then finish with hardware. Do not reset the physical key or force a working suite to re-enroll. If the passphrase is lost too, see [Reset](#reset-root-shell).

**Never downgrade the executor** while Home Base is on its socket: an older executor puts nginx back on `:3080` without updating its record. If it happened, upgrade the executor again, check `sudo nginx -t`, and run the cutover again.

## Rollback

Undo in reverse order, as far as you need:
1. **Apps:** **Return to its own sign-in** for every app on tailnet identity. Home Base counts an app as trusting identity headers from the moment its switch starts, so the ingress rollback refuses until every app is back, even after a failed switch.
2. **Home Base identity. Read this before rolling back the ingress on a host whose directory is active (Part C).** Active Home Base opens admin only with a passkey check, and passkeys work only on Home Base's socket. After an ingress rollback Home Base is back on `:3080`, so nobody can open admin there, and the passphrase opens only recovery. There is no supported way back from that yet. Until there is, treat an ingress rollback after Part C as unsupported: back out apps (step 1) and stop there. Turning the directory off after it was active hasn't been rehearsed either.
3. **Ingress** (hosts that never reached Part C): Network page → **Roll back ingress** (`ROLLBACK`). It re-renders every app's snippet for TCP, restores the TCP gateway, puts Home Base back on `:3080`, takes the socket services down and puts back the old managed service as the cutover retired it. It refuses while any app's `.env` has `SOVEREIGN_AUTH_MODE` other than `local`, including a hand edit. A node-level Serve entry on `:443` blocks nginx from binding; remove it and restart nginx. Then **update every app again**, so its addresses (and callbacks, B8) point back at the old ones, and check its external callbacks still work.
4. **Sensitive apps' own users** stay: the move is one way. That is safe under either ingress.

## Reference

### Verification checklists

After Part B, from a member device and the host:
- [ ] `https://<service>.<tailnet>/<app>/` loads for each installed app; `…/<app>` redirects to `…/<app>/` on the same hostname.
- [ ] Every mount requested on every other service's hostname is refused (404), and a hostname sent to another service's address gets 421.
- [ ] Forged `X-Sovereign-*`, `Tailscale-User-*`, `X-Forwarded-For` and `X-Forwarded-Host` headers never reach an app, on every location, including sidecar routes.
- [ ] With Home Base stopped, requests are refused (500), and work again once it's back.
- [ ] `curl -k https://127.0.0.1/` on the host fails.
- [ ] A non-root local user can't connect to any nginx socket or to the identity socket.
- [ ] A local process requesting the host's own service URL gets no member identity (`curl --resolve <service>.<tailnet>:443:<service IP>`).
- [ ] A tagged host and an unknown login get no identity.
- [ ] `/_sovereign/auth/` is 404 on `svc:<instance>-home`.
- [ ] Sensitive and Home Base responses carry `Content-Security-Policy: frame-ancestors 'none'`, including 404s.

After C1 (request guards) and C6 (an app switched):
- [ ] From a page on `svc:<instance>-home`, a fetch, form post, image, script and iframe to a sensitive hostname or Home Base are refused **on the server** (its log, not just the browser).
- [ ] A top-level link from the home hostname to a sensitive page opens it and changes nothing.
- [ ] A request with no `Sec-Fetch-Site` header is refused on sensitive and Home Base hostnames.
- [ ] A cookie set on the home hostname with `Domain=<tailnet>` is ignored by every sensitive app and by Home Base.
- [ ] A privileged plan asks for the hardware key every time, and a token for one plan can't run another.
- [ ] Revoking a passkey refuses its session within one snapshot interval.
- [ ] Recovery: entering it with the passphrase while active ends sessions and permits administrator credential enrollment/revocation, not app operations or privileged plans.

Probing an app through nginx with curl needs the fetch metadata a browser sends, once each:
```sh
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Sec-Fetch-Site: none' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' https://<service>.<tailnet>/<app>/
```
Without it a sensitive hostname answers `403 fetch_metadata_missing`, which is correct.

### Publishing rules Home Base enforces

- **Directory off:** a service may be published once no other host is approved for it. No app can switch to tailnet identity.
- **Setup and recovery:** only `svc:<instance>-homebase` may be published, so the enrollment surface exists.
- **Active:** publishing needs "no other host approved"; tailnet identity needs the service verified, or confirmed with the hardware key.

### Tailscale behaviors this depends on

Checked on 1.102.4 (2026-10-27) and 1.104.4 (2026-11-06).
- Change one service at a time: `tailscale serve --bg --yes --service=<svc> --https=443 <target>` and `tailscale serve clear <svc>`. Each leaves every other service and node-level entry unchanged and is safe to repeat. Publishing also advertises a drained service.
- **Never write the whole configuration back** with `set-config --all` or `set-raw`. The export names only the upstream, so an HTTPS frontend with an HTTP upstream exports as `http://…`, which `set-config` reads as plain HTTP: it refuses that over a live HTTPS port, and, if the service has since been removed, silently brings it back on plain HTTP. `set-raw` also drops node entries and leaves services with null endpoints.
- `tailscale serve get-config --all` exits 1 if any service has only a path handler (`root handler not set`). `tailscale serve status --json` still answers, and only it shows a port's frontend.
- A socket target is stored as `"tcp:443": "https://unix:<path>"`.
- A service host can't resolve its own service names unless the policy grants it access; use the service address from the API.
- tailscaled itself listens on the host's tailnet addresses on 443; any other 80/443 listener is a TCP path into nginx.

### Reset (root shell)

When the administrator has lost both their passkeys and the passphrase, or recovery itself is stuck: `sudo homebase admin reset`. It asks for a new passphrase and a typed `RESET`, revokes every administrator credential and session, ends every session (global epoch), and returns Home Base to setup, audited. The administrator stays the same tailnet account; if that account is gone, `sudo homebase admin reset --administrator <login>` lets that login become the founder instead.

### Tailnet rename

**Not supported yet.** On a cut-over host, the executor refuses a cutover under a different instance name or tailnet domain, and Home Base's domain setting is locked. Nothing rebinds passkeys either: they belong to the tailnet domain, so a renamed tailnet would leave every passkey unusable. Don't rename the tailnet, or change the instance, on a host that has been cut over. Changing the instance alone wouldn't affect passkeys, but it renames every service and isn't supported either.

## Instance-isolated passkeys

Use this section for the existing-active-suite entries in the starting-point table, and for C4/C7 account verification. It supplements the same host procedure, not a second ingress cutover. It applies only to a reviewed, compatible release, in a separately authorized rollout. It does not authorize deploying a draft branch to production. Rehearse first on two disposable suites with independent identity databases, the actual hardware key, and the deployed Node/Python/SQLite versions.

### What changes, and what does not

New registrations have a persisted opaque account handle per member in each independent suite. The tailnet domain remains the WebAuthn RP ID. The instance tag controls hosting policy; it is not a WebAuthn domain. New provider-facing display names include the suite instance, without changing the Tailscale login or authorization ID.

- **Isolated** means the credential uses the new account namespace.
- **Legacy (compatible)** means an existing credential still uses its original ID-derived handle. Working legacy keys do not have to be re-registered. A NULL stored handle on a legacy row is intentional, not corruption; the member's new enrollment handle does not rewrite that key.
- **Invalid account metadata** identifies a malformed stored credential record, not proof of a damaged physical key. Status/recovery remain available. An enrollment-metadata warning can instead mean missing member metadata or a well-formed mismatch on either side.
- Stored rows, attestation kind and D11 counts are not proof that the device still holds its private credential. Check the particular credential's fresh use. Do not reset the physical key to fix this incident.
- A copied identity database copies account handles. It is not a way to create an independent rehearsal suite. Same-suite host moves/restores preserve those handles. Tailnet/domain changes are still a separate unsupported migration.

### Upgrade a healthy active suite

After A1/A2/A4, confirm the instance and account-format diagnostics on Passkeys. Freshly check each credential you rely on; existing entries can remain **Legacy (compatible)**. Keep the household active. Do not enter recovery, delete working keys or re-enroll just to change that label. Resume C5/C6 only for incomplete membership/app work, and record C7 acceptance.

If the same hardware key or synced provider serves multiple healthy suites, upgrade each independent suite before allowing further registration. Verify each old credential after each upgrade, freeze registration on unpatched suites, and preserve working legacy entries. Registration on the compatible build uses isolated handles; an upgrade alone does not migrate old entries. Use the following incident path only if a required credential is actually missing or overwritten.

### Roll out without flipping the working key again

1. Use fresh ordinary passkey checks to identify the **working** and **overwritten** suites; do not assume their roles from their names or yesterday's timestamps. Check hardware and synced providers separately. An assertion does not replace a credential; registration can. If neither suite works, use the established recovery procedure rather than this one-live shortcut.
2. Keep SSH/root access and verify the recovery passphrase without exposing it. Take protected SQLite/config/signing-key backups using Part A. Freeze enrollment of the shared key through every unpatched instance throughout the coordinated window.
3. Upgrade the overwritten suite to the reviewed compatible build **before** entering recovery. Install its locked dependency and verify the running service restarted; files changed on disk are not proof the daemon loaded them. `PASSKEY_LIBRARY_MISMATCH` means stop and repair the dependency/process installation, not reset a key. In Admin, explicitly enter recovery with the passphrase from the administrator's tailnet account. Register and freshly check the missing hardware credential. Keep and freshly verify any second credential that still works; register another only if needed to meet D11. Do not force a working local legacy phone/key to re-enroll: ordinary exclusions intentionally protect it. Record any new entries/IDs and confirm their `lastUsedAt` or the status check's `credentialId`, not just a generic success from a different older entry.
4. After each new registration, verify the working suite's old hardware/synced credential still checks. Both devices/providers may have lost old entries: do not count ghost rows as a replacement. Newly registered entries should say **Isolated**; retained legacy entries remain **Legacy (compatible)**. Registration options supply an instance-labelled display name; the provider controls how it presents that text.
5. Only after confirming usable replacements, remove the overwritten suite's obsolete entries. During setup/recovery the Passkeys **Remove** button uses the existing passphrase-authorized Directory revoke route; it does not request a hardware confirmation. In active Home Base, administrator removal still uses the ordinary hardware-every-time route and preserves D11. Then finish recovery with a fresh hardware check.
6. Upgrade the working suite to stop new legacy issuance. Do not force its still-working key into recovery or re-enroll it. Verify both suites, their sensitive-app origins, and checks after service restarts. Keep the remaining legacy entries inventoried.
7. **Stop** if the real key unexpectedly treats an overwritten ID as excluded, or enrollment on one suite still breaks the other. Do not weaken exclusions or delete working access just to obtain a passing test. Same-device enrollment on the live legacy suite is intentionally duplicate-protected.

This is accidental replacement prevention between cooperating suites, not a new browser-enforced boundary against hostile sibling origins sharing the RP ID. Physical/provider behavior is an acceptance gate, not something the software authenticator proves.

### Diagnose metadata without exposing keys

The administrator sees the first-isolated-credential warning once any member has issued an isolated credential. That timestamp is informational server enrollment metadata; it is not cryptographic clock proof. After issuance, a pre-compatibility binary is an unsupported downgrade: it may reject new assertions and still issue shared legacy handles. Old binaries have no new startup guard. The warning and release/runbook discipline enforce this floor operationally.

For root-only, read-only comparison, set `DB` to the service's effective configured database (the following is the default). The output contains labels/IDs to redact before sharing, but no public-key bytes, signing key, passphrase hash, token or raw account handle:

```sh
DB=/var/lib/sovereign-home/homebase/home-base.sqlite3
sudo python3 - "$DB" <<'PY'
import base64, hashlib, json, pathlib, sqlite3, sys
c = sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)
c.row_factory = sqlite3.Row

def fingerprint(value):
    if value is None:
        return 'unset'
    try:
        raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
        if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode().rstrip('=') != value:
            return 'invalid'
        return hashlib.sha256(raw).hexdigest()[:16]
    except (ValueError, TypeError):
        return 'invalid'

print(dict(c.execute('SELECT state, webauthn_v2_issued_at FROM identity_household WHERE id=1').fetchone()))
for row in c.execute('''SELECT m.user_id, m.login, m.webauthn_user_handle AS member_handle,
 c.credential_id, c.label, c.kind, c.handle_format, c.webauthn_user_handle AS credential_handle,
 c.revoked_at, c.last_used_at FROM identity_members m
 LEFT JOIN identity_credentials c ON c.member_id=m.member_id ORDER BY m.user_id,c.created_at'''):
    item = dict(row)
    item['member_fingerprint'] = fingerprint(item.pop('member_handle'))
    stored = item.pop('credential_handle')
    if item['credential_id'] is None:
        item['credential_fingerprint'] = 'no credential'
    elif item['handle_format'] == 'legacy-v1':
        item['credential_fingerprint'] = 'legacy: ID-derived' if stored is None else 'invalid'
    elif item['handle_format'] == 'isolated-v2':
        item['credential_fingerprint'] = fingerprint(stored) if stored is not None else 'invalid'
    else:
        item['credential_fingerprint'] = 'invalid format'
    print(json.dumps(item))
PY
```

Compare **all** isolated rows owned by the affected member, revoked ones included. A valid-looking mismatch may be in the member row or a credential row; equality/shape alone does not establish which copy is right. Revoking a well-formed mismatched historical row does not clear the enrollment warning, because the history still protects against silently creating another account. Fingerprints are diagnostic hints, not values to write back.

### Corruption exits and restoring the same account

- If a credential has malformed account metadata, enter explicit administrator recovery and remove the identified invalid entry with **Remove**. This is a different failure from ordinary authenticator exclusion: clearing a corrupt record may be necessary **before** options can be generated. Keep other working access, enroll/check the needed replacements, and activate with hardware. An active administrator can use the existing Directory API to revoke an affected non-admin credential; no new policy bypass is introduced.
- A NULL member handle from an old writer with no isolated history is allocated on a compatible restart; the error says so. With isolated history, a missing, invalid or inconsistent member handle is **not** reallocated, even after all those credentials are revoked. Existing valid credential checks may remain usable, but enrollment is paused.
- `homebase admin reset` is not a namespace repair: it retains the member/account and revokes administrator credentials. Do not reset the hardware key, generate a replacement member handle, relabel credential handles or clear the rollback marker to hide the problem.

A proven same-account restoration is an **offline, maintainer-assisted maintenance operation**, not an in-product rebind command:

1. Stop Home Base in an approved maintenance window and take a fresh protected SQLite backup. Confirm the affected stable member ID/login and the exact **original** canonical 32-byte handle from a known-good backup. Current isolated rows (including revoked rows) provide supporting evidence; if they disagree or the original cannot be proven, stop for case-specific recovery. Do not guess between a damaged member value and a damaged credential value.
2. Under one `BEGIN IMMEDIATE` transaction, verify that every owned isolated row agrees with that proven original handle. Preserve all credential IDs, verification keys, counters, revocations, roles, epochs and signing keys. For a member-only repair, capture the exact SQL of `identity_member_handle_immutable`, temporarily remove **only that guard inside the transaction**, perform a parameterized update of **one** `identity_members.webauthn_user_handle`, and recreate the captured guard before committing. Keep canonical/unique constraints active. Roll back the entire transaction, including DDL, on any failed validation or write. Never leave guards disabled on a running service.
3. Restart the compatible build, which refreshes its managed guards, and re-check each suite/credential before further enrollment. Record the maintenance reason, affected member, backup/version references and check results without logging handle bytes. If a credential row also needs restoration, this member-only procedure must abort; arrange case-specific restoration from trusted metadata, not arbitrary relabeling or a blind whole-database rollback.

The transaction/abort/guard-restoration recipe is exercised only on disposable metadata fixtures in `test/passkey-account-store.test.js`. It is not a tested production disaster-recovery service. Restoring database rows cannot restore a private credential removed from a physical key, and restoring a whole old database can also roll back authorization/revocation state; neither is a routine rollback shortcut.
