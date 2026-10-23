# Suite Identity Rollout Runbook (draft)

Feature-10. This runbook moves one Home Base host from today's ingress to identity-safe ingress, then turns on tailnet identity app by app.

**Status: draft.** It will be filled in as SID-001…SID-006 land, and walked on a test VM before any production host.

Placeholders: `<host>` is the host's MagicDNS name, `<tailnet>` the tailnet domain, `<app>` a catalog app id.

## 0. Rules

- Rehearse every step on a test VM first. A production host changes only after the VM checklist passes.
- One host at a time. One wave of apps at a time.
- Every change has a rollback listed next to it. Snapshot configs before each step.
- Keep the admin passphrase available (password manager) until the administrator has ≥2 passkeys including a hardware key on that host.

## 1. Read-only pre-checks (per host)

```sh
tailscale version
tailscale status --self --peers=false        # tagged? which tags?
sudo tailscale serve get-config --all        # svc:home VIP vs node-level Serve; current targets
sudo ss -ltnp                                # nginx and app listeners (0.0.0.0 vs 127.0.0.1 vs sockets)
systemctl show <app-unit> -p User --value    # shared service user vs per-app users
sudo nginx -T | grep -nE 'listen|absolute_redirect|proxy_pass'
```

Record:
- How the host publishes (a `svc:home` VIP, or node-level Serve).
- Whether anything besides Serve can reach nginx or an app (LAN, loopback TCP).
- Which apps already support the socket listen contract.

## 2. Tailnet policy

- Members need `tcp:443` and `tcp:3080` to the host (or the `svc:home` service).
- Tagged service hosts don't need app access. If one has it, it gets no identity anyway.
- Remove spike-only grants (e.g. test-VM access) once the rehearsal is done.

## 3. Cutover: ingress (SID-001)

| Step | Action | Verify | Rollback |
|---|---|---|---|
| 3.1 | Snapshot `serve get-config --all`, the nginx site, and `sovereign-home.d/` | Files saved | — |
| 3.2 | Install tmpfiles.d entry for `/run/sovereign-serve` (0700 root) | Dir exists after `systemd-tmpfiles --create` | Remove entry |
| 3.3 | nginx suite server: socket listen only, `absolute_redirect off`, identity snippet, explicit mount redirects | `nginx -t`; no suite TCP listeners in `ss -ltnp` | Restore snapshot, reload |
| 3.4 | Serve `:443` → `unix:/run/sovereign-serve/nginx.sock` (via the Home Base publish plan) | `serve status` shows the socket target | Re-apply saved Serve config |
| 3.5 | Home Base `:3080` → Home Base socket (SID-005) | Admin UI loads over the tailnet | Re-apply saved Serve config |

Verify after 3.x, from a member device and the host:
- [ ] `https://<host>/<app>/` loads for each installed app.
- [ ] `https://<host>/<app>` redirects to `https://<host>/<app>/` (never `localhost`).
- [ ] An echo route shows `X-Sovereign-Login` = the member's login, and forged headers are replaced.
- [ ] `curl -k https://127.0.0.1/` on the host fails (no TCP listener).
- [ ] A non-root local user can't connect to the nginx socket.
- [ ] A tagged host gets no identity.

## 4. Cutover: Home Base identity (SID-003/004/005)

1. Upgrade Home Base; the directory and passkey service come up empty.
2. The administrator opens the Household page, confirms their tailnet login, and enrolls:
   - a synced passkey (daily);
   - a hardware key (keyring);
   - a second hardware key (offline spare).
3. Confirm the admin passphrase is now labeled break-glass.
4. Add members (tailnet logins, parent/kid), and set app access.
5. Members enroll passkeys only if they use sensitive apps.

Verify:
- [ ] A privileged plan asks for the hardware key every time.
- [ ] Adding a credential as the administrator asks for the hardware key.
- [ ] `homebase admin reset` works from a root shell (rehearsal host only).

## 5. Cutover: apps (SID-002/006, then per-app waves)

Per app:
1. Install the app version that supports the socket listen contract and the adapter.
2. Home Base renders its socket and identity env; the app restarts in `tailnet` mode.
3. Link local members to directory members (one-time, administrator confirms).
4. Verify: the member lands as themselves; a kid sees only kid scope; parent-only actions refuse kids; sensitive apps ask for a passkey tap.
5. Rollback: set the app back to `local` mode (its existing login returns).

## 6. Clean-up

- Remove spike-only tailnet grants.
- Retire per-app passphrases and PINs only after each app has run in `tailnet` mode for a week without issues.
- Keep the Home Base break-glass passphrase.
