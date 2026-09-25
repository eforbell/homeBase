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

### Refreshing an already-installed VM

Same-version reruns preserve code. After pulling new commits into the local checkout, refresh everything, including the executor unit, with:

```bash
sudo bash install.sh --source-dir /path/to/homeBase --repair
systemctl show homebase-executor.service -p NoNewPrivileges -p UMask
```

Expected: `NoNewPrivileges=no`, `UMask=0022`. Do not use `--repair-executor` for this. It copies only `executor/`, but the executor loads schema and policy from `src/`.

### Private repositories (SSH deploy key)

Until the app repositories are public, add a read-only GitHub deploy key (an unencrypted ed25519 key, one per repository or one machine-user key) and hand it to the installer:

```bash
ssh-keygen -t ed25519 -N '' -C homebase-deploy -f ~/homebase_deploy
# add ~/homebase_deploy.pub as a read-only deploy key on eforbell/familyDinner
sudo bash install.sh --source-dir /path/to/homeBase --repair --git-ssh-key ~/homebase_deploy
sudo stat -c '%U:%G %a' /etc/sovereign-home/git/deploy_key   # root:root 600
rm ~/homebase_deploy                                            # the installed copy is authoritative
```

Expected: `hello` reports `gitDeployKey: 'present'`, and the Dinner plan's `sync-repository` operation targets `ssh://git@github.com/eforbell/familyDinner.git`. If the key is missing, the install request fails immediately with `GIT_DEPLOY_KEY_REQUIRED` rather than partway through the plan. If the UI has a saved git-transport override, set it to `ssh-key` there as well.

## Executor protocol check

```bash
sudo -u homebase node - <<'NODE'
const { hello } = require('/opt/sovereign-home/homebase/src/executor/client');
hello('/run/homebase/executor.sock').then(console.log).catch((error) => { console.error(error); process.exit(1); });
NODE
```

Expected: `protocolVersions: [2]`, `actions: ['bootstrap', 'install']`, and `mutationsEnabled: true`. Protocol v2 executors compile every plan themselves, so a v1 executor left behind by a partial upgrade reads as incompatible; fix it with `install.sh --repair`.

## Host bootstrap

Run the typed host bootstrap from the UI before installing Dinner. Then:

```bash
systemctl is-active nginx postgresql
readlink /etc/nginx/sites-enabled/sovereign-home      # /etc/nginx/sites-available/sovereign-home
test ! -e /etc/nginx/sites-enabled/default && echo default-site-retired
sudo nginx -t
```

Run bootstrap a second time; it must succeed again (idempotent).

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

Then check routing and reinstall behavior:

```bash
curl -k --fail https://127.0.0.1/dinner/api/ready            # served through the managed gateway
sudo -u sovereign sh -c 'echo OPENAI_API_KEY=sk-vm-canary >> /opt/sovereign-home/apps/familyDinner/.env'
# re-run the Family Dinner install from the UI
sudo grep -c '^OPENAI_API_KEY=sk-vm-canary$' /opt/sovereign-home/apps/familyDinner/.env   # 1: operator value kept
```

A reinstall must restart `family-dinner.service` (check `systemctl show family-dinner -p ActiveEnterTimestamp`) and must not duplicate `.env` keys.

## Mandatory secret audit

Use a unique canary password. After both success and a forced failure, search Home Base SQLite, job log/API responses, and both journals. The canary must not occur in any of them:

```bash
sudo journalctl -u homebase -u homebase-executor --no-pager | grep -F 'CANARY' && exit 1 || true
sudo grep -aF 'CANARY' /var/lib/sovereign-home/homebase/home-base.sqlite3 && exit 1 || true
```

Stop and investigate on any socket permission drift, legacy shell invocation, canary leak, false installed state, or readiness failure.
