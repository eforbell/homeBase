# Feature-9: Managed App Uninstall

## Purpose

Give the founder a reliable, explicit way to fully uninstall a managed app from HomeBase.

## Why This Is Worth Shipping

HomeBase currently helps install, back up, restore, and increasingly update apps, but it does not offer the inverse operation. That makes VM testing slower, production cleanup harder, and routine founder workflows dependent on shell cleanup or old snapshots. If an app is no longer wanted—or needs to be removed to prove reinstallability—HomeBase should be able to uninstall it cleanly.

## Scope

1. Add a first-class **Uninstall** action for installed apps.
2. Require admin unlock plus an extra destructive confirmation.
3. Remove HomeBase-managed app state so the app returns to **Available to install**.
4. Support an explicit optional **Keep backups** toggle that defaults ON for founders who want a safety snapshot before uninstall.

## Recommended UX

- Use the word **Uninstall** everywhere in the UI.
- Put the action on app detail, not as a casual summary-card primary action.
- Explain clearly that uninstall is destructive and intended to fully remove the app from HomeBase.
- Offer a **Keep backups** toggle that defaults ON and clearly explains whether local backup archives will remain on disk.
- After uninstall succeeds, remove the app from installed views and show it only as available to install again.
- If preserved backup archives remain on disk, a later reinstall may rediscover them through HomeBase's existing disk backup inventory behavior.

## Definition of Done

- An installed app can be uninstalled from HomeBase without shell cleanup.
- Uninstall requires admin authorization and a second explicit confirmation.
- After uninstall, the app no longer appears installed, managed, or restorable in HomeBase.
- The same app can then be reinstalled cleanly in a VM rehearsal.
