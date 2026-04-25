# Tailscale fixtures (Feature-4 Phase A)

These fixtures ground Feature-4 parser/planner behavior in real CLI outputs.

## Files

- `status-snapshot-*.json`  
  Sanitized status snapshots (subset fields only).
- `serve-config-all-*.json`  
  Full command envelopes for `tailscale serve get-config --all` captures.
- `version-*.json`  
  CLI version evidence from local and selected remote Linux hosts.

## Capture notes

- `status --json` raw payloads can include large peer maps and host keys.
- This repository stores **sanitized status snapshots** for status fixtures.
- Serve fixtures are kept as command envelopes (`stdout`, `stderr`, `exitCode`) to preserve parser realism.
- Hostnames, tailnet/domain identifiers, and direct peer/address details are anonymized for repository safety while preserving structural shape.

## Current Phase-A limitations

- We have real examples for empty and populated Serve configs.
- We now include Linux fixtures for both `NeedsLogin` (not logged in) and `Stopped` backend states from real host captures.
- We still do not include a hard daemon-unreachable capture where the CLI cannot talk to `tailscaled`; add one during VM validation if we need that edge case.
