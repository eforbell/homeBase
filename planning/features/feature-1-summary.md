# Feature-1: App Operations UX Parity

## Purpose

Make the installed-app experience match Homebase's actual backend capabilities. A founder should not have to know that backup/restore controls are hidden on app detail pages or that recovery actions can be reached only through curl or job logs.

## Why This Is Worth Shipping

Founder confidence depends on routine operations being obvious: open the app, inspect details, back it up, restore it, and recover from failed jobs. The backend can already run backup and restore jobs, but the `/apps` screen still presents only `Open` and `Backup dry-run`, which makes Homebase feel unfinished.

## Scope

1. Add explicit `Details`, `Backup`, and `Restore` paths on installed app cards.
2. Make App Detail the clear operations center with stable sections and anchors.
3. Surface latest backup / first-backup state on cards and detail.
4. Add failed-job rerun UX to the operations path.
5. Warn when backups are local-only so the founder does not confuse local backup with disaster recovery.

## Recommended UX

- Keep installed cards summary-first: Open, Details, Backup…, Restore…
- Route restore to `/apps/:id#restore` unless a safe single-backup shortcut is designed.
- Keep real execution guarded by `EXECUTE`.
- Make first backup a visible recommendation after install.
- Show local-only backup risk until Feature-5 adds off-host destination confidence.

## Definition of Done

- A founder can discover backup and restore without reading docs.
- App cards do not imply backup is dry-run-only.
- App detail supports direct links to backup and restore sections.
- Latest backup state is visible for installed apps.
- Failed jobs have visible recovery paths.
- Local-only backup risk is visible before launch.
