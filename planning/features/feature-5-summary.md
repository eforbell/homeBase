# Feature-5: Managed App Update and Rollback

## Purpose

Make app updates safe enough that the founder is willing to update their own household server through Homebase.

## Why This Is Worth Shipping

Install without rollback is acceptable during VM rehearsal. Update without rollback is not acceptable for a real household server. This feature turns update from a risky shell action into a guarded Homebase workflow.

## Scope

1. Require pre-update backup and record update metadata.
2. Execute update with a post-update health gate.
3. Offer rollback to previous known-good state.

## Recommended UX

- Start with explicit ref/commit updates.
- Show backup, previous ref, target ref, and health result in the job summary.
- Make rollback visible when update fails.

## Definition of Done

- One managed app can be updated and rolled back in a VM without shell improvisation.
- Update jobs never skip the backup requirement.
- Failure leaves a clear next action.
