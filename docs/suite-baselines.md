# Suite Baselines and Refactoring Recommendations

This document answers two related questions:

1. How should the existing Sovereign Home apps be refactored so Home Base can manage them more safely?
2. What baseline should every future app follow from day one?

Because the suite is fully owned, the goal should be **intentional convergence**, not just documentation around drift.

---

## 1. What should become common across the suite

These are the highest-value baselines to standardize.

### A. Runtime model

**Recommendation:** every managed app should declare one primary runtime shape:
- host-native process
- systemd-managed
- nginx-proxied
- PostgreSQL-backed unless there is a strong exception

**Why:** this is already the de facto production model. Home Base gets dramatically simpler if it is managing one lane instead of many.

### B. Repository contract

Every app repo should eventually include:
- `README.md`
- `.env.example`
- `deploy/`
- `deploy/manifest.json` or `homebase.manifest.json`
- `deploy/install.sh` or `deploy/deploy.sh`
- `db/` with one clearly documented bootstrap path
- `test/` coverage for startup/health/bootstrap assumptions

### C. Health contract

Every app should expose:
- `GET /api/health` — liveness, fast, no expensive work
- `GET /api/ready` — readiness, includes DB check and critical dependency checks

Suggested payload:

```json
{
  "status": "ok",
  "app": "family-help",
  "version": "1.0.0",
  "checks": {
    "db": "ok"
  },
  "timestamp": "2026-04-03T15:00:00Z"
}
```

Also useful:
- `GET /api/meta` for app name, version, git commit, and supported manifest version

### D. Database contract

Pick one supported pattern for new apps:
- numbered SQL migrations in `db/migrations/`
- migration runner script in `db/migrate.js` or equivalent
- `schema_migrations` tracking table
- optional `db/schema.sql` as snapshot only, not the primary production path

**Avoid for future apps:**
- raw `schema.sql` + runtime self-healing as the only migration story
- production installs that depend on seed scripts
- destructive seed files mixed into normal install instructions

### E. Config contract

Split config into three buckets and keep them explicit:

1. **Environment config**
   - secrets
   - ports
   - URLs
   - external credentials
2. **Runtime app config in DB**
   - prompts
   - thresholds
   - household-tunable settings
3. **Home Base manifest metadata**
   - install/update/backup/health behavior

This separation already exists implicitly in some apps. Make it consistent.

### F. Service contract

Every app should have exactly one of these declared:
- one primary service only
- one primary service plus explicit sidecars
- one primary service plus explicit timers

That should be machine-readable in the manifest.

### G. Backup contract

Each app should declare:
- DB name
- DB user
- filesystem paths that contain user data
- whether restore requires a service stop
- post-restore health endpoint to verify

### H. Routing contract

Default routing policy should be:
- subpath-safe apps by default
- no absolute asset URLs
- no absolute fetch paths
- no hard-coded hostnames in frontend code

But Home Base should still allow hostname routing for exceptions.

---

## 2. Recommended refactors for the current apps

## Family Pulse

### Keep
- migration runner
- health endpoint
- structured logging effort
- sidecar separation for MCP

### Refactor next
- make routing contract explicit: either truly subpath-safe or intentionally hostname-only
- move cron/scheduled jobs out of the web process over time
  - ideal end state: timers or a dedicated worker service
- add `GET /api/ready`
- add machine-readable manifest file
- expose version/commit metadata
- make public OAuth callback handling an explicit deployment mode in the manifest

### Why
Pulse is the operational outlier because it mixes web serving, background jobs, and external OAuth complexity.

## Family Help

### Keep
- migration discipline
- service + timer separation
- uploads clearly local to the app

### Refactor next
- add real `/api/health` and `/api/ready`
- document `uploads/` as formal app-owned state in-repo
- fix local Docker port/doc mismatch
- add version metadata endpoint
- add manifest file

### Why
Help is close to a strong baseline already. It mostly needs observability and machine-readable metadata.

