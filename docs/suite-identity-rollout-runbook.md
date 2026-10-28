# Suite Identity Rollout Runbook (draft)

Feature-10. This runbook moves one Home Base host from today's ingress to identity-safe ingress, then turns on tailnet identity app by app.

**Status: draft.** It will be filled in as SID-001…SID-007 land, and walked on a test VM (SID-008) before any production host.

Placeholders: `<host>` is the host's MagicDNS name, `<tailnet>` the tailnet domain (`<name>.ts.net`), `<instance>` this household's instance name, `<app>` a catalog app id.

## 0. Rules

- Rehearse every step on a test VM first. A production host changes only after the VM checklist passes, including an interrupted cutover and a rollback.
- One host at a time. One wave of apps at a time.
- Every change has a rollback listed next to it. Snapshot configs before each step.
- **Order matters both ways.** Cutover: ingress, then ownership, then Home Base, then apps. Rollback: apps back to local mode first, then Home Base, then ingress. Never restore a TCP path while any app trusts identity headers.
- Keep the admin passphrase (password manager) and every app's local credentials until the feature's rollback window has passed.
- **Nothing here is required.** A host that never cuts over keeps today's ingress, and every app keeps its own login. App installs and updates on such a host still write the TCP-gateway form of each app's nginx snippet.

## 1. Read-only pre-checks (per host)

```sh
tailscale version                            # 1.102.4 or later (the version SID-001 was rehearsed on)
tailscale status --self --peers=false        # tagged? which tags? (must be tagged to serve the suite)
sudo tailscale serve get-config --all        # services this host serves today, and their targets
sudo tailscale serve status --json           # node-level entries too (get-config shows services only)
sudo ss -ltnp                                # nginx and app listeners (0.0.0.0 vs 127.0.0.1 vs sockets)
systemctl show <app-unit> -p User --value    # shared service user vs per-app users
sudo nginx -T | grep -nE 'listen|include|absolute_redirect|proxy_pass|proxy_set_header'
```

