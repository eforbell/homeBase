# Home Base Service-Runtime Implementation Plan

This plan focuses on the next major slice after the first full Ubuntu VM rehearsal:

**Install Home Base as a first-class service on the target host, then tighten the UX so the same machine can be managed comfortably through Home Base itself.**

The goal is not more raw capability. The goal is to eliminate the remaining places where a founder has to think like a shell operator instead of trusting Home Base as the resident control plane.

---

## 1. Problem statement

The first full VM rehearsal proved:
- Home Base can bootstrap a host
- Home Base can install an app
- Home Base can back up and restore an app
- VM-discovered issues can be folded back into code quickly

It also exposed a structural weakness:
- Home Base is still being launched like a developer tool from an interactive shell
- permissions and backup inventory become awkward because the UI process does not yet have a stable installed runtime model

That is the next architectural gap to close.

---

## 2. Primary objective

Create a stable, installed Home Base runtime model with:
- a dedicated runtime user
- a systemd service
- persistent config and state locations
- a cleaner privilege boundary
- enough UX treatment to make the app feel like a control plane rather than a testing console

---

## 3. Scope of this slice

## In scope

### A. Home Base self-install/runtime model
- install Home Base into a stable host path
- run it as a persistent systemd service
- move state and logs into stable host-managed locations
- add a self-health view for Home Base itself

### B. Backup metadata persistence
- stop relying on direct filesystem scans in the UI where practical
- store backup records in SQLite when backup jobs succeed
- show backup history from DB first

### C. UX changes that unblock trust
These are the small UX changes worth doing in the same slice because they directly improve trust during real use:
1. visible submission/progress feedback when an action is launched
2. app-store-style catalog on the home page
3. app detail pages with install/backup/restore/open actions
4. "Open" button after install
5. better preflight result presentation

### D. App onboarding contract capture
Document and start designing the shift from:
- `db/seed.sql` as a practical first-use crutch

to:
- proper first-run onboarding inside each app

## Out of scope
- full update/rollback engine implementation
- full visual redesign of every screen
- multi-host orchestration
- community release polish

---

## 4. Success criteria

This slice is complete when all of the following are true:

### Runtime/platform
- Home Base can install or configure itself as a systemd-managed service
- Home Base survives reboot cleanly
- Home Base uses stable state/config paths outside the git checkout
- interactive shell context is no longer required for normal operation

### Operational trust
- backup history is visible without requiring raw directory scans
- Home Base can show its own service status and state DB health
- app actions provide immediate feedback after submission

### UX
- home page no longer looks like repeated operator tiles
- installed apps are easy to find at a glance
- an installed app has an **Open** action
- app actions live on app detail pages instead of being repeated inline everywhere

### Product clarity
- the roadmap for removing seed.sql dependence is documented
- the distinction between public HTTPS repo flow and advanced private/staging repo auth is clear

---

## 5. Recommended architecture

## 5.1 Home Base runtime identity

### Recommended directories
- code checkout or release dir: `/opt/sovereign-home/homebase`
- env/config: `/etc/sovereign-home/homebase.env`
- state DB: `/var/lib/sovereign-home/homebase/home-base.sqlite3`
- future job logs or retained artifacts: `/var/lib/sovereign-home/homebase/`

### Recommended user
- dedicated service user: `homebase`

Do **not** run the UI process as root.

### Recommended service unit
- `homebase.service`
- user: `homebase`
- environment file: `/etc/sovereign-home/homebase.env`
- working directory: `/opt/sovereign-home/homebase`

---

## 5.2 Privilege model

### Desired posture
- Home Base web service runs as `homebase`
- app services run as their app/service users
- privileged mutations are still invoked through explicit `sudo`-wrapped commands or a later helper model

This keeps:
- the web app unprivileged by default
- destructive operations explicit
- host mutations auditable

---

## 5.3 Backup metadata model

When a backup job succeeds, record to SQLite:
- app id
- archive dir
- generated_at
- dry_run
- included files summary
- status
- related job id

Then the UI can show:
- latest backup time
- available restore points
- last backup status

without depending on direct `scandir` behavior.

Filesystem discovery can remain as a fallback or repair tool.

---

## 5.4 UX model shift

