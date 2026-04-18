# Feature-6: Guided Setup and First Backup Wizard

## Purpose

Replace the placeholder setup page with a practical first-run flow that gets a founder to a working, published, backed-up Homebase installation.

## Why This Is Worth Shipping

Homebase is intended to reduce shell work. A new founder should not need to know the internal order of Settings, Bootstrap, Apps, Jobs, Publishing, and Backup pages to complete the first useful setup.

## Scope

1. Build a resumable setup checklist from current system state.
2. Guide through admin setup, bootstrap, publishing, app install, and backup destination awareness.
3. Finish with first backup evidence.

## Recommended UX

- Clear linear steps with completed/current/blocked states.
- Allow advanced users to skip/defer publishing and off-host backup, but make the recommended path obvious.
- Finish with evidence: app installed, reachable, and backed up.

## Definition of Done

- A fresh VM setup can be driven primarily from `/setup`.
- Founder can resume after refresh or failure.
- At least one app has a first backup before setup is considered complete, and the backup protection level is explicit.
