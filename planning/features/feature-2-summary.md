# Feature-2: App Health, Readiness, and Alerts

## Purpose

Make Homebase tell the truth about installed apps and notify the founder when critical things break. Installed is only one state; the UI should distinguish service state, HTTP health, app onboarding readiness, and critical failures.

## Why This Is Worth Shipping

Founder trust depends on knowing whether Homebase is managing working apps, not just whether install jobs once completed. Visibility alone is not enough: if Family Plan or nginx fails overnight, the founder should not have to poll the dashboard.

## Scope

1. Add systemd and HTTP health probes for installed apps.
2. Show health warnings on app cards, dashboard, and app detail.
3. Represent onboarding/readiness separately from deployment status.
4. Add opt-in critical failure notifications using the existing suite brrr-style pattern.

## Recommended UX

- Show deployment status and runtime health as separate signals.
- Use actionable wording: `Service stopped`, `HTTP check failing`, `Needs setup`, `Healthy`.
- Keep checks asynchronous/cached so the UI stays responsive.
- Make alerts opt-in and deduped to avoid noise.

## Definition of Done

- Stopping an app service is reflected in Homebase without reading logs.
- A healthy app and an installed-but-not-ready app are visibly different.
- Dashboard surfaces unhealthy apps as recommended next actions.
- A critical health failure can notify the founder through a configured channel.
