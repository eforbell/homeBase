# Feature-6: Admin Auth and Destructive-Action Guardrails

## Purpose

Add a server-enforced Homebase admin boundary so destructive host-management operations are not protected only by tailnet access and `EXECUTE` prompts.

## Why This Is Worth Shipping

Founder-only testing can tolerate a loose boundary. Launch capability needs clearer protection, especially once Homebase can update, restore, publish services, and manage multiple apps.

## Scope

1. Require admin unlock for destructive actions.
2. Add admin setup/unlock/lock/rotation.
3. Audit destructive action attempts and outcomes.

## Recommended UX

- Keep dry-run and status viewing low-friction.
- Require unlock for operations that mutate host/app state.
- Borrow the simple settings-PIN ergonomics from Family Plan, but adapt the language for a host control plane.

## Definition of Done

- Mutating execute endpoints reject unauthenticated requests.
- Admin can unlock and lock from the UI.
- Destructive actions leave an audit trail.
