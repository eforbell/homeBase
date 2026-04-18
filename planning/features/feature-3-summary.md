# Feature-3: Tailscale Service Publishing Automation

## Purpose

Turn the current manual Tailscale Serve setup into a Homebase-managed publishing flow for the recommended private-access deployment.

## Why This Is Worth Shipping

Tailscale is what makes Sovereign Home deployable for real households without public DNS/firewall complexity. If Homebase can own the prescribed Serve topology, the product feels like a named household service instead of a server with ports.

## Scope

1. Detect Tailscale install/auth/MagicDNS/Serve state.
2. Plan and execute the prescribed Serve lanes.
3. Verify and repair stale/missing publishing config.

## Recommended UX

- Present this as `Publish Sovereign Home on your tailnet`.
- Preview exactly what will be changed.
- Preserve advanced/manual mode for existing Serve users.
- Show final copyable URLs.

## Definition of Done

- A fresh VM can be published through Tailscale Serve without hand-typing Serve commands.
- Homebase can show whether publishing is healthy or stale.
- Existing unrelated Serve config is not silently overwritten.
