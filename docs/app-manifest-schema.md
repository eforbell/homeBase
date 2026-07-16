# Sovereign Home Managed App Manifest Schema

Home Base needs a normalized contract so each app can be installed, updated, backed up, monitored, and restored without hard-coding one-off logic in the control plane.

## Required fields

| Field | Purpose |
|---|---|
| `id` | stable machine id used by Home Base |
| `name` | human label |
| `repository.url` | source repository |
| `repository.defaultRef` | default install/update ref |
| `runtime.kind` | `node` or `python` |
| `runtime.installCommand` | dependency install command |
| `runtime.startCommand` | process start command |
| `network.preferredMountPath` | default nginx/Tailscale route |
| `network.preferredPort` | preferred upstream port |
| `network.health.*` | liveness/readiness contract |
| `database.engine` | `postgres`, `postgres-or-sqlite`, etc. |
| `database.bootstrap` | `migrations`, `schema-file`, etc. |
| `service.name` | primary systemd service name |
| `config.env` | environment template rendered by Home Base |

## Optional but important fields

| Field | Purpose |
|---|---|
| `sidecars[]` | extra long-running services such as MCP servers |
| `timers[]` | scheduled systemd timers |
| `storage.paths[]` | filesystem state to back up |
| `updateNotes[]` | operator guidance and caveats |
| `database.seedPolicy` | whether seed files are safe to run |

## Example

```json
{
  "id": "family-help",
  "name": "Family Help",
  "repository": {
    "url": "https://github.com/eforbell/familyHelp.git",
    "defaultRef": "main"
  },
  "runtime": {
    "kind": "node",
    "installCommand": "npm ci --omit=dev",
    "startCommand": "node server.js"
  },
  "network": {
    "preferredMountPath": "/help/",
    "preferredPort": 3002,
    "health": {
      "type": "synthetic-http",
      "livenessPath": "/",
      "readinessPath": "/api/stats"
    }
  },
  "database": {
    "engine": "postgres",
    "bootstrap": "migrations",
    "databaseName": "familyhelp",
    "databaseUser": "familyhelp"
  },
  "service": {
    "name": "family-help",
    "description": "Family Help App"
  },
  "config": {
    "env": {
      "DATABASE_URL": "{{databaseUrl}}",
      "PORT": "{{port}}"
    }
  },
  "timers": [
    {
      "serviceName": "family-help-reminders",
      "timerName": "family-help-reminders.timer",
      "onCalendar": "*:0/30"
    }
  ],
  "storage": {
    "paths": ["uploads"]
  }
}
```

## Contract rules

1. **Home Base renders service units; app repos do not own production paths.**
2. **Seed data is opt-in only.** Household apps must never assume founder sample data should be loaded.
3. **Health definitions are mandatory.** If an app lacks a real health endpoint, the manifest must declare the synthetic probe Home Base should use.
4. **Filesystem state must be declared.** If an app writes outside PostgreSQL, Home Base needs to know.
5. **Runtime caveats belong in the manifest.** Example: Family Pulse’s public OAuth callback needs special routing guidance.

Timer schedules may use `onCalendar` for wall-clock schedules or `onBootSec` /
`onUnitActiveSec` for monotonic schedules. `randomizedDelaySec` maps directly to the
systemd timer directive. Every timer must define at least one schedule directive.

The machine-readable schema lives at `manifests/sovereign-app-manifest.schema.json`.
