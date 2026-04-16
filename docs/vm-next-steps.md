# Recommended Next Steps for Home Base and VM Validation

You now have an Ubuntu Server 24.04 VM to test the full path safely before touching your own production machine. That is exactly the right next move.

This document splits the next work into:

1. what to build next in Home Base
2. what to test first in the VM
3. the recommended order of operations

---

## 1. My recommended next actionable steps for Home Base

## Step 1 — add a real executor, but keep it gated

Right now Home Base generates good plans. The next real capability should be:
- execute generated plans on-host
- capture stdout/stderr live
- mark each step pass/fail
- stop immediately on first failure
- save the log and rendered artifacts for review

Important constraint:
- keep a **dry-run / plan-preview mode**
- make actual execution an explicit action

### Why this is next
Without execution, you cannot validate the real operational seams on the VM.

## Step 2 — move Home Base state from JSON to SQLite

Add durable tables for:
- jobs
- rendered artifacts
- installed apps
- health snapshots
- backup records
- rollback targets

### Why this is next
As soon as executor jobs exist, JSON becomes too fragile.

## Step 3 — add host probes and preflight checks

Before any install/update runs, Home Base should verify:
- Debian/Ubuntu release
- disk space
- RAM/swap summary
- `sudo` access or root context
- `systemd` available
- PostgreSQL service state
- nginx config test passes
- Tailscale installed / authenticated / hostname known
- Tailscale Serve publishing status for the prescribed Home Base service topology
- required ports are free

### Why this is next
This is what will make the VM test loop fast instead of confusing.

## Step 4 — implement one golden-path install completely

Do not try to automate the whole suite at once.

Pick one first app for end-to-end proof. My recommendation:
- **Family Help** or **Family Dinner** first

Why:
- both are operationally simpler than Pulse
- fewer external integration risks
- good test of DB, nginx, systemd, and Home Base rendering

## Step 5 — implement backup before update automation

Before one-click updates, implement:
- pre-operation PostgreSQL dump
- artifact/config backup
- restore command generation

### Why this order
Install without rollback is acceptable in a VM.
Update without rollback is not acceptable for the real household server.

## Step 6 — add health dashboard after executor

Once install and execution exist, add:
- systemd state
- recent journal tail
- HTTP liveness/readiness results
- last successful backup
- app version/commit

---

## 2. Recommended VM validation plan

The VM should be treated as a product rehearsal, not just a smoke test.

## Stage A — bootstrap only

Goal:
- prove Home Base can prepare a clean Ubuntu 24.04 host

Test:
- install required packages
- create service user and directory layout
- enable PostgreSQL and nginx
- install Tailscale
- generate and validate nginx structure
- publish the recommended Tailscale Serve config for Home Base and app subpaths
- verify `tailscale serve get-config --all` matches the prescribed endpoints

Success criteria:
- rerunning bootstrap is idempotent
- nothing breaks on second run
- no unexpected prompts beyond known interactive system steps
- after Tailscale authentication, service publishing does not require manual Serve command entry

## Stage B — install Home Base on the VM itself

Goal:
- prove Home Base can operate inside the same style of host it will manage

Test:
- clone `homeBase`
- run it on the VM
- access it from your host browser
- verify generated plans are correct for the VM environment

Success criteria:
- Home Base starts cleanly after reboot
- state persists
- generated paths and URLs match the VM reality

## Stage C — install one simple app end to end

Recommended first app:
- **Family Help** or **Family Dinner**

Test:
- create DB role + DB
- clone repo
- render `.env`
- install dependencies
- run migrations
- install systemd unit
- install nginx snippet
- start service
- verify health through nginx path and upstream path

Success criteria:
- app reachable in browser
- service survives reboot
- Home Base shows successful install state
- second install run behaves safely/idempotently

## Stage D — uninstall and reinstall that same app

Goal:
- test recoverability

Test:
- stop service
- remove nginx snippet
- optionally drop DB and app directory
- reinstall from Home Base

Success criteria:
- reinstall works cleanly
- no stale systemd/nginx state breaks the second install

## Stage E — backup and restore rehearsal

Goal:
- prove disaster recovery before update automation

Test:
- take backup
- intentionally change or corrupt app state
- restore DB and any filesystem assets
- verify app health after restore

Success criteria:
- backup artifacts are understandable and usable
- restore flow is deterministic

## Stage F — update rehearsal

Goal:
- validate commit/tag pinning and rollback

Test:
- install known-good ref
- update to a newer ref
- simulate failure
- restore previous ref + DB backup

Success criteria:
- Home Base can point to a previous known-good state
- rollback is operator-friendly

---

## 3. Recommended order of app onboarding in the VM

My recommended order:

1. **Family Help**
2. **Family Dinner**
3. **Family Plan**
4. **Bitcoin Accounting**
5. **Family Pulse**

### Why this order
- Help/Dinner prove the base mechanics first
- Plan adds calendar-specific config complexity
- Bitcoin Accounting adds Python + venv + manual schema concerns
- Pulse is the most operationally complex because of cron, sidecar, Plaid, and OAuth exposure

---

## 4. Exact next build order I recommend

If I were continuing from the current Home Base repo, I would do this next:

### Build slice 1
- SQLite state
- job table
- execution logs
- plan execution engine for bootstrap only

### Build slice 2
- Family Help golden-path installer executor
- real step-by-step progress UI
- rerun-safe install behavior

### Build slice 3
- backup engine for one app
- restore rehearsal in the VM

### Build slice 4
- health dashboard
- systemd/journal/http probes

### Build slice 5
- update engine with pre-update backup and rollback

### Build slice 6
- expand coverage to Dinner, Plan, Bitcoin Accounting, then Pulse

---

## 5. What I would not do yet

I would **not** do these before the VM loop is healthy:

- no Docker support layer
- no Kubernetes or remote orchestration
- no artifact registry pipeline
- no Prometheus/OTEL dependency in the core path
- no multi-host clustering logic
- no Pulse production OAuth automation as the first deployment proof

---

## 6. Strong recommendation for the VM phase

Treat the VM work as creating a **known-good install transcript**.

For each rehearsal, capture:
- OS version
- Home Base commit
- target app commit
- commands run
- rendered files
- success/failure notes
- what had to be adjusted manually

That transcript will become the basis for:
- tightening the executor
- cleaning up app manifests
- building confidence before touching prod

---

## 7. My single recommended immediate next step

If you want the highest-leverage next move:

**Build a gated executor plus SQLite job/state storage, then use it to bootstrap the Ubuntu VM and install Family Help end to end.**

That gives you the fastest path from architecture to real confidence.
