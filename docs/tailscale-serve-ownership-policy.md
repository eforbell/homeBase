# Tailscale Serve Ownership Policy (Feature-4 Phase A)

## Decision

Home Base **only manages Home Base-owned Serve endpoints** and must **refuse silent overwrite** of unrelated existing Serve configuration.

This policy is now the implementation constraint for Feature-4 planner/executor work.

## Managed ownership model

Home Base-managed publishing is represented by service key:

- `svc:home`

Home Base may read all services from `tailscale serve get-config --all`, but it only mutates:

- `services["svc:home"]`

It does **not** modify or delete other services such as:

- `svc:bitcoin`
- `svc:lightning`
- `svc:transmission`
- custom/unknown service keys

## Endpoint contract for `svc:home`

Expected Home Base endpoints:

- `tcp:3080 -> http://127.0.0.1:3080`
- `tcp:443 -> https+insecure://localhost:443`

Home Base can:

1. create `svc:home` when missing,
2. repair `svc:home` when stale,
3. verify `svc:home` health/status.

## Conflict behavior (required)

When another non-Home service already owns an endpoint Home Base needs (for example `tcp:443`), Home Base must:

1. stop and report conflict in the preview,
2. refuse execution by default,
3. require an explicit operator override path (future UX) rather than implicit replacement.

Until an override UX exists, default behavior is **no change**.

## Merge behavior (required)

Execution behavior must be merge-preserving:

1. fetch current full Serve config,
2. patch only `services["svc:home"]`,
3. preserve all unrelated keys/values,
4. write resulting config.

No “replace all services” flow is allowed in default execution.

## Phase-A evidence sources

Real fixture captures used to shape this policy live under:

- `test/fixtures/tailscale/serve-config-all-*.json`

Notable observed cases:

- empty config (`local-mac`)
- mixed multi-service config including existing `svc:home` (`erebor`)
- non-home services on `tcp:443` (`numenor`)
- single unrelated service (`rivendell`)

## Directive

Do not loosen this policy during Feature-4 implementation without updating this document and adding explicit regression tests that prove unrelated services remain untouched.
