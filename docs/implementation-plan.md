# Home Base Implementation Plan

## Phase 0 — repo review and contract extraction
- review every managed app repo
- document common runtime/deploy assumptions
- define the managed app manifest contract

## Phase 1 — plan-first bootstrap and install flow
- Home Base web shell
- catalog of current apps
- Debian bootstrap planner
- install planner with generated `.env`, systemd, nginx, and shell script output
- local state tracking for planned installs

**Status:** implemented in this slice.

## Phase 2 — durable local state + admin auth
- move JSON state to SQLite
- add admin login/PIN
- record operation history, rendered artifact versions, and rollback targets

## Phase 3 — privileged execution engine
- execute approved bootstrap/install/update plans on-host
- capture stdout/stderr and progress in the UI
- support preflight checks and dry-run previews

## Phase 4 — health + logs + status dashboard
- poll systemd service status
- poll app HTTP health endpoints
- add recent log tails and last-success timestamps
- normalize a suite-wide health payload contract

## Phase 5 — backup and restore
- scheduled PostgreSQL dumps
- filesystem backup declarations from manifest
- restore wizard with staging validation and health verification

## Phase 6 — safe updates
- release channel support
- commit/tag pinning
- pre-update backup + post-update health gate
- one-click rollback to previous known-good ref

## Phase 7 — polish for families
- onboarding wizard
- friendlier copy and recovery guidance
- PWA install affordances
- help text for Tailscale, backup media, and app selection


See also: `docs/next-phase-roadmap.md` for the post-VM reliability, UX, and release-gating plan.
