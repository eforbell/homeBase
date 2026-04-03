# Home Base Recommendations

## 1. Update strategy

### Option A — Pull-based updates (current pattern)
**How it works:** Home Base fetches from GitHub, checks out a branch/commit, installs dependencies, runs migrations, restarts the app.

**Pros**
- already proven in every repo
- simple mental model
- no new CI/publishing infrastructure required

**Cons**
- branch tips are a moving target
- harder for non-engineers to know whether an update is “safe”
- rollback is possible, but only if Home Base records the previous commit and config state

### Option B — Release-based updates
**How it works:** each app publishes semver-ish Git tags/releases; Home Base installs by release tag and surfaces release notes.

**Pros**
- much safer for families
- easy to explain: “update to Family Dinner 1.4.2”
- rollback is straightforward: reinstall the previous tag
- still compatible with the existing git-based deploy scripts

**Cons**
- requires the project to adopt release discipline
- slightly more process overhead for maintainers

### Option C — Artifact-based updates
**How it works:** apps publish tarballs or built bundles; Home Base installs artifacts instead of source.

**Pros**
- most deterministic install output
- avoids build surprises on the target host

**Cons**
- highest pipeline complexity
- adds publish/storage steps the project does not need yet
- less transparent for a small open-source household stack

### Recommendation
**Recommend Option B as the default product target, implemented in two phases:**

1. **Near-term:** keep today’s pull-based mechanics, but pin installs to an explicit commit or tag and record the previous ref for rollback.
2. **Target default:** move the suite to release tags and let Home Base present release notes, upgrade channels, and one-click rollback.

**Do not make artifact-based delivery a requirement for v1.** It adds complexity without enough benefit for the current scale.

---

## 2. Observability approach

### Option A — systemd status polling only
**Pros**: zero new app work, minimal dependencies.
**Cons**: only tells you the process is alive, not whether the app is actually healthy.

### Option B — standardized HTTP health endpoints
**Pros**: directly answers “is the app up and can it serve requests?”; works well with Home Base UI.
**Cons**: requires suite-wide standardization because current apps are inconsistent.

### Option C — Prometheus + exporters
**Pros**: good ecosystem, power-user friendly, easy future integration.
**Cons**: extra dependency and extra concepts for non-technical households.

### Option D — OpenTelemetry stack
**Pros**: flexible, industry-standard, future-friendly.
**Cons**: far too heavy for the problem right now.

### Recommendation
**Recommend a baseline of A + B together:**

- Home Base should always collect:
  - `systemctl is-active`
  - last service restart time
  - short recent journal tail
- Home Base should also prefer a suite-standard HTTP health contract:

```json
{
  "status": "ok",
  "version": "1.2.3",
  "checks": {
    "db": "ok"
  },
  "timestamp": "2026-04-03T15:00:00Z"
}
```

This is intentionally simpler than the IETF draft format while remaining extensible.

**Why this is the right fit:** it gives families a clear answer to “is it running?” without requiring them to learn observability tooling.

**Future path:** expose optional Prometheus-compatible metrics later, but do not make them part of the core Home Base dependency set.

---

## 3. Routing recommendation

### Options
- **Shared host + subpaths** (`/plan/`, `/help/`, `/dinner/`)
- **Dedicated per-app hostnames** (`plan.homebase.tailnet`, etc.)
- **Hybrid**

### Recommendation
**Use shared host + subpaths by default, with per-app override support.**

Why:
- it matches most existing repos
- it keeps family-facing URLs simple
- it minimizes nginx complexity for first installs

Override cases:
- Family Pulse production Plaid OAuth may need a dedicated public callback host/path
- any future app that cannot be made subpath-safe should be routed by hostname instead

---

## 4. Backup strategy

### Recommendation
Default backup unit should include:
- PostgreSQL custom-format dump per app (`pg_dump -Fc`)
- Home Base state store and rendered manifests
- app-owned filesystem state (for example `familyHelp/uploads`)

Retention recommendation:
- 7 daily
- 4 weekly
- 6 monthly

Restore recommendation:
- restore into a staging DB first where practical
- run app health verification before replacing the live service

---

## 5. Internal state storage for Home Base

### Options
- JSON files
- SQLite
- PostgreSQL

### Recommendation
- **Prototype:** JSON file state is acceptable.
- **Before broad use:** move Home Base to **SQLite**.

Why SQLite:
- zero service dependency
- simple backups
- resilient even when PostgreSQL is down
- enough structure for jobs, rollbacks, and restore history
