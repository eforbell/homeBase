# Suite Identity Rollout Runbook (draft)

Feature-10. This runbook moves one Home Base host from today's ingress to identity-safe ingress, then turns on tailnet identity app by app.

**Status: draft.** It will be filled in as SID-001…SID-007 land, and walked on a test VM (SID-008) before any production host.

Placeholders: `<host>` is the host's MagicDNS name, `<tailnet>` the tailnet domain, `<service>` a Tailscale Service name, `<app>` a catalog app id.

## 0. Rules

- Rehearse every step on a test VM first. A production host changes only after the VM checklist passes, including an interrupted cutover and a rollback.
- One host at a time. One wave of apps at a time.
- Every change has a rollback listed next to it. Snapshot configs before each step.
- **Order matters both ways.** Cutover: ingress, then ownership, then Home Base, then apps. Rollback: apps back to local mode first, then Home Base, then ingress. Never restore a TCP path while any app trusts identity headers.
- Keep the admin passphrase (password manager) and every app's local credentials until the feature's rollback window has passed.

## 1. Read-only pre-checks (per host)

```sh
tailscale version
tailscale status --self --peers=false        # tagged? which tags? (must be tagged to serve the suite)
sudo tailscale serve get-config --all        # services defined, current targets
sudo ss -ltnp                                # nginx and app listeners (0.0.0.0 vs 127.0.0.1 vs sockets)
systemctl show <app-unit> -p User --value    # shared service user vs per-app users
sudo nginx -T | grep -nE 'listen|absolute_redirect|proxy_pass|proxy_set_header'
```

Record:
- Host tags, and how `svc:home` is defined.
- Whether anything besides Serve can reach nginx or an app (LAN, loopback TCP).
- Which apps already support the socket listen contract.
- Which nginx locations set their own headers (each needs the identity snippet).

## 2. Tailnet policy and services

- Define the services:
  - `svc:home` for low-friction apps;
  - `svc:homebase` for Home Base admin;
  - one `svc:<app>` per sensitive app.
- Approve this host as each service's host.
- Members need `tcp:443` to each service they use.
- Tagged service hosts don't need app access. If one has it, it still gets no identity.
- Remove spike-only grants (e.g. test-VM access) once the rehearsal is done.

## 3. Cutover: ingress (SID-001)

| Step | Action | Verify | Rollback |
|---|---|---|---|
| 3.1 | Snapshot `serve get-config --all`, the nginx site, and `sovereign-home.d/` | Files saved | — |
| 3.2 | Install the tmpfiles.d entry for `/run/sovereign-serve` (0700 root) | Dir exists after `systemd-tmpfiles --create` | Remove entry |
| 3.3 | nginx: one server block per service, each on its own socket; `absolute_redirect off`; identity snippet in every location; explicit mount redirects | `nginx -t`; no suite TCP listeners in `ss -ltnp` | Restore snapshot, reload (no app is in tailnet mode yet) |
| 3.4 | Each service's Serve config → `unix:/run/sovereign-serve/<service>.sock` (via the Home Base publish plan) | `serve status` shows each socket target | Re-apply saved Serve config |

Verify after 3.x, from a member device and from the host:
- [ ] `https://<service>.<tailnet>.ts.net/<app>/` loads for each installed app.
- [ ] `https://<service>.<tailnet>.ts.net/<app>` redirects to `.../<app>/` (never `localhost`).
- [ ] An echo route shows `X-Sovereign-Login` = the member's login. Forged `X-Sovereign-*` and `Tailscale-User-*` headers are replaced, on every location, including sidecar routes.
- [ ] `curl -k https://127.0.0.1/` on the host fails (no TCP listener).
- [ ] A non-root local user can't connect to any nginx socket.
- [ ] A local process requesting the host's own public service URL gets no member identity.
- [ ] A tagged host and an unknown login get no identity.

## 4. Cutover: app ownership (SID-002)

Per sensitive app, while the app is still in local mode:
1. Create its service user. Move the checkout, `.env`, storage, backups and caches to that user; parents stay root-owned.
2. Switch it to its socket (owner = app user, group = nginx's group, 2750; socket 0660).
3. Verify:
   - [ ] the shared service user can't connect to the socket, or read or write the app's files and backups;
   - [ ] nested APIs, redirects, assets and OAuth callbacks still work.
4. Rollback: restore the previous unit, ownership and listen settings from the snapshot.

## 5. Cutover: Home Base identity (SID-004/005/006)

1. Upgrade Home Base to the identity-capable version, **before** moving it to its socket. The directory and passkey service come up in `setup`.
2. Move Home Base admin to `svc:homebase` and its socket. Keep `:3080` as a redirect for the transition period.
3. The founder unlocks with the passphrase. Their tailnet identity is recorded as the administrator. Then they enroll:
   - a synced passkey (daily);
   - an attested hardware key (keyring);
   - a second attested hardware key (offline spare).
4. Home Base moves to `active`. Confirm the passphrase now opens only a recovery session.
5. Add members (stable user IDs, parent/kid) and set app access.
6. Members with sensitive apps enroll through a 15-minute enrollment grant.

Verify:
- [ ] A privileged plan asks for the hardware key every time, and a token for one plan can't run another.
- [ ] Adding or removing an administrator credential asks for the hardware key.
- [ ] A cross-site form post and a request from `svc:home` to Home Base are refused.
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
1. Re-publish services under the new name.
2. The founder uses the passphrase, which opens recovery, and enrolls new administrator credentials.
3. The administrator issues enrollment grants so members re-enroll.

## 8. Clean-up

- Remove spike-only tailnet grants.
- Retire the `:3080` redirect.
- Retire per-app passphrases and PINs only after each app has run in `tailnet` mode for the full rollback window. Retiring them ends that app's local-mode rollback.
- Keep the Home Base passphrase for setup and recovery.
