# Installing Home Base

Home Base installs as a loopback-only control-plane service plus a narrow, socket-activated executor on a supported Ubuntu or Debian host. The installer gets those services running; it does not bootstrap the host or install managed apps automatically.

## Supported baseline

- Ubuntu Server 24.04 or newer, or Debian 12 or newer
- `sudo`/root access for installation
- outbound HTTPS access to GitHub release assets (not required with `--source-dir`)
- systemd
- a home-lab operator comfortable reading `systemctl` and `journalctl` output

The installer supplies the minimum runtime packages through `apt`: CA certificates, curl, tar, Python 3, and Node.js. Node.js 18 or newer is required. npm is installed later by the host bootstrap when managed Node applications need it; Home Base itself has no runtime package dependencies.

## Install a tagged release

Download and inspect the installer:

```bash
curl -fsSLO https://raw.githubusercontent.com/eforbell/homeBase/main/install.sh
less install.sh
sudo bash install.sh --version v0.1.0
```

Preview the resolved operation without changing the host:

```bash
sudo bash install.sh --version v0.1.0 --dry-run
```

Install and enable the unit without starting it:

```bash
sudo bash install.sh --version v0.1.0 --no-start
```

## Install from a local checkout

For a private-repository or pre-release VM test, install from a clean, checked-out Git worktree instead of GitHub Releases:

```bash
cd ~/homeBase
git status --short
sudo bash install.sh --source-dir "$PWD" --version v0.1.0
```

`--source-dir` accepts an absolute path only. It requires a clean Git worktree and packages its checked-out commit with `git archive`; uncommitted and untracked files are never installed. The resulting archive then follows the same checksum, archive-safety, dependency, ownership, systemd, socket, and health-check path as a release install.

## What the installer does

1. Verifies the supported OS and Node.js baseline.
2. Downloads `homebase-<version>.tar.gz` and its `.sha256` file from the matching GitHub release, or packages the selected clean local checkout with `--source-dir`.
3. Rejects unsafe archive paths, links, device entries, checksum mismatches, and unmanaged existing install directories.
4. Installs root-owned application code at `/opt/sovereign-home/homebase`.
5. Creates the unprivileged `homebase` runtime user.
6. Creates state at `/var/lib/sovereign-home/homebase` and configuration at `/etc/sovereign-home/homebase.env`.
7. Installs and enables `homebase.service`.
8. Starts Home Base on `127.0.0.1:3080` unless `--no-start` was supplied.

## Security posture

The generated environment uses:

```text
HOME_BASE_BIND_HOST=127.0.0.1
HOME_BASE_EXECUTION_MODE=executor
HOME_BASE_ENABLE_PRIVILEGED_JOBS=1
HOME_BASE_AUTO_BOOTSTRAP=0
```

The Home Base web unit sets `NoNewPrivileges`, a strict read-only system filesystem, kernel/control-group protections, a private temporary directory, and a single writable state directory. The separate root executor is available only through a `root:homebase-exec` Unix socket and accepts only typed, policy-approved operations.

The installer refuses to continue if `/etc/sudoers.d/homebase` already exists or if a preserved environment enables legacy privileged execution or auto-bootstrap. It does not remove or rewrite those files automatically; the operator must inspect and remove or replace the legacy configuration.

Home Base never auto-runs host changes. An operator must set up an admin account and explicitly confirm real typed jobs; it also provides inspectable bootstrap/install/backup/restore plans.

## Accessing the service

The service listens only on loopback. From another workstation, use an SSH tunnel during initial setup:

```bash
ssh -L 3080:127.0.0.1:3080 operator@home-server
```

Then open `http://127.0.0.1:3080/` locally. Configure the intended Tailscale/private-network publishing path only after reviewing the generated network plan. Do not expose Home Base directly to the public internet.

## Reruns and upgrades

Rerunning the installer with the same version preserves application code, the environment file, and state while refreshing the systemd unit. An unmanaged install directory or a different installed version causes a safe stop.

In-place upgrades are deliberately not part of the first installer. Package a new tagged release, verify it in a disposable VM, and use the documented update plan until an atomic release-directory switch is implemented.

## Build release assets

From a clean Home Base checkout at the release commit:

```bash
scripts/build-release.sh v0.1.0
```

Upload both generated files to the matching GitHub release:

```text
dist/homebase-0.1.0.tar.gz
dist/homebase-0.1.0.tar.gz.sha256
```

The public installer will not fall back to `main` when those assets are missing.

## Diagnostics

```bash
systemctl status homebase
journalctl -u homebase --no-pager
curl --fail http://127.0.0.1:3080/api/homebase/health
```

The environment file is preserved on reruns. Do not paste it, job logs, generated application secrets, or backup paths into public issues.
