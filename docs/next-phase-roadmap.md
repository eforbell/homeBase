# Home Base Next-Phase Roadmap

This document captures the current operating mental model for Home Base after the first successful Ubuntu VM rehearsal.

## Core principle

Home Base should not be handed to anyone else until it is stable enough that **you trust it more than your own manual process**.

That means the standard is not:
- "it basically works"

The standard is:
- repeatable on a clean host
- understandable when it fails
- recoverable when something goes wrong
- pleasant enough that a non-operator can use it without fear

---

# 1. Current status

Home Base has now proven these capabilities at least once on a Debian-family VM:

- host preflight
- bootstrap
- app install
- backup
- restore
- VM feedback loop driving real fixes back into the codebase

This is a major milestone. It means Home Base is already beyond planning and into product hardening.

## But it is not ready for community release yet

Why:
- the UI still feels like an operator console
- the suite of managed apps is still inconsistent in health, onboarding, and manifest maturity
- some workflows are proven once, not yet proven repeatedly
- updates and rollback are not yet at the same maturity level as install/backup/restore

---

# 2. The next standard to hit

## The next target state is:

**"I can trust Home Base to bootstrap and manage my own household server without needing to drop back into manual shell work except for exceptional debugging."**

That is the internal release bar before any wider handoff.

In practice, that means:

- no manual nginx edits for normal install flows
- no manual git transport fixes for normal repo access
- no surprise permission bugs in backup/restore
- retries and health checks are robust enough for normal service startup timing
- the main UI makes next actions obvious
- error states tell you what to do next

---

# 3. Recommended roadmap

## Milestone 1 — repeatable single-host install confidence

### Goal
Prove the latest Home Base defaults work on a fresh machine without the manual fixes discovered in the first VM run.

### Required work
1. Run a **second fresh Ubuntu VM rehearsal**
2. Re-test:
   - bootstrap
   - Family Help install
   - backup
   - restore
3. Confirm these VM-discovered fixes now hold without manual intervention:
   - nginx snippets auto-included
   - SSH-based git cloning works smoothly enough
   - post-restart health checks no longer race
   - backup paths and ownership are correct

### Exit criteria
- one fresh VM completes bootstrap + Family Help install + backup + restore without manual code patching
- all failures, if any, are understandable and localized

---

## Milestone 2 — prove a second app lane

### Goal
Show Home Base is not accidentally overfit to Family Help.

### Recommended next app
**Family Dinner**

Why:
- simple Node app
- no external OAuth complexity
- good second proof for PostgreSQL + systemd + nginx + backup

### Required work
1. install Family Dinner on a fresh or reset VM
2. verify nginx subpath routing works immediately
3. run backup + restore on Dinner as well

### Exit criteria
- two apps can be installed and recovered cleanly
- Home Base is clearly managing a pattern, not a one-off

---

## Milestone 3 — improve the operator UI into a product UI

### Goal
Turn Home Base from a raw testing console into a calm, guided appliance-like interface.

## The problem with the current UI
Right now it is useful, but it still feels like:
- forms
- plans
- raw jobs
- raw logs
- low-level operator vocabulary

That is good for development, but not good enough for a future community release.

## Recommended UI improvements

### 1. Reframe the home page around status + next action
Instead of leading with raw forms, lead with:
- system readiness
- installed apps
- last backup state
- current warnings
- recommended next step

A better home screen structure:
1. **System status**
2. **Installed apps**
3. **Available apps**
4. **Recent jobs**
5. **Advanced actions**

### 2. Add a real setup wizard
The first-time experience should be linear:
1. Welcome
2. Preflight
3. Bootstrap host
4. Confirm hostname / Tailscale reachability
5. Choose apps
6. Install apps
7. Back up your system

This should feel more like:
- a NAS setup flow
- a home router wizard

and less like:
- a deployment control console

### 3. Replace raw result dumps with structured result cards
Keep raw JSON/logs available, but collapse them behind:
- step summaries
- status badges
- action recommendations
- expandable technical details

