# Feature-7: Managed App Update and Rollback

## Purpose

Make app updates safe enough that the founder is willing to update their own household server through Homebase.

## Why This Is Worth Shipping

Install without rollback is acceptable during VM rehearsal. Update without rollback is not acceptable for a real household server. Rollback must be honest: safe rollback restores pre-update data as well as code, or it is clearly labeled unsafe/code-only.

## Scope

1. Require pre-update backup and record update metadata.
2. Execute update with a post-update health gate.
3. Offer rollback that restores code and pre-update backup by default.

## Recommended UX

- Start with explicit ref/commit updates.
- Show backup, previous ref, target ref, and health result in the job summary.
- Make rollback visible when update fails.
- Never present code-only rollback as safe if data migrations or state changes may have occurred.

## Definition of Done

- One managed app can be updated and rolled back in a VM without shell improvisation.
- Update jobs never skip the backup requirement.
- Safe rollback restores both code and pre-update data/files where applicable.
- Failure leaves a clear next action.