## Family Dinner

### Keep
- migration runner
- subpath-safe frontend pattern
- single-process simplicity

### Refactor next
- add `/api/health` and `/api/ready`
- add any baseline auth/admin guard needed for destructive routes
- stop relying on bootstrap-via-schema-then-mark-all-migrations-applied
- fix schema/migration drift so fresh installs and upgraded installs converge to the same state
- add manifest file

### Why
Dinner is operationally simple, but it is currently too easy for schema drift to hide.

## Family Plan

### Keep
- subpath-safe deployment posture
- useful `/api/status`
- clear nginx expectations

### Refactor next
- add standard `/api/health` and `/api/ready` alongside `/api/status`
- replace runtime schema compatibility drift with real migrations
- move undocumented env vars into `.env.example`
- make DB-vs-env config boundaries explicit
- add manifest file

### Why
Plan has good product behavior, but its startup-time schema mutation is a weak long-term operational baseline.

## Bitcoin Accounting

### Keep
- liveness/readiness split
- base-path discipline
- repo-local virtualenv pattern
- explicit runtime init command

### Refactor next
- formalize PostgreSQL migration story beyond manual schema + ad hoc migration script
- add manifest file
- expose version/commit metadata
- normalize service install docs to Home Base conventions

### Why
Bitcoin Accounting already has the cleanest health and deployment posture, but its DB bootstrap/migration story is still more manual than ideal.

---

## 3. Standard that future apps should follow from day one

Every future app should start from a common app template.

## Required baseline for new apps

### Repo layout

```text
app-name/
  README.md
  .env.example
  package.json or pyproject.toml
  server.js or app entrypoint
  public/
  lib/ or src/
  db/
    migrate.js
    migrations/
    schema.sql          # optional snapshot only
  deploy/
    homebase.manifest.json
  test/
```

### Required behavior
- one primary service
- explicit health + readiness endpoints
- migration runner
- no production seed dependency
- subpath-safe frontend unless intentionally declared otherwise
- no hard-coded founder paths or usernames in committed service units
- version endpoint or metadata route
- backup path declarations

### Required Home Base manifest fields
- runtime kind
- install command
- start command
- health endpoints
- DB bootstrap command
- filesystem backup paths
- service/timer/sidecar list
- route mode (`subpath` or `hostname`)
- upgrade channel support (`branch`, `tag`, `release`)

---

## 4. Concrete convergence roadmap

Recommended order:

### Phase 1 — metadata convergence
Apply to all repos:
- add manifest file
- add version metadata endpoint
- document backup paths
- document route mode

### Phase 2 — health convergence
Apply to all repos:
- add `/api/health`
- add `/api/ready`
- standardize payload shape

### Phase 3 — DB convergence
Apply to all repos:
- standard migration runner
- no runtime-only schema mutation as primary mechanism
- no production seed dependence

### Phase 4 — deployment convergence
Apply to all repos:
- standard env variable names where practical
- generated systemd units instead of hand-maintained host-specific ones
- standard nginx header behavior

### Phase 5 — job/process convergence
Apply especially to Pulse:
- move scheduled work into explicit timers/workers
- keep web processes focused on web traffic

---

## 5. Opinionated baseline decisions I recommend

If you want Home Base to stay small and robust, I would standardize on these opinions:

- Node apps stay no-build unless a future app truly needs a build step
- Python apps use repo-local `.venv`
- PostgreSQL is the default and expected app DB
- SQLite is for Home Base internals, not the suite at large
- systemd is the only required process manager
- nginx is the only required reverse proxy
- release tags become the default update channel
- health/readiness endpoints are mandatory
- manifests are mandatory
- production seeds are never automatic

---

## 6. Most important thing to do next across the suite

If I had to pick the single highest-leverage refactor across all apps, it would be this:

**Add a Home Base manifest plus standard `/api/health` and `/api/ready` endpoints to every app.**

That one move sharply reduces Home Base complexity and turns app management from inference into contract.