### 4. Improve job pages
Job pages should show:
- current phase
- completed steps
- failed step if any
- safe retry guidance
- human summary first
- raw log second

### 5. Add app detail pages
Each app should get a dedicated detail page with:
- status
- route
- version/ref
- last backup
- last restore
- actions: backup / restore / restart / update / logs

## Exit criteria
- you no longer need to explain the UI to yourself each time you use it
- someone technical-but-not-ops-minded could follow the happy path without fear

---

## Milestone 4 — converge the suite toward Home Base baselines

### Goal
Reduce the amount of special-case logic Home Base must carry.

## Highest-value suite convergence work

### A. Health endpoints everywhere
Every app should expose:
- `GET /api/health`
- `GET /api/ready`

### B. Manifest files in every repo
Home Base should manage contracts, not infer behavior from repo shape forever.

### C. Better onboarding instead of production seed dependence
Apps should support:
- migrations-only install
- first-run setup from the web UI

### D. Metadata endpoints
Every app should expose:
- app name
- version
- git commit
- manifest/schema version

### E. Consistent DB migration story
Avoid divergent bootstrap patterns as much as possible.

## Suggested app order
1. Family Help
2. Family Dinner
3. Family Plan
4. Bitcoin Accounting
5. Family Pulse

Pulse should stay last because it has the most operational complexity.

---

## Milestone 5 — safe update and rollback flows

### Goal
Get updates to the same maturity level as install/backup/restore.

### Required work
1. pre-update backup is mandatory
2. record installed ref/version before update
3. update to new ref/tag
4. run migrations
5. restart
6. readiness check with retry
7. rollback entrypoint if readiness fails

### Preferred product posture
Near term:
- pinned refs / commits / tags

Later:
- release-based upgrades with readable release notes

### Exit criteria
- you are willing to update your own production server through Home Base
- rollback is available without improvising in the shell

---

# 4. Recommended workstreams

## Workstream A — reliability
This should come first.

### Next items
- second fresh VM run
- Family Dinner full rehearsal
- real rollback/update path
- eliminate remaining manual infra fixes

## Workstream B — UX
This should start once the second VM run is mostly clean.

### Next items
- dashboard redesign
- setup wizard
- app detail pages
- better job pages
- clearer error guidance

## Workstream C — suite convergence
This can proceed in parallel in small pieces.

### Next items
- manifests in app repos
- health/readiness endpoints
- onboarding cleanup
- metadata endpoints

---

# 5. What not to do yet

These should wait until the fundamentals are calmer:

- no Docker support requirement
- no Kubernetes or multi-host orchestration
- no Prometheus/OTEL dependency in the core path
- no artifact registry requirement
- no broad community announcement

The current leverage is in:
- repeatability
- guardrails
- clarity

not scale.

---

# 6. Release gates

## Gate A — founder trust gate
You should be willing to use Home Base instead of your manual process for:
- installing a new app
- backing it up
- restoring it

If you still instinctively drop into shell for the normal path, the product is not ready.

## Gate B — repeatability gate
At least two fresh-VM rehearsals should succeed with little or no manual patching.

## Gate C — second-app gate
At least two different apps should be fully managed end-to-end.

## Gate D — UX gate
The happy path should be understandable without reading the source code or watching job logs constantly.

## Gate E — rollback gate
Update/rollback should be proven before wider handoff.

---

# 7. Immediate next recommended steps

If continuing from today, this is the order I would use:

1. run a **second fresh Ubuntu VM rehearsal** with the latest commits
2. validate that nginx include + SSH clone + health retry fixes removed the manual workarounds
3. install **Family Dinner** end-to-end
4. do backup + restore on Dinner
5. begin the **UI treatment pass**:
   - dashboard restructuring
   - setup wizard
   - app detail pages
6. then move to update/rollback

---

# 8. Simple summary

Home Base is now in the transition from:
- proving capability

to:
- proving reliability
- improving clarity
- earning trust

That is the right place to be.

The immediate mission is not to add more raw power.
It is to make the current power:
- repeatable
- understandable
- comfortable enough that you stop doing the normal work by hand

Once that happens, community release becomes realistic.
