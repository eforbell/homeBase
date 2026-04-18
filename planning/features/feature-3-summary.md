# Feature-3: Admin Auth and Destructive-Action Guardrails

## Purpose

Add a server-enforced Homebase admin boundary before Homebase expands into service publishing, setup orchestration, and update/rollback operations.

## Why This Is Worth Shipping

Feature 1 makes operations easier to find. Feature 4 will publish Homebase more deliberately on the tailnet. Tailnet access plus `EXECUTE` prompts is not a sufficient guardrail once real household data and backups are involved.

## Scope

1. Require admin unlock for destructive actions.
2. Add admin setup/unlock/lock/rotation.
3. Audit destructive action attempts and outcomes.

## Recommended UX

- Keep dry-run and status viewing low-friction.
- Require unlock for operations that mutate host/app state.
- Borrow simple settings-PIN ergonomics from Family Plan, adapted for a host control plane.

## Definition of Done

- Mutating execute endpoints reject unauthenticated requests.
- Admin can unlock and lock from the UI.
- Destructive actions leave an audit trail.