### Current home page
- repeated card forms
- too much scrolling
- too much operator-language density

### Target home page

#### Section 1 — System status
- Home Base service health
- preflight status
- PostgreSQL/nginx status
- last backup summary
- active warnings

#### Section 2 — Installed apps
Each installed app row/card should show:
- name
- status
- route
- last backup
- version/ref
- actions: Open, Details

#### Section 3 — App catalog
- smaller app-store-like cards
- install CTA only for not-installed apps

#### Section 4 — Recent jobs
- compact list with status and links into detail pages

### App detail pages
Each app gets:
- overview/status
- route + Open button
- install/update/backup/restore actions
- last job history
- logs/technical details behind a second layer

---

## 6. UX notes to explicitly carry forward

From the latest sessions:

### Note 1 — action submission feedback
When running installs or other jobs, there must be an immediate visual indicator that the action was accepted. The current delay before the job appears feels uncertain.

**Implementation direction:**
- temporary pending state on button
- show created job id immediately in UI
- start polling automatically

### Note 2 — app-store home page
The home page should feel like an app store, not a matrix of near-duplicate operational tiles.

**Implementation direction:**
- move action-heavy controls off the home page
- make app cards navigational first
- reveal app controls in detail views

### Note 3 — Open button after install
Installed apps should expose an obvious **Open** action.

**Implementation direction:**
- use stored `externalUrl`
- show Open button on installed app card/detail page

### Note 4 — onboarding and seed.sql
Several apps still need seed data to become usable after install. That is acceptable for rehearsal, but not for long-term product posture.

**Implementation direction:**
- introduce an onboarding readiness state per app
- later add app-specific onboarding flows
- keep demo/dev seed behavior separate from production onboarding

---

## 7. Phased execution plan

## Phase A — install Home Base as Home Base

### Tasks
1. add a Home Base self-install plan/service unit renderer
2. create `homebase.service`
3. move config/state paths to host-managed locations
4. add Home Base service health endpoint/view
5. add a simple self-check page

### Acceptance
- Home Base runs via systemd
- reboot-safe
- no interactive shell required

---

## Phase B — persist backup inventory and self-state

### Tasks
1. add backup_records table to SQLite
2. write backup metadata on successful backup job completion
3. read backup list from DB in the UI
4. add fallback repair path that can re-index from disk if needed

### Acceptance
- backup list is stable and fast
- no raw permission issue from direct backup directory browsing in normal UI flows

---

## Phase C — trust-improving UX changes

### Tasks
1. immediate pending/submission states for actions
2. homepage auto-refresh and better summaries
3. app-store-style catalog
4. app detail pages
5. Open button for installed apps
6. structured preflight result screen

### Acceptance
- less scrolling
- next action obvious
- no raw JSON needed for normal happy path

---

## Phase D — onboarding contract and app readiness

### Tasks
1. define per-app onboarding state model
2. document which apps currently depend on seed data
3. add UI labels such as:
   - installed
   - needs onboarding
   - ready to open
4. create follow-on plan for replacing seed.sql reliance with first-run setup

### Acceptance
- Home Base can truthfully tell the operator whether an app is merely installed or truly usable

---

## 8. Suggested implementation order

If executing now, I would build in this order:

1. Home Base self-install/systemd service
2. backup metadata persistence in SQLite
3. action submission feedback + app detail pages
4. app-store-style home page
5. onboarding/readiness state model

This order preserves the rule:
- reliability and identity first
- UX treatment second
- broader app onboarding work after that foundation exists

---

## 9. Risks to watch

### Risk: over-designing the UI before runtime identity is stable
Mitigation: install Home Base as a service first.

### Risk: keeping app controls duplicated on the home page while adding detail pages
Mitigation: move toward summary cards on home, full controls on detail views.

### Risk: assuming install == usable
Mitigation: add onboarding readiness states explicitly.

### Risk: backup metadata drift if DB write succeeds but filesystem write does not
Mitigation: only persist backup record after successful command completion.

---

## 10. Immediate next recommendation

If starting implementation next, the first concrete work item should be:

**Install Home Base as a systemd-managed service with stable config/state locations, then move backup inventory into SQLite-backed metadata.**

That is the biggest trust improvement for the next round of testing and makes the later UX work cleaner.
