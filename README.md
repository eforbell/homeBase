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
  - generated artifact previews (`.env`, systemd units, nginx snippets)
  - SQLite-backed local state tracking for planned installs and jobs

This prototype is intentionally **plan-first**. It does not auto-run privileged host changes yet; instead it produces deterministic plans and executable shell scripts so the install flow can be reviewed and applied safely.

## Run

```bash
npm start
```

Open `http://localhost:3080` by default.

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
