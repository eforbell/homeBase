# Upgrading Home Base

## To the root-executor release (branch `feature/root-executor-protocol`)

This release adds the typed root executor for installer-built hosts. **Existing hosts that run Home Base with sudo (legacy mode) keep working, but need one environment change first.**

### Legacy-mode hosts (Home Base run with a `homebase` sudoers rule)

Execution modes are now explicit and fail closed. Before this release, `HOME_BASE_ENABLE_PRIVILEGED_JOBS=1` alone enabled sudo-based jobs. Now it also needs an execution mode, or Home Base starts in plan-only mode and every real action returns `PRIVILEGED_EXECUTION_DISABLED`.

Before updating, while still on the old release:

1. Add this line to the Home Base environment file. The old release ignores it, so it is safe to add now:
   ```
   HOME_BASE_EXECUTION_MODE=legacy-sudo
   ```
   Home Base does **not** read a `.env` file in its checkout; it sees only what systemd passes it. Find the right file with `systemctl cat homebase | grep -E 'EnvironmentFile|Environment='` (often `/etc/sovereign-home/homebase.env`). After restarting, confirm the running process has it:
   ```bash
   sudo tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value homebase)/environ | grep '^HOME_BASE_E'
   ```
2. Confirm the file still contains `HOME_BASE_ENABLE_PRIVILEGED_JOBS=1`.
3. Only if something reaches Home Base on `:3080` **without** `tailscale serve`, also add `HOME_BASE_BIND_HOST=0.0.0.0`. The service now binds to `127.0.0.1` by default. `tailscale serve` already proxies to 127.0.0.1:3080, so the normal path is unaffected.

Update as usual (Home Base update in the UI, or `git pull` + `npm ci --omit=dev` + `systemctl restart homebase`). Then:

4. Confirm `node_modules/ajv` exists in the Home Base directory. The executor needs it; the web service starts without it.
5. Open Status: preflight should be green apart from anything genuinely missing.

If you skip step 1, the service logs, and every refused action returns, the exact line to add.

Legacy hosts do not get a `homebase-executor` service, and a UI bootstrap will not create one: only `sudo bash install.sh` installs the root executor, so the web process can never create its own root service. Legacy mode does not use it.

What changes for legacy hosts:

- **Backups now include external storage.** Apps that keep data outside their checkout (`storage.absoluteRoot`, e.g. Home Source documents) were silently missing from legacy backups. Take a fresh backup of Home Source after upgrading. Older Home Source backups contain only the database.
- **Upload limits are now written into nginx snippets** (`client_max_body_size`: Home Source 55M, Bug Base 12M, Home Ops 20M) the next time each app is installed or updated. Before, uploads over 1 MB were rejected by nginx.
- A dry-run of an installed app no longer demotes it to "planned".

### Installer-built hosts (`install.sh`, executor mode)

Refresh with `sudo bash install.sh --source-dir <checkout> --repair` (add `--git-ssh-key <key>` for private repositories). Use `--repair`, not `--repair-executor`: the executor loads shared code from `src/`, and web and executor move to protocol v2 together.