Record:
- Host tags, and how the old managed service (`svc:home`) is defined.
- Whether anything besides Serve can reach nginx or an app (LAN, loopback TCP).
- **Operator-managed nginx sites that include `/etc/nginx/sovereign-home.d/*.conf`** (adopted hosts). The cutover refuses while one exists, because it would keep serving apps over TCP. Remove that include from your own site first (keep the site's other content), and keep a copy for rollback.
- Which apps already support the socket listen contract (SID-002): Family Pulse, Home Source, Helm and Bitcoin Accounting, from their 2026-10-28 `main`. Which units run as `sovereign` and which as `sovereign-<key>` (`systemctl show <unit> -p User`).

## 2. Tailnet policy, services, and Home Base settings

Choose the instance name: lowercase letters, digits and single dashes, at most 24 characters, starting with a letter (for example `smith`). It prefixes every service. Changing it later is a tailnet rename (section 7).

### 2.1 Services

Define, on the console's Services page, one service per address in use, each with port `tcp:443`:
- `svc:<instance>-home`: every low-friction app, by path (`/dinner/`, `/plan/`, …);
- `svc:<instance>-homebase`: Home Base admin and all passkey management;
- `svc:<instance>-<key>` for each **installed** sensitive app: `pulse`, `source`, `helm`, `bitcoin-accounting`.

Members open `https://<instance>-home.<tailnet>/<app>/`, `https://<instance>-<key>.<tailnet>/<app>/`, and `https://<instance>-homebase.<tailnet>/`.

### 2.2 Policy, in this order

Done in the wrong order, this host loses its approvals while a stale host keeps its own.
1. Give this host its own tag, owned by the administrator alone, held by no other machine:
   ```jsonc
   "tagOwners": { "tag:<instance>-host": ["<administrator login>"] }
   ```
   Then add the tag to the host on the Machines page.
2. Approve only that tag for each service:
   ```jsonc
   "autoApprovers": { "services": {
     "svc:<instance>-home":     ["tag:<instance>-host"],
     "svc:<instance>-homebase": ["tag:<instance>-host"],
     "svc:<instance>-pulse":    ["tag:<instance>-host"]
   } }
   ```
   Never use a tag that several hosts share as an approver. Any host with that tag can become an approved standby: it gets a valid certificate for the service hostname and takes all of the service's traffic when this host stops serving (spike 3b). Home Base refuses to publish a service another host already serves, but that is a second check. The policy is the boundary.
3. **Review existing approvals** on each service's page and remove any host other than this one. Tightening approvers does not revoke approvals that already exist.

**Adding a service later** (a sensitive app installed after cutover): define it, add its approver, **and** add it to the members' grant, all before publishing it (2026-10-28 rehearsal):
- with no approver when the host first advertises it, the host waits for manual approval (adding the approver afterwards doesn't approve it);
- with no grant, members get a DNS error, not a refusal: an address nobody is granted isn't sent to their devices at all.

Grant members the addresses they use. Grants are an independent layer: a member who isn't granted an address can't reach it at all. Members who use a passkey app also need `svc:<instance>-homebase`, where all credential management happens (D21); Home Base limits non-administrators to their own credentials there.
```jsonc
{ "src": ["group:family"], "dst": ["svc:<instance>-home", "svc:<instance>-homebase", "svc:<instance>-pulse"], "ip": ["tcp:443"] }
```
Tagged service hosts don't need app access. If one has it, it still gets no identity.

Turn on Tailnet Lock if it isn't already. A leaked tagged auth key then can't add a host without a trusted signature.

### 2.3 How Home Base verifies the service hosts (D23)

- **Automatic (recommended):** create a trust credential (OAuth client, Settings → Trust credentials) with **Services: Read**, **Devices → Core: Read** and **Policy File: Read** only. These were confirmed sufficient on 2026-10-27; a write attempt with them is refused. Store it on the host, readable by Home Base alone:
  ```sh
  read -rs -p 'client id: ' ID; echo; read -rs -p 'client secret: ' SECRET; echo
  printf 'TS_OAUTH_CLIENT_ID=%s\nTS_OAUTH_CLIENT_SECRET=%s\n' "$ID" "$SECRET" \
    | sudo install -m 400 -o homebase -g homebase /dev/stdin /etc/sovereign-home/tailscale-api.env
  unset ID SECRET
  ```
  Home Base lists every host of each service, standbys included, and requires exactly one approved host: this one. It also warns about shared approver tags, extra tag holders, and tag owners. Never give it write scopes: a credential that can approve hosts could approve an attacker's machine as a standby.
- **Confirmation:** without a credential, check each service's page in the console and confirm in Home Base that no other host is approved. Confirmations last 30 days; once Home Base is active (SID-004/005) they need the hardware key.

### 2.4 Home Base setting

Add `HOME_BASE_INSTANCE=<instance>` to `/etc/sovereign-home/homebase.env` and restart `homebase`. The domain is Home Base's configured domain and must be the tailnet domain.

### 2.5 Publishing rules (enforced by Home Base)

- **Before the household directory exists (pre-SID-004):** a service may be published once no other host is approved for it. No app can enter tailnet mode.
- **Setup and recovery (SID-004):** only `svc:<instance>-homebase` may be published, so the enrollment surface exists.
- **Active:** publishing needs "no other host approved"; tailnet mode needs the service verified (or confirmed with a hardware key).

## 3. Cutover: ingress (SID-001)

Run from Home Base admin (`POST /api/ingress/...`; admin unlock, privileged jobs, executor mode). Each step is a typed executor action.

| Step | Action | Verify | Rollback |
|---|---|---|---|
| 3.1 | Snapshot `serve get-config --all`, `serve status --json`, `/etc/nginx` | Files saved | — |
| 3.2 | **Cut over** (`/api/ingress/cutover`, `confirm: CUTOVER`): tmpfiles for `/run/sovereign-serve` (0700 root) and `/run/homebase-identity` (0750 homebase:www-data); the identity snippet; the socket gateway (one server block per service, no TCP listener); every installed app's snippet re-rendered as `<service>--<app>.conf`; the old managed service retired from this host | `nginx -t`; no 80/443 listener except tailscaled's on the host's tailnet addresses; Home Base logs `identity lookups on /run/homebase-identity/identity.sock` within 15 s | **Roll back** (`/api/ingress/rollback`, `confirm: ROLLBACK`) |
| 3.3 | **Publish** each service, one at a time (`/api/ingress/services/<key>/publish`, `confirm: PUBLISH`): `homebase` first, then `home`, then each sensitive app. Home Base refuses while another host is approved. It warms the new certificate automatically (first issue takes 35–40 s; publishing straight through the executor skips this, and the first visitor waits instead) | The service shows `verified` (API) once approved | Roll back |
| 3.4 | **Update each installed app** from Home Base (an ordinary update) | Each app's `.env` URLs (`APP_URL`, `HELM_PUBLIC_URL`, OAuth redirects, local font URLs) use its service hostname | Roll back, then update again |
| 3.5 | Add the new OAuth callback URLs at the providers: Plaid for Pulse (`https://<instance>-pulse.<tailnet>/pulse/oauth/callback`), Google for Plan (`https://<instance>-home.<tailnet>/plan/api/google-calendar/oauth/callback`) | Linking still works | Keep the old URLs listed until the rollback window has passed |
| 3.6 | Tell members the new addresses; update bookmarks and the iOS wrapper's start URL | — | — |

The rollback re-renders every app snippet for TCP, restores the TCP gateway, then re-applies the Serve services exactly as they were before the cutover. It refuses while any app has `SOVEREIGN_IDENTITY_MODE=tailnet` in its `.env`. If the host still has a node-level Serve entry on `:443`, nginx can't bind 443; remove that entry and restart nginx.

Verify after 3.x, from a member device and from the host:
- [ ] `https://<service>.<tailnet>/<app>/` loads for each installed app.
- [ ] `https://<service>.<tailnet>/<app>` redirects to `.../<app>/` on the same hostname (never `localhost` or `127.0.0.1`).
- [ ] Every mount requested on every other service's hostname is refused (404), and a hostname sent to another service's address gets 421.
- [ ] Forged `X-Sovereign-*`, `Tailscale-User-*`, `X-Forwarded-For` and `X-Forwarded-Host` headers never reach an app, on every location, including sidecar routes.
- [ ] With Home Base stopped, requests are refused (500), and work again once it is back.
- [ ] `curl -k https://127.0.0.1/` on the host fails (no TCP listener).
- [ ] A non-root local user can't connect to any nginx socket or to the identity socket.
- [ ] A local process requesting the host's own public service URL gets no member identity (`curl --resolve <service>.<tailnet>:443:<service IP>`).
- [ ] A tagged host and an unknown login get no identity.
- [ ] From a page on `svc:<instance>-home`, requests to a sensitive hostname are refused **on the server** (check its log, not just the browser): fetch, form post, image, script and iframe. *(Needs SID-003's guard.)*
- [ ] A top-level link from the home hostname to a sensitive page opens it and changes nothing.
- [ ] Sensitive and Home Base responses carry `Content-Security-Policy: frame-ancestors 'none'`, including 404s and `/_sovereign/auth/`.
- [ ] A request with no `Sec-Fetch-Site` header is refused on sensitive and Home Base hostnames. *(SID-003.)*
- [ ] A cookie set on the home hostname with `Domain=<tailnet>` is ignored by every sensitive app and by Home Base. *(SID-003.)*
- [ ] `/_sovereign/auth/` returns 404 on `svc:<instance>-home`.
- [ ] A second tagged host can't become a host of a service this host serves (rehearsal VM only; spike 3b procedure).

### Tailscale behaviors this depends on (1.102.4, checked 2026-10-27)

- Apply service config with `tailscale serve set-config --all <file>`: it sets every service declaratively, advertises them, removes ones left out, and keeps node-level entries. **Never `set-raw` with `get-config` output**: it replaces the whole Serve config, dropping node entries and leaving services with null endpoints.
- A socket target is stored as `"tcp:443": "https://unix:<path>"`.
- A service host can't resolve its own service names unless the policy grants it access; use the service address from the API (`getService` `addrs`).
- `listServiceHosts` names each host's ID `nodeId` (the published schema says `stableNodeID`); it equals the device list's `nodeId` and `tailscale status` `Self.ID`. A service with no hosts answers `{}`.
- tailscaled itself listens on the host's tailnet addresses on 443; any other 80/443 listener is a TCP path into nginx.

## 4. Cutover: app ownership (SID-002)

Independent of section 3: it works on a host with either ingress, and can run before or after the cutover. Rehearsed on the test VM on 2026-10-28 for all four sensitive apps (one moved in place, three fresh installs).

What an update does by itself:
- **Every app** listens on loopback only (`HOST=127.0.0.1`). Anything that opened an app's port directly (`http://<host>:3000/tonight`, a bookmark, a script) must use its Home Base address.
- **A sensitive app's fresh install** runs as its own user, `sovereign-<key>`, on its socket.
- **A sensitive app installed before SID-002** moves to its socket but keeps running as `sovereign`. Its page's **Runs as** card says so and offers the move.

Per sensitive app installed before SID-002, while it is still in local mode:
1. **Update it** from Home Base. Confirm it is healthy on its socket before going on.
2. **Move it to its own user** (app page → Runs as → **Move to its own user**, `confirm: MOVE`; preview the plan first). The plan:
   - takes a safety backup and stops the app;
   - creates `sovereign-<key>` with its home under `/var/lib/sovereign-home/<app id>/home`;
   - hands over its home, storage, backups and, last, its checkout: every directory is locked to root first, hard-linked files are copied, and setuid bits are dropped;
   - rewrites `.env` (0600) and every unit, then starts the app and waits for readiness.

   Expect a minute or two of downtime.
3. Verify on the host:
   - [ ] every unit of the app (service, sidecars, timers) runs as `sovereign-<key>`: `systemctl show <unit> -p User --value`;
   - [ ] `sudo ls -la /run/sovereign-apps/<app id>` shows `drwxr-s--- sovereign-<key> www-data` and `srw-rw---- … app.sock`;
   - [ ] `sudo -u sovereign curl --unix-socket /run/sovereign-apps/<app id>/app.sock http://localhost/<health>` fails, and the same as `www-data` answers;
   - [ ] `sudo -u sovereign` can't read the app's `.env`, list its checkout, storage or backups, or write into them;
   - [ ] nothing listens on the app's old port (`sudo ss -ltnp`), and Home Base's ingress verification shows **Apps listen only on loopback or their sockets** passing;
   - [ ] update, backup and restart still work, and dependency caches land in the app's own home.
4. Verify from a member device, on the app's service hostname: pages, the mount redirect, static assets, nested APIs, and the OAuth callback route. Checked on the VM for a prefix-stripping app (Pulse, Home Source) and a mount-preserving one (Helm, Bitcoin Accounting). The D22 callback contract itself (landing page, single-use same-origin POST) is app behavior, checked when each app enters tailnet mode (section 6).
5. **Rollback.** The move is one way; there is no move-back action. Neither path below has been rehearsed yet (SID-008); the switch back to TCP is covered by tests only.
   - If the app misbehaves after the move, **Restore** the safety backup the move took. The files stay with the app's user.
   - A socket problem rolls back with a Home Base release whose catalog sets the app to `runtime.listen: 'tcp'`. The update rewrites `.env` (dropping `SOVEREIGN_LISTEN`) and nginx.

## 5. Cutover: Home Base identity (SID-004/005/006)

1. Upgrade Home Base to the identity-capable version, **before** moving it to its socket. The directory and passkey service come up in `setup`.
2. Move Home Base admin to its socket (it is already reachable at `svc:<instance>-homebase`). Keep `:3080` as a redirect for the transition period.
3. The founder unlocks with the passphrase. Their tailnet identity is recorded as the administrator. Then they enroll:
   - a synced passkey (daily);
   - an attested hardware key (keyring);
   - a second attested hardware key (offline spare).
4. Home Base moves to `active`. Confirm the passphrase now opens only a recovery session.
5. Add members (stable user IDs, parent/kid) and set app access.
6. Members with sensitive apps enroll through a 15-minute enrollment grant, on the Home Base hostname. Credentials can't be enrolled or revoked anywhere else.

Verify:
- [ ] A privileged plan asks for the hardware key every time, and a token for one plan can't run another.
- [ ] Adding or removing an administrator credential asks for the hardware key.
- [ ] A cross-site form post and a request from `svc:<instance>-home` to Home Base are refused.
- [ ] Revoking a credential refuses its cookie within one snapshot interval.
- [ ] Recovery: the passphrase while active revokes sessions and allows only re-enrollment.
- [ ] `homebase admin reset` returns to `setup` (rehearsal host only).

Rollback: return every app to local mode (section 6) first. Then restore the previous Home Base version and its Serve target.

## 6. Cutover: apps (SID-007, then per-app waves)

Per app:
1. Install the app version that supports the socket listen contract and sovereignAuth.
2. Home Base renders its socket and identity env; the app restarts in `tailnet` mode.
3. Link local members to directory members (one-time, the administrator confirms each).
4. Verify:
   - [ ] the member lands as themselves;
   - [ ] a kid sees only kid scope, and parent-only actions refuse kids;
   - [ ] unknown logins see "ask the administrator";
   - [ ] sensitive apps ask for a passkey tap.
5. Rollback: set the app back to `local` mode. Its local credentials still work.

## 7. Tailnet rename

A renamed tailnet changes the RP ID, so every passkey stops working.
1. Re-publish services under the new name. Home Base then:
   - rebinds the RP ID to the new tailnet domain (the only time it changes);
   - marks every credential as orphaned;
   - bumps the global epoch, so every assurance cookie stops working.
2. The founder uses the passphrase, which opens recovery, and enrolls new administrator credentials, including an attested hardware key. A fresh hardware ceremony then returns Home Base to `active`.
3. The administrator issues enrollment grants so members re-enroll. Members whose only credentials are orphaned count as having none.
4. Revoke the orphaned credential records once everyone has re-enrolled.

## 8. Clean-up

- Remove spike-only and rehearsal-only tailnet grants, services, tags and credentials.
- Retire the `:3080` redirect.
- Retire per-app passphrases and PINs only after each app has run in `tailnet` mode for the full rollback window. Retiring them ends that app's local-mode rollback.
- Keep the Home Base passphrase for setup and recovery.
