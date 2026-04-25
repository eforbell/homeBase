# Feature-3a: Control Plane Navigation and Settings IA Split

## Purpose

Break the current Settings run-on page into clearer control-plane areas before Tailscale publishing lands.

## Why This Is Worth Shipping

Home Base is itself an operational control plane. If Feature-4 is added to the current Settings page, it will turn a crowded page into a worse junk drawer and undo recent UI cleanup.

## Scope

1. Split Settings into Status, Admin, Config, and Network surfaces.
2. Add a scalable nav pattern, including mobile overflow handling.
3. Restore a green UI-test baseline before Feature-4 begins.

## Recommended UX

- Treat Home Base as a control plane with named functional areas.
- Keep Status focused on system health and repair actions.
- Keep Admin focused on authorization and audit.
- Keep Config focused on Home Base preferences and update posture.
- Introduce Network as the dedicated Tailscale home instead of bolting publishing onto Config.

## Definition of Done

- The old Settings junk-drawer is gone or clearly deprecated.
- Navigation cleanly exposes Status/Admin/Config/Network on desktop and mobile.
- Baseline Home Base tests are green again before Feature-4 starts.
