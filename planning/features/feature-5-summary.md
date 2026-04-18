# Feature-5: Backup Destination and Retention Confidence

## Purpose

Make backup protection honest. Same-VM backups are useful for app state mistakes, but they do not protect against VM loss, disk loss, or accidental host deletion.

## Why This Is Worth Shipping

For a product called Sovereign Home, backup confidence is a launch blocker. Homebase should not let the founder mistake local backups for disaster recovery.

## Scope

1. Identify and warn on local-only backup state.
2. Add one supported off-host backup destination path.
3. Show retention and restore confidence clearly.

## Recommended UX

- Label local-only backups plainly.
- Start with one boring destination rather than a plugin system.
- Show latest local and off-host backup timestamps.
- Preserve restore usability as the real proof.

## Definition of Done

- Founder knows whether backups are local-only.
- At least one off-host destination path can be configured and verified.
- Restore picker and app cards can distinguish local and replicated backup state.
