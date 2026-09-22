# Ubuntu Family Dinner Executor VM Gate

Run this only after building a release from `feature/root-executor-protocol`. This document is the pre-VM gate; it does not authorize a production deployment.

## Fresh VM prerequisites

- Ubuntu Server 24.04 LTS snapshot, systemd, outbound HTTPS access.
- No existing `/opt/sovereign-home/homebase`, `/etc/sudoers.d/homebase`, or Family Dinner installation.
- Release archive and checksum produced from a clean checkout.

## Install and boundary checks

```bash
sudo bash install.sh --version vX.Y.Z
systemctl is-active homebase.service homebase-executor.socket
stat -c '%U:%G %a %n' /run/homebase/executor.sock
systemctl show homebase.service -p User -p NoNewPrivileges
getent group homebase-exec
```

Expected: web service runs as `homebase`, retains `NoNewPrivileges=yes`; socket is `root:homebase-exec 660`; no sudoers file exists. Confirm `homebase` is the only non-root socket-group member.

## Executor protocol check

```bash
sudo -u homebase node - <<'NODE'
const { hello } = require('/opt/sovereign-home/homebase/src/executor/client');
hello('/run/homebase/executor.sock').then(console.log).catch((error) => { console.error(error); process.exit(1); });
NODE
```

Expected: protocol version 1 and `mutationsEnabled: true`.

## Dinner install test

1. Set up/unlock the Home Base admin account.
2. Submit a Family Dinner real install with `confirm=EXECUTE`.
3. Verify job events progress without a shell command, then confirm:

```bash
curl --fail http://127.0.0.1:3000/api/ready
systemctl is-active family-dinner.service nginx postgresql
sudo -u sovereign git -C /opt/sovereign-home/apps/familyDinner status --porcelain
sudo -u postgres psql -d postgres -c '\du family_dinner'
```

Expected: readiness succeeds before installation status becomes `installed`; Git status is clean; all application npm/migration processes run as `sovereign`, not root.

## Mandatory secret audit

Use a unique canary password. After both success and a forced failure, search Home Base SQLite, job log/API responses, and both journals. The canary must not occur in any of them:

```bash
sudo journalctl -u homebase -u homebase-executor --no-pager | grep -F 'CANARY' && exit 1 || true
sudo grep -aF 'CANARY' /var/lib/sovereign-home/homebase/home-base.sqlite3 && exit 1 || true
```

Stop and investigate on any socket permission drift, legacy shell invocation, canary leak, false installed state, or readiness failure.
