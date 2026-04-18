# Planning

Small feature plans live here.

Pattern mirrors the Family Plan planning workspace:

- `current-feature.json` tracks what is active now and the ordered launch-confidence sequence.
- `progress.txt` is a lightweight running log.
- `features/feature-N-prd.json` holds the structured mini-plan.
- `features/feature-N-summary.md` is the human-readable summary.

## Execution convention

1. Start each feature on its own branch from `main`.
2. Keep each branch scoped to one mini-PRD unless the PR explicitly updates this roadmap first.
3. Use tests and VM/browser evidence before marking stories complete.
4. Open a PR for each feature branch so review history is explicit.
5. Merge only after founder review plus agent/code-review evidence is captured.

## Story status process

Story statuses live in `current-feature.json` while a feature is active.

- `queued` — planned, not started.
- `in_progress` — implementation branch has begun.
- `review` — implementation is complete and PR is open.
- `verified` — tests plus required manual/VM evidence have passed.
- `deferred` — intentionally removed from the active PR scope.

The `passes` field inside mini-PRDs is the planning default. It should become true only when the story's acceptance criteria have matching test/manual evidence in the feature PR.

## Commit / PR record

Use the repo's Lore-style commit trailers for non-trivial feature commits. Expected useful trailers are:

- `Constraint:` external constraint that shaped the change
- `Rejected:` alternative considered and why it was rejected
- `Confidence:` low/medium/high
- `Scope-risk:` narrow/moderate/broad
- `Reversibility:` clean/messy/irreversible
- `Directive:` warning for future maintainers
- `Tested:` verification performed
- `Not-tested:` known verification gaps

## Launch-confidence definition

"Launch" here does **not** mean public/community release. It means founder-confidence launch: Eric can run his own household apps through Homebase and use Homebase instead of routine shell work for normal operations.

Founder-confidence launch requires:

1. routine app operations are discoverable (open, backup, restore, rerun failed jobs),
2. app health/readiness and critical failures are visible and can alert the founder,
3. destructive operations require Homebase admin authorization,
4. private Tailscale service publishing is managed or clearly verified by Homebase,
5. backups are not silently local-only and an off-host backup destination story is addressed,
6. setup leads to at least one installed, reachable, backed-up app,
7. app updates require backup and have honest rollback semantics,
8. enough suite baseline convergence exists that Homebase can tell installed vs ready.

## Ordered launch-confidence features

1. App Operations UX Parity
2. App Health, Readiness, and Alerts
3. Admin Auth and Destructive-Action Guardrails
4. Tailscale Service Publishing Automation
5. Backup Destination and Retention Confidence
6. Guided Setup and First Backup Wizard
7. Managed App Update and Rollback
8. Suite Onboarding Baseline Convergence
