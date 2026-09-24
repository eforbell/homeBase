# Home Base

Home Base is the control plane for The Sovereign Home: a Debian-first web application that bootstraps a host, installs family apps, generates config artifacts, and centralizes operations.

**Status: Developer Preview.** Home Base is intentionally plan-first and binds its web control plane to loopback. Its unprivileged web service delegates only explicitly confirmed, typed operations to a separate root executor; it does not use broad sudo or arbitrary shell commands.

## Install on Ubuntu or Debian

The release installer replaces the manual clone-first setup:

```bash
curl -fsSLO https://raw.githubusercontent.com/eforbell/homeBase/main/install.sh
less install.sh
sudo bash install.sh --version v0.1.0
```

The installer verifies a tagged release checksum, installs hardened web and executor systemd units, preserves state on safe reruns, and refuses existing Home Base sudoers or legacy-execution configuration. See [`docs/install.md`](docs/install.md) for prerequisites, release packaging, recovery, and the manual equivalent.

For a private-repository or pre-release VM, run the checkout directly with `sudo bash install.sh --source-dir "$PWD" --version v0.1.0`; it packages the clean checked-out commit locally and does not access GitHub Releases.

## Current slice

This initial slice delivers:

- architecture and recommendations docs
- a managed app manifest schema
- a built-in catalog for the current Sovereign Home apps
- a working web UI + JSON API for:
  - host preflight checks
  - Debian bootstrap plan generation
  - bootstrap dry-run / execution jobs
  - app installation plan generation
  - install dry-run / execution jobs
  - backup plan generation and restore planning scaffolds
  - generated artifact previews (`.env`, systemd units, nginx snippets)
  - SQLite-backed local state tracking for planned installs and jobs

The service does not auto-run host changes. It produces deterministic plans and executes only explicit, admin-confirmed typed jobs through the separate executor. Legacy broad-sudo execution is not supported by the installer.

## Run

```bash
npm start
```

Open `http://localhost:3080` by default.

### Founder/private-repo mode

For public-community installs, Home Base now defaults to HTTPS GitHub clone URLs.

If you want founder/private-repo SSH-key auth instead, run Home Base with:

```bash
export HOME_BASE_GIT_TRANSPORT=ssh-key
export HOME_BASE_GIT_SSH_KEY_PATH=/opt/sovereign-home/.ssh/id_founder_homebase
export HOME_BASE_GIT_SSH_KNOWN_HOSTS_PATH=/opt/sovereign-home/.ssh/known_hosts
PORT=3080 npm start
```

The SSH key path must be readable by the managed service user because app clone/fetch commands run as that user.

## Test

```bash
npm test
```

## Docs

- `docs/architecture.md`
- `docs/recommendations.md`
- `docs/app-manifest-schema.md`
- `docs/implementation-plan.md`
- `docs/suite-baselines.md`
- `docs/vm-next-steps.md`
- `docs/next-phase-roadmap.md`
- `docs/homebase-service-runtime-plan.md`
- `docs/install.md`

## License

MIT — see [`LICENSE`](LICENSE).
