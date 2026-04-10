# Home Base

Home Base is the control plane for The Sovereign Home: a Debian-first web application that bootstraps a host, installs family apps, generates config artifacts, and centralizes operations.

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

This prototype is intentionally **plan-first**. It does not auto-run privileged host changes yet; instead it produces deterministic plans and executable shell scripts so the install flow can be reviewed and applied safely.

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
