# Feature-2: App Health and Readiness Visibility

## Purpose

Make Homebase tell the truth about installed apps: installed is only one state. The UI should distinguish service state, HTTP health, and app onboarding readiness.

## Why This Is Worth Shipping

Founder trust depends on knowing whether Homebase is managing a working app, not just whether an install job once completed. This is the next layer after making backup/restore discoverable.

## Scope

1. Add systemd and HTTP health probes for installed apps.
2. Show health warnings on app cards, dashboard, and app detail.
3. Start representing onboarding/readiness separately from deployment status.

## Recommended UX

- Show deployment status and runtime health as separate signals.
- Use actionable wording: `Service stopped`, `HTTP check failing`, `Needs setup`, `Healthy`.
- Keep checks asynchronous/cached so the UI stays responsive.

## Definition of Done

- Stopping an app service is reflected in Homebase without reading logs.
- A healthy app and an installed-but-not-ready app are visibly different.
- Dashboard surfaces unhealthy apps as recommended next actions.
