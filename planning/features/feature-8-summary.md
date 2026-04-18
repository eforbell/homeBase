# Feature-8: Suite Onboarding Baseline Convergence

## Purpose

Make the managed app suite easier for Homebase to install, monitor, back up, and recover by converging on common contracts.

## Why This Is Worth Shipping

Homebase should not remain a pile of app-specific assumptions. The closer each app gets to standard health/readiness/onboarding/manifest behavior, the less brittle Homebase becomes.

## Scope

1. Standard health/readiness/meta endpoints.
2. First-run onboarding instead of required production seed data.
3. Repo-owned managed app manifests.

## Recommended Execution

Proceed app by app:

1. Family Help
2. Family Dinner
3. Family Plan
4. Bitcoin Accounting
5. Family Pulse

## Definition of Done

- Homebase can tell whether each app is alive, ready, and/or needing setup.
- Fresh installs do not depend on manual production seed SQL.
- Manifest data becomes authoritative enough to reduce Homebase hard-coded catalog drift.
