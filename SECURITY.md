# Security Policy

## Scope and security posture

Home Base is the control plane for the Sovereign Home suite. It inventories hosts, generates `.env`, systemd, nginx, install, backup, and restore artifacts, manages application deployment plans, can use private-repository SSH keys, and may execute privileged host changes. Compromise can affect every managed app, so Home Base must be treated as privileged infrastructure even when its UI runs as an unprivileged user.

The default safe posture is plan-first, local/Tailnet-only, least privilege, reviewed execution, and recoverable changes.

## Non-negotiable rules

1. Never run the Home Base web service as root.
2. Do not expose it directly to the public internet. Use localhost or Tailscale/private-network access and HTTPS at the proxy.
3. Generated `.env` files, rendered configuration, job logs, SQLite state, database passwords, backup manifests, and private-repo credentials are sensitive.
4. Keep real secrets, SSH keys, known-hosts state, backups, dumps, and generated runtime directories out of git.
5. Separate planning from execution. Show the exact command/artifact plan before changes, preserve dry-run behavior, and make destructive operations explicit and reversible.
6. Create and verify pre-operation backups before update, restore, uninstall, or other destructive jobs. Current execution routes do not enforce a verified-backup gate, so the operator must treat this as a required control gap rather than an automatic safeguard.

## Privilege boundary

Home Base runs as a dedicated service user. The public installer configures loopback binding, `NoNewPrivileges=true`, `ProtectSystem=strict`, and systemd kernel hardening for the web service. The web service cannot elevate through `sudo`.

Privileged work goes through `homebase-executor`, a root service reachable only through `/run/homebase/executor.sock` (`root:homebase-exec 0660`; `homebase` is the only group member). Callers name a high-level action (`bootstrap`, or `install` with a catalog app id, a ref, and a transport). The executor compiles the operation plan itself from the root-owned catalog, validates it against schema and policy, generates any secrets it needs, and runs it. It never accepts plans, shell text, paths, or secrets from the web process. npm, git, migrations, and app code run as `sovereign`, never root. See `docs/root-executor-implementation-plan.md`.

The security boundary is that request contract, not the executor's systemd sandbox. The executor is root and must write and start systemd units, which run outside any sandbox applied to the executor itself, so `NoNewPrivileges`, `RestrictSUIDSGID`, `ProtectHome`, and a restrictive `UMask` would add no containment. They would only break apt/dpkg privilege drops, setuid package files, and maintainer scripts. The executor unit therefore keeps only directives that are harmless to package management (`PrivateTmp`, `ProtectKernelModules`, `ProtectKernelTunables`, `ProtectControlGroups`, `RestrictRealtime`, `LockPersonality`) and runs with `UMask=0022`. Do not reintroduce the removed directives without a VM run of host bootstrap and an app install.

Root handlers treat anything `sovereign` can write as hostile. Ownership and mode changes go through an `O_NOFOLLOW` directory descriptor (`fchown`/`fchmod`), never by path, so an entry swapped for a symlink mid-operation cannot redirect them. Files inside app-owned directories are read and written only after temporarily assuming the `sovereign` identity. App units never use `EnvironmentFile=` pointing into app-owned directories, because systemd reads that file as root; apps load their own `.env` after dropping to `User=`.

The runtime planner and public installer refuse a legacy `homebase ... NOPASSWD:ALL` rule. `HOME_BASE_EXECUTION_MODE=legacy-sudo` remains only as an explicit compatibility switch for existing private installations; Home Base does not create the required sudo policy.

Job input, repository refs, filesystem paths, app manifests, hostnames, unit names, and proxy paths are untrusted command-generation inputs. Validate against allowlists, avoid shell interpolation, use structured process arguments where possible, and keep execution logs free of secrets.

## Generated secrets and private repositories

- Generate high-entropy credentials; never silently overwrite an existing secret during re-planning or reinstall.
- Render secret-bearing artifacts with restrictive permissions and redact values from API responses, previews, diffs, and logs.
- Private-repo SSH access uses one dedicated, **read-only**, unencrypted deploy key installed with `install.sh --git-ssh-key <path>`. It is stored root-only (`/etc/sovereign-home/git/deploy_key`, `0600`) and only root's `ssh` ever reads it. The executor fetches as root into a root-owned bare mirror (`/var/lib/sovereign-home/git-mirrors/`) with hooks and fsmonitor disabled. `sovereign` then clones or fast-forwards the app checkout from that local mirror and never sees a credential. GitHub host keys are pinned (`StrictHostKeyChecking=yes`) and tested against GitHub's published fingerprints.
- Do not disable SSH host-key checking or copy private keys into application checkouts.
- Rotate credentials when an artifact, log, preview, backup, issue, or commit exposes them. Rotation comes before history cleanup.

## Tailscale Serve ownership

Home Base may mutate only the configured Home Base-owned Tailscale service (currently `svc:home`). It must preserve unrelated services and refuse endpoint conflicts rather than overwrite another owner. Changes to publishing, merge behavior, ownership detection, or conflict handling require the policy and tests in `docs/tailscale-serve-ownership-policy.md`.

Tailnet reachability reduces exposure but is not a replacement for app authentication, authorization, or secure session handling.

## Backups and recovery

Backups must cover Home Base state/manifests plus every managed application's database and app-owned filesystem data. Encrypt backups moved off-host, store recovery credentials separately, and test restoration into staging before replacing a live service. A generated backup plan is not proof that a usable backup exists.

Restore and uninstall jobs require explicit target confirmation, preflight checks, path containment, and a clear rollback plan. Never follow user-controlled symlinks into unmanaged paths.

## Security-sensitive verification

Run the full test suite after changes to planners, executors, manifest validation, path handling, secrets, backups/restores, SSH transport, Tailscale publishing, or privilege configuration. Specifically preserve conflict refusal and non-owned-service tests for Tailscale, dry-run/plan parity, and tests that ensure generated commands stay within managed directories.

## Incident response

For suspected compromise: disable Home Base network access and privileged jobs, preserve redacted job/audit logs, rotate generated/app credentials and private-repo keys, inspect managed hosts for unauthorized units/config/commands, verify backups, and rebuild from a known-good state when trust cannot be restored.

## Reporting a vulnerability

Do not open a public issue containing credentials, generated configs, SSH material, hostnames, job logs, or backup details. Report privately through a GitHub Security Advisory when available, or contact the repository owner privately. Include affected planner/executor paths, reproduction steps, impact, and a redacted proof of concept.

There is no bug bounty program or guaranteed response SLA.
