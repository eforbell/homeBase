#!/usr/bin/env bash
set -Eeuo pipefail

PROGRAM="homebase-install"
DEFAULT_VERSION="v0.1.0"
RELEASE_VERSION="${HOMEBASE_VERSION:-$DEFAULT_VERSION}"
CHANNEL="preview"
PORT="${HOMEBASE_PORT:-3080}"
DRY_RUN=0
NO_START=0
REPAIR=0
REPAIR_EXECUTOR=0
ADD_EXECUTOR=0
SWITCH_TO_EXECUTOR=0
SOURCE_DIR=''
GIT_SSH_KEY_SOURCE=''
FORCE=0
TEST_MODE="${HOMEBASE_TEST_MODE:-0}"

INSTALL_DIR="${HOMEBASE_INSTALL_DIR:-/opt/sovereign-home/homebase}"
STATE_DIR="${HOMEBASE_STATE_DIR:-/var/lib/sovereign-home/homebase}"
ENV_FILE="${HOMEBASE_ENV_FILE:-/etc/sovereign-home/homebase.env}"
UNIT_FILE="${HOMEBASE_SYSTEMD_UNIT:-/etc/systemd/system/homebase.service}"
RUNTIME_USER="${HOMEBASE_RUNTIME_USER:-homebase}"
LEGACY_SUDOERS_FILE="${HOMEBASE_LEGACY_SUDOERS_FILE:-/etc/sudoers.d/homebase}"
EXECUTOR_SOCKET_UNIT="${HOMEBASE_EXECUTOR_SOCKET_UNIT:-/etc/systemd/system/homebase-executor.socket}"
EXECUTOR_SERVICE_UNIT="${HOMEBASE_EXECUTOR_SERVICE_UNIT:-/etc/systemd/system/homebase-executor.service}"
EXECUTOR_SOCKET_PATH="${HOMEBASE_EXECUTOR_SOCKET_PATH:-/run/homebase/executor.sock}"
EXECUTOR_GROUP="${HOMEBASE_EXECUTOR_GROUP:-homebase-exec}"
GIT_DEPLOY_KEY_DIR="${HOMEBASE_GIT_DEPLOY_KEY_DIR:-/etc/sovereign-home/git}"
GIT_DEPLOY_KEY_PATH="${GIT_DEPLOY_KEY_DIR}/deploy_key"
# --add-executor only: the executor's own root-owned code, kept apart from a legacy host's web checkout
# (which its runtime user owns, so root must never load code from it).
COEXIST_EXECUTOR_DIR="${HOMEBASE_COEXIST_EXECUTOR_DIR:-/opt/homebase-executor}"
# The legacy web's state database; resolved from the env file for the legacy-host modes.
STATE_DB="${HOMEBASE_STATE_DB:-}"
# Root-owned marker that lets the executor run adopt; exists only between the two legacy-host modes.
# Fixed outside test mode: the executor checks this exact path (executor/actions.js).
COEXIST_MARKER='/etc/sovereign-home/legacy-coexistence'
if [ "$TEST_MODE" = '1' ] && [ -n "${HOMEBASE_COEXIST_MARKER:-}" ]; then COEXIST_MARKER="$HOMEBASE_COEXIST_MARKER"; fi

usage() {
  cat <<'EOF'
Install Home Base as a hardened, loopback-only, plan-first systemd service.

Usage:
  sudo bash install.sh [options]

Options:
  --version <tag>      Release tag to install (default: v0.1.0)
  --source-dir <path>  Package a clean local Git checkout instead of downloading a release
  --channel preview    Release channel (preview is currently the only channel)
  --port <port>        Loopback HTTP port (default: 3080)
  --dry-run            Print the resolved installation without changing the host
  --no-start           Install and enable units without starting them
  --repair             Restore managed code and service assets without replacing state or environment
  --repair-executor    Restore the executor's code (executor/, src/, schemas/, dependencies),
                       group, socket, and units without touching config or state
  --force              With --repair/--repair-executor: proceed even if the executor's state
                       cannot be confirmed (it did not answer); never skips a busy check
  --git-ssh-key <path> Install an unencrypted SSH deploy key for private app repositories
                       (stored root-only at /etc/sovereign-home/git/deploy_key) and
                       switch Home Base to SSH git transport
  --add-executor       Legacy-sudo hosts: add the typed executor next to the running legacy
                       service (root-owned code in /opt/homebase-executor) without changing
                       its mode, sudoers policy, or web checkout, so apps can be adopted one
                       at a time. With --git-ssh-key, only the executor uses the key.
  --switch-to-executor Legacy-sudo hosts, after every app is adopted: replace the legacy web
                       checkout with the managed hardened install, switch to executor mode,
                       and remove the legacy sudoers policy
  --help               Show this help

The installer does not grant Home Base sudo access or execute host bootstrap.
EOF
}

log() {
  printf '[%s] %s\n' "$PROGRAM" "$*"
}

die() {
  printf '[%s] ERROR: %s\n' "$PROGRAM" "$*" >&2
  exit 1
}

validate_preserved_env() {
  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function normalize(value, first, last) {
      value = trim(value)
      first = substr(value, 1, 1)
      last = substr(value, length(value), 1)
      if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) {
        value = substr(value, 2, length(value) - 2)
      }
      return tolower(trim(value))
    }
    /^[[:space:]]*(#|$)/ { next }
    {
      separator = index($0, "=")
      if (!separator) next
      key = trim(substr($0, 1, separator - 1))
      value = normalize(substr($0, separator + 1))
      if (key == "HOME_BASE_EXECUTION_MODE" && value != "" && value != "plan-only" && value != "executor") {
        print key "=" value
        exit 1
      }
      if (key == "HOME_BASE_AUTO_BOOTSTRAP" \
          && value != "" && value != "0" && value != "false" && value != "no" && value != "off") {
        print key "=" value
        exit 1
      }
    }
  ' "$1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die '--version requires a value'
      RELEASE_VERSION="$2"
      shift 2
      ;;
    --source-dir)
      [ "$#" -ge 2 ] || die '--source-dir requires a value'
      SOURCE_DIR="$2"
      shift 2
      ;;
    --channel)
      [ "$#" -ge 2 ] || die '--channel requires a value'
      CHANNEL="$2"
      shift 2
      ;;
    --port)
      [ "$#" -ge 2 ] || die '--port requires a value'
      PORT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    --repair)
      REPAIR=1
      shift
      ;;
    --repair-executor)
      REPAIR_EXECUTOR=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --add-executor)
      ADD_EXECUTOR=1
      shift
      ;;
    --switch-to-executor)
      SWITCH_TO_EXECUTOR=1
      shift
      ;;
    --git-ssh-key)
      [ "$#" -ge 2 ] || die '--git-ssh-key requires a path'
      GIT_SSH_KEY_SOURCE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[ "$CHANNEL" = 'preview' ] || die "unsupported channel: $CHANNEL"
[ $((REPAIR + REPAIR_EXECUTOR + ADD_EXECUTOR + SWITCH_TO_EXECUTOR)) -le 1 ] \
  || die '--repair, --repair-executor, --add-executor, and --switch-to-executor are mutually exclusive'
# The switch removes the sudoers policy, the adopt marker, and the coexistence copy only after the hardened
# service has started and answered; without a start there is nothing to verify, so there is no --no-start.
[ "$SWITCH_TO_EXECUTOR" -eq 0 ] || [ "$NO_START" -eq 0 ] \
  || die '--switch-to-executor cannot be combined with --no-start: it removes the legacy sudo policy only after the new service is running and healthy'
printf '%s\n' "$RELEASE_VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  || die "version must be a tag such as v0.1.0"
printf '%s\n' "$RUNTIME_USER" | grep -Eq '^[a-z_][a-z0-9_-]*$' \
  || die 'runtime user must be a valid system account name'
case "$PORT" in
  ''|*[!0-9]*) die 'port must be an integer' ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die 'port must be between 1 and 65535'

# A trailing slash would defeat git's safe.directory match below.
[ "$SOURCE_DIR" = '/' ] || SOURCE_DIR="${SOURCE_DIR%/}"
if [ -n "$SOURCE_DIR" ]; then
  case "$SOURCE_DIR" in
    /*) ;;
    *) die '--source-dir must be an absolute path' ;;
  esac
  [ -d "$SOURCE_DIR" ] || die "--source-dir does not exist or is not a directory: $SOURCE_DIR"
fi

for candidate in "$INSTALL_DIR" "$STATE_DIR" "$ENV_FILE" "$UNIT_FILE" "$LEGACY_SUDOERS_FILE" "$EXECUTOR_SOCKET_UNIT" "$EXECUTOR_SERVICE_UNIT" "$EXECUTOR_SOCKET_PATH" "$COEXIST_EXECUTOR_DIR" "$COEXIST_MARKER"; do
  case "$candidate" in
    /*) ;;
    *) die "installation paths must be absolute: $candidate" ;;
  esac
  case "$candidate" in
    *$'\n'*|*$'\r'*) die 'installation paths may not contain newlines' ;;
  esac
  case "$candidate" in
    *' '*|*$'\t'*) die "installation paths may not contain whitespace: $candidate" ;;
  esac
  # Paths are written into unit and env files (via sed); keep them to plain path characters.
  printf '%s\n' "$candidate" | grep -Eq '^[A-Za-z0-9/._-]+$' \
    || die "installation paths may only contain letters, digits, '/', '.', '_', and '-': $candidate"
done

# The coexistence copy is deleted after a switch; it must never contain (or be inside) the install dir.
case "${INSTALL_DIR}/" in "${COEXIST_EXECUTOR_DIR}/"*) die "--add-executor's directory may not contain ${INSTALL_DIR}" ;; esac
case "${COEXIST_EXECUTOR_DIR}/" in "${INSTALL_DIR}/"*) die "--add-executor's directory may not be inside ${INSTALL_DIR}" ;; esac

if [ -n "$GIT_SSH_KEY_SOURCE" ]; then
  case "$GIT_SSH_KEY_SOURCE" in
    /*) ;;
    *) die '--git-ssh-key must be an absolute path' ;;
  esac
  [ -f "$GIT_SSH_KEY_SOURCE" ] && [ ! -L "$GIT_SSH_KEY_SOURCE" ] && [ -r "$GIT_SSH_KEY_SOURCE" ] \
    || die "--git-ssh-key must be a readable regular file: $GIT_SSH_KEY_SOURCE"
  grep -q 'PRIVATE KEY-----' "$GIT_SSH_KEY_SOURCE" || die '--git-ssh-key does not look like an SSH private key'
  if command -v ssh-keygen >/dev/null 2>&1; then
    # The executor runs git non-interactively, so a passphrase-protected key can never be used.
    ssh-keygen -y -P '' -f "$GIT_SSH_KEY_SOURCE" >/dev/null 2>&1 \
      || die '--git-ssh-key must be an unencrypted key (use a dedicated read-only deploy key)'
  fi
fi

if [ "$TEST_MODE" != '1' ]; then
  [ "$(id -u)" -eq 0 ] || die 'run this installer through sudo or as root'
fi

# Asks a live executor whether a plan is in flight. Exit status: 0 = a plan is running, 1 = confirmed
# idle (or no executor socket at all), 2 = could not tell. Repairs proceed only on a confirmed answer:
# interrupting a restore or uninstall midway is worse than running stale code a little longer.
executor_plan_state() {
  if [ "$TEST_MODE" = '1' ] || [ ! -S "$EXECUTOR_SOCKET_PATH" ]; then return 1; fi
  command -v node >/dev/null 2>&1 && id -u "$RUNTIME_USER" >/dev/null 2>&1 || return 2
  runuser -u "$RUNTIME_USER" -- node - "$EXECUTOR_SOCKET_PATH" <<'NODE'
const net = require('net');
const socket = net.createConnection(process.argv[2]);
let response = '';
const timer = setTimeout(() => { socket.destroy(); process.exit(2); }, 10000);
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(`${JSON.stringify({ protocolVersion: 2, requestId: require('crypto').randomUUID(), type: 'hello' })}\n`));
socket.on('data', (chunk) => { response += chunk; });
socket.on('error', () => { clearTimeout(timer); process.exit(2); });
socket.on('end', () => {
  clearTimeout(timer);
  try {
    const active = JSON.parse(response.trim()).result?.activePlan;
    process.exit(active === true ? 0 : active === false ? 1 : 2);
  } catch { process.exit(2); }
});
NODE
}

# Proceeds only when the executor positively reports no plan in flight (or --force for "could not tell").
require_executor_idle() {
  local state=0
  executor_plan_state || state=$?
  case "$state" in
    1) return 0 ;;
    0) release_maintenance; die 'the executor is running a plan right now; retry the repair when it finishes (journalctl -u homebase-executor)' ;;
    *)
      if [ "$FORCE" -eq 1 ]; then
        log 'WARNING: could not confirm the executor is idle; continuing because --force was given'
        return 0
      fi
      release_maintenance
      die 'could not confirm the executor is idle (it did not answer); check journalctl -u homebase-executor, or re-run with --force'
      ;;
  esac
}

# Repairs quiesce the executor atomically: the flag is created *before* checking for active work, and
# the executor refuses new jobs while it exists (checked in the same step that claims its lock). So no
# job can start after the check, during the copy, or before the service is stopped. Released on exit.
MAINTENANCE_FLAG="$(dirname "$EXECUTOR_SOCKET_PATH")/executor.maintenance"
MAINTENANCE_HELD=0
release_maintenance() {
  if [ "$MAINTENANCE_HELD" -eq 1 ]; then
    rm -f "$MAINTENANCE_FLAG"
    MAINTENANCE_HELD=0
  fi
}
trap release_maintenance EXIT
if { [ "$REPAIR" -eq 1 ] || [ "$REPAIR_EXECUTOR" -eq 1 ] || [ "$ADD_EXECUTOR" -eq 1 ] || [ "$SWITCH_TO_EXECUTOR" -eq 1 ]; } && [ "$TEST_MODE" != '1' ] && [ -d "$(dirname "$EXECUTOR_SOCKET_PATH")" ]; then
  install -m 0644 -o root -g root /dev/null "$MAINTENANCE_FLAG"
  MAINTENANCE_HELD=1
  require_executor_idle
  log 'executor quiesced for repair; new jobs wait until it finishes'
fi

# Supported: Ubuntu 22.04+, Debian 12+, and derivatives built on them (Linux Mint 21/22, ...), which are
# recognised by their Ubuntu or Debian base codename. Same rule as src/operations/host-support.js.
OS_ID="${HOMEBASE_OS_ID:-}"
OS_VERSION_ID="${HOMEBASE_OS_VERSION_ID:-}"
OS_ID_LIKE="${HOMEBASE_OS_ID_LIKE:-}"
OS_UBUNTU_CODENAME="${HOMEBASE_OS_UBUNTU_CODENAME:-}"
OS_DEBIAN_CODENAME="${HOMEBASE_OS_DEBIAN_CODENAME:-}"
os_release_field() {
  awk -F= -v key="$1" '$1 == key { value=substr($0, index($0, "=")+1); gsub(/^"|"$/, "", value); print value; exit }' "$2"
}
if [ -z "$OS_ID" ]; then
  OS_RELEASE_FILE="${HOMEBASE_OS_RELEASE_FILE:-/etc/os-release}"
  [ -r "$OS_RELEASE_FILE" ] || die 'supported Ubuntu or Debian host required'
  OS_ID="$(os_release_field ID "$OS_RELEASE_FILE")"
  OS_VERSION_ID="$(os_release_field VERSION_ID "$OS_RELEASE_FILE")"
  OS_ID_LIKE="$(os_release_field ID_LIKE "$OS_RELEASE_FILE")"
  OS_UBUNTU_CODENAME="$(os_release_field UBUNTU_CODENAME "$OS_RELEASE_FILE")"
  OS_DEBIAN_CODENAME="$(os_release_field DEBIAN_CODENAME "$OS_RELEASE_FILE")"
  [ -n "$OS_DEBIAN_CODENAME" ] || OS_DEBIAN_CODENAME="$(os_release_field VERSION_CODENAME "$OS_RELEASE_FILE")"
fi

OS_MAJOR="${OS_VERSION_ID%%.*}"
case "$OS_ID" in
  ubuntu|debian)
    printf '%s\n' "$OS_MAJOR" | grep -Eq '^[0-9]+$' || die "invalid operating-system version: ${OS_VERSION_ID:-unknown}"
    if [ "$OS_ID" = 'ubuntu' ]; then
      [ "$OS_MAJOR" -ge 22 ] || die 'Ubuntu 22.04 or newer is required'
    else
      [ "$OS_MAJOR" -ge 12 ] || die 'Debian 12 or newer is required'
    fi
    ;;
  *)
    case " ${OS_ID_LIKE} " in
      *' ubuntu '*)
        case "$OS_UBUNTU_CODENAME" in
          jammy|noble|oracular|plucky|questing) ;;
          *) die "unsupported ${OS_ID:-unknown} release: Ubuntu base ${OS_UBUNTU_CODENAME:-unknown} (22.04 jammy or newer required)" ;;
        esac
        ;;
      *' debian '*)
        case "$OS_DEBIAN_CODENAME" in
          bookworm|trixie) ;;
          *) die "unsupported ${OS_ID:-unknown} release: Debian base ${OS_DEBIAN_CODENAME:-unknown} (12 bookworm or newer required)" ;;
        esac
        ;;
      *) die "unsupported operating system: ${OS_ID:-unknown}" ;;
    esac
    ;;
esac

ARCHIVE_NAME="homebase-${RELEASE_VERSION#v}.tar.gz"
RELEASE_BASE="https://github.com/eforbell/homeBase/releases/download/${RELEASE_VERSION}"
ARCHIVE_URL="${HOMEBASE_ARCHIVE_URL:-${RELEASE_BASE}/${ARCHIVE_NAME}}"
CHECKSUM_URL="${HOMEBASE_CHECKSUM_URL:-${RELEASE_BASE}/${ARCHIVE_NAME}.sha256}"

if [ "$DRY_RUN" -eq 1 ]; then
  DRY_RUN_MODE='executor'
  [ "$ADD_EXECUTOR" -eq 0 ] || DRY_RUN_MODE="legacy-sudo kept; executor added beside it at ${COEXIST_EXECUTOR_DIR}"
  [ "$SWITCH_TO_EXECUTOR" -eq 0 ] || DRY_RUN_MODE='legacy-sudo switched to executor (legacy checkout moved aside, sudoers removed)'
  cat <<EOF
Home Base install plan
  OS:             ${OS_ID} ${OS_VERSION_ID}
  Version:        ${RELEASE_VERSION}
  Source:         ${SOURCE_DIR:-${ARCHIVE_URL}}
  Install dir:    ${INSTALL_DIR}
  State dir:      ${STATE_DIR}
  Environment:    ${ENV_FILE}
  Unit:           ${UNIT_FILE}
  Executor socket unit:  ${EXECUTOR_SOCKET_UNIT}
  Executor service unit: ${EXECUTOR_SERVICE_UNIT}
  Executor socket: ${EXECUTOR_SOCKET_PATH}
  Bind address:   127.0.0.1:${PORT}
  Execution mode: ${DRY_RUN_MODE}
  Privileged jobs: disabled
  Auto-bootstrap: disabled
EOF
  exit 0
fi

set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

env_value() {
  [ -f "$ENV_FILE" ] || return 0
  awk -v key="$1" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2); gsub(/^["\047]|["\047]$/, "", value); last = value } END { print last }' "$ENV_FILE"
}

# Writes the executor's socket and service units; $1 is the directory holding its code.
write_executor_units() {
  local code_dir="$1"
  if [ "$TEST_MODE" = '1' ]; then mkdir -p "$(dirname "$EXECUTOR_SOCKET_UNIT")" "$(dirname "$EXECUTOR_SERVICE_UNIT")"; fi
  cat > "$EXECUTOR_SOCKET_UNIT" <<EOF
[Unit]
Description=Home Base privileged executor socket

[Socket]
ListenStream=${EXECUTOR_SOCKET_PATH}
SocketUser=root
SocketGroup=${EXECUTOR_GROUP}
SocketMode=0660
RemoveOnStop=true

[Install]
WantedBy=sockets.target
EOF

  cat > "$EXECUTOR_SERVICE_UNIT" <<EOF
[Unit]
Description=Home Base privileged executor
Requires=homebase-executor.socket
After=local-fs.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${code_dir}/executor/server.js
User=root
Group=root
UMask=0022
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictRealtime=true
LockPersonality=true
EOF
  if [ "$TEST_MODE" != '1' ]; then
    chown root:root "$EXECUTOR_SOCKET_UNIT" "$EXECUTOR_SERVICE_UNIT"
    chmod 0644 "$EXECUTOR_SOCKET_UNIT" "$EXECUTOR_SERVICE_UNIT"
  fi
}

# Proves the runtime user reaches a mutation-enabled protocol v2 executor through the socket.
probe_executor() {
  runuser -u "$RUNTIME_USER" -- "$NODE_BIN" - "$EXECUTOR_SOCKET_PATH" <<'NODE'
const net = require('net');
const socketPath = process.argv[2];
const request = { protocolVersion: 2, requestId: require('crypto').randomUUID(), type: 'hello' };
const socket = net.createConnection(socketPath);
let response = '';
const timer = setTimeout(() => { socket.destroy(); process.exit(1); }, 5000);
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
socket.on('data', (chunk) => { response += chunk; });
socket.on('error', () => { clearTimeout(timer); process.exit(1); });
socket.on('end', () => {
  clearTimeout(timer);
  try {
    const payload = JSON.parse(response.trim());
    process.exit(payload.protocolVersion === 2 && payload.ok === true && payload.result?.capabilities?.mutationsEnabled === true ? 0 : 1);
  } catch { process.exit(1); }
});
NODE
}

# Installs the git key root-only; only the executor reads it.
install_git_deploy_key() {
  if [ "$TEST_MODE" = '1' ]; then
    mkdir -p "$GIT_DEPLOY_KEY_DIR"
    cp "$GIT_SSH_KEY_SOURCE" "$GIT_DEPLOY_KEY_PATH"
    chmod 0600 "$GIT_DEPLOY_KEY_PATH"
  else
    install -d -m 0700 -o root -g root "$GIT_DEPLOY_KEY_DIR"
    install -m 0600 -o root -g root "$GIT_SSH_KEY_SOURCE" "$GIT_DEPLOY_KEY_PATH"
  fi
}

# The legacy web's state database, as its env file configures it (config.js falls back to the checkout's
# .data directory, which the switch moves aside, so that case is refused rather than guessed).
resolve_state_db() {
  [ -z "$STATE_DB" ] || return 0
  STATE_DB="$(env_value HOME_BASE_STATE_DB)"
  if [ -z "$STATE_DB" ]; then
    local data_dir
    data_dir="$(env_value HOME_BASE_DATA_DIR)"
    [ -z "$data_dir" ] || STATE_DB="${data_dir%/}/home-base.sqlite3"
  fi
  [ -n "$STATE_DB" ]
}

# Counts rows in the legacy state database; prints nothing when it cannot be read.
state_query() {
  python3 - "$STATE_DB" "$1" <<'PY' 2>/dev/null
import sqlite3, sys
conn = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
columns = {row[1] for row in conn.execute("PRAGMA table_info(installations)")}
managed = "COALESCE(managed_by, '')" if "managed_by" in columns else "''"
if sys.argv[2] == "unadopted":
    # Installed but not adopted, or with an adopt that never finished (whatever its status says).
    rows = conn.execute(f"SELECT app_id FROM installations WHERE (status = 'installed' AND {managed} != 'executor') OR {managed} = 'adopting' ORDER BY app_id").fetchall()
else:
    rows = conn.execute("SELECT id || ':' || kind || ':' || target FROM jobs WHERE status IN ('queued', 'running') AND dry_run = 0 ORDER BY id").fetchall()
print(" ".join(str(row[0]) for row in rows))
PY
}

# The two legacy-host modes run only on legacy-sudo hosts; every other mode refuses a legacy host. A
# switch that stopped partway (env already says executor, sudoers and the coexistence copy still there)
# is resumed rather than stranded.
SWITCH_RESUMING=0
if [ "$ADD_EXECUTOR" -eq 1 ]; then
  [ "$(env_value HOME_BASE_EXECUTION_MODE)" = 'legacy-sudo' ] \
    || die "--add-executor is for legacy-sudo hosts; ${ENV_FILE} does not set HOME_BASE_EXECUTION_MODE=legacy-sudo"
  if resolve_state_db; then
    RUNNING_JOBS="$(state_query jobs)" || { RUNNING_JOBS=''; log "WARNING: could not read ${STATE_DB}; not checking for running legacy jobs"; }
    if [ -n "$RUNNING_JOBS" ] && [ "$FORCE" -ne 1 ]; then
      die "legacy jobs are in progress (${RUNNING_JOBS}); adding the executor restarts the web service and would cut them off. Retry when they finish, or pass --force"
    fi
  else
    log "WARNING: ${ENV_FILE} sets neither HOME_BASE_STATE_DB nor HOME_BASE_DATA_DIR; not checking for running legacy jobs"
  fi
fi
if [ "$SWITCH_TO_EXECUTOR" -eq 1 ]; then
  MODE_NOW="$(env_value HOME_BASE_EXECUTION_MODE)"
  if [ "$MODE_NOW" = 'executor' ] && [ -e "$LEGACY_SUDOERS_FILE" ] && [ -f "${COEXIST_EXECUTOR_DIR}/executor/server.js" ]; then
    SWITCH_RESUMING=1
    log 'resuming a --switch-to-executor that stopped partway'
  elif [ "$MODE_NOW" != 'legacy-sudo' ]; then
    die "--switch-to-executor is for legacy-sudo hosts; ${ENV_FILE} does not set HOME_BASE_EXECUTION_MODE=legacy-sudo"
  fi
  [ -f "${COEXIST_EXECUTOR_DIR}/executor/server.js" ] \
    || die "--switch-to-executor needs the executor added first (install.sh --add-executor) and every app adopted"
  resolve_state_db \
    || die "${ENV_FILE} sets neither HOME_BASE_STATE_DB nor HOME_BASE_DATA_DIR, so the legacy web keeps its state inside its checkout, which the switch moves aside. Move the database under ${STATE_DIR}, set HOME_BASE_STATE_DB, restart Home Base, then retry"
  # The hardened unit can write only STATE_DIR.
  case "$STATE_DB" in
    "${STATE_DIR}"/*) ;;
    *) die "the Home Base state database ${STATE_DB} is outside ${STATE_DIR}, the only directory the hardened service may write; move it there and set HOME_BASE_STATE_DB first" ;;
  esac
  printf '%s\n' "$STATE_DB" | grep -Eq '^[A-Za-z0-9/._-]+$' || die "the state database path may only contain letters, digits, '/', '.', '_', and '-': ${STATE_DB}"
  [ -f "$STATE_DB" ] || die "could not find the Home Base state database at ${STATE_DB}"
  # Every installed app must already be executor-managed: after the switch nothing runs legacy plans.
  UNADOPTED="$(state_query unadopted)" || die "could not read Home Base state at ${STATE_DB}"
  [ -z "$UNADOPTED" ] || die "these installed apps are not adopted yet; adopt (or uninstall) them first: ${UNADOPTED}"
fi
if [ -e "$LEGACY_SUDOERS_FILE" ] && [ "$ADD_EXECUTOR" -eq 0 ] && [ "$SWITCH_TO_EXECUTOR" -eq 0 ]; then
  die "existing Home Base sudoers policy detected at ${LEGACY_SUDOERS_FILE}; inspect and remove it before installing the hardened service (legacy hosts: install.sh --add-executor, adopt every app, then install.sh --switch-to-executor)"
fi
if [ -f "$ENV_FILE" ] && [ "$ADD_EXECUTOR" -eq 0 ] && [ "$SWITCH_TO_EXECUTOR" -eq 0 ]; then
  UNSAFE_ENV_SETTING=''
  if ! UNSAFE_ENV_SETTING="$(validate_preserved_env "$ENV_FILE")"; then
    die "existing environment enables unsafe or unknown execution settings (${UNSAFE_ENV_SETTING:-unknown}): $ENV_FILE"
  fi
fi

if [ "$TEST_MODE" != '1' ]; then
  export DEBIAN_FRONTEND=noninteractive
  # Only what is missing: NodeSource's nodejs already bundles npm (apt's npm package conflicts with it),
  # and an existing Node 18+ from any source is kept.
  MISSING_PACKAGES=''
  for package in ca-certificates curl tar python3 ${SOURCE_DIR:+git}; do
    dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null | grep -q '^ii' || MISSING_PACKAGES="$MISSING_PACKAGES $package"
  done
  command -v node >/dev/null 2>&1 || MISSING_PACKAGES="$MISSING_PACKAGES nodejs"
  command -v npm >/dev/null 2>&1 || MISSING_PACKAGES="$MISSING_PACKAGES npm"
  if [ -n "$MISSING_PACKAGES" ]; then
    log "installing runtime prerequisites:${MISSING_PACKAGES}"
    apt-get update
    # shellcheck disable=SC2086
    apt-get install -y --no-install-recommends $MISSING_PACKAGES
  else
    log 'runtime prerequisites already installed'
  fi
fi

for command in curl tar python3 node npm ${SOURCE_DIR:+git}; do
  command -v "$command" >/dev/null 2>&1 || die "required command unavailable: $command"
done
NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 or newer is required; found $(node --version)"
NODE_BIN="$(command -v node)"
if [ "$TEST_MODE" != '1' ]; then
  # The root executor's unit runs this binary: nothing but root may be able to replace it or anything on
  # the way to it. A symlink's own mode is meaningless; its directory and its target's chain are checked.
  NODE_REAL="$(readlink -f "$NODE_BIN")"
  NODE_CHAIN="$(dirname "$NODE_BIN")"
  candidate="$NODE_REAL"
  while :; do
    NODE_CHAIN="$NODE_CHAIN $candidate"
    [ "$candidate" = '/' ] && break
    candidate="$(dirname "$candidate")"
  done
  for candidate in $NODE_CHAIN; do
    if [ "$(stat -c '%u' "$candidate")" != 0 ] || [ $((0$(stat -c '%a' "$candidate") & 022)) -ne 0 ]; then
      die "${candidate} must be owned by root and not group- or world-writable; the root executor runs ${NODE_BIN}"
    fi
  done
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
  release_maintenance
}
trap cleanup EXIT

ARCHIVE_PATH="${TMP_DIR}/${ARCHIVE_NAME}"
CHECKSUM_PATH="${ARCHIVE_PATH}.sha256"
if [ -n "$SOURCE_DIR" ]; then
  git -c safe.directory="$SOURCE_DIR" -C "$SOURCE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "--source-dir is not a Git working tree: $SOURCE_DIR"
  [ -z "$(git -c safe.directory="$SOURCE_DIR" -C "$SOURCE_DIR" status --porcelain)" ] \
    || die "--source-dir must have a clean Git working tree: $SOURCE_DIR"
  SOURCE_COMMIT="$(git -c safe.directory="$SOURCE_DIR" -C "$SOURCE_DIR" rev-parse --verify HEAD^{commit})" \
    || die "--source-dir does not have a checked-out commit: $SOURCE_DIR"
  log "packaging Home Base ${RELEASE_VERSION} from local commit ${SOURCE_COMMIT}"
  git -c safe.directory="$SOURCE_DIR" -C "$SOURCE_DIR" archive --format=tar.gz --prefix="homebase-${RELEASE_VERSION#v}/" "$SOURCE_COMMIT" > "$ARCHIVE_PATH"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$ARCHIVE_PATH" > "$CHECKSUM_PATH"
  else
    shasum -a 256 "$ARCHIVE_PATH" > "$CHECKSUM_PATH"
  fi
else
  log "downloading Home Base ${RELEASE_VERSION}"
  CURL_PROTOCOLS='=https'
  if [ "$TEST_MODE" = '1' ] || [ "${HOMEBASE_TEST_ALLOW_FILE_URLS:-0}" = '1' ]; then
    CURL_PROTOCOLS='=https,file'
  fi
  curl --fail --silent --show-error --location --proto "$CURL_PROTOCOLS" "$ARCHIVE_URL" --output "$ARCHIVE_PATH" \
    || die "could not download Home Base ${RELEASE_VERSION} (${ARCHIVE_URL}). If no release is published yet, clone the repository as root and pass --source-dir, e.g.: sudo git clone --branch main git@github.com:eforbell/homeBase.git /root/homebase-src && sudo bash /root/homebase-src/install.sh --source-dir /root/homebase-src ..."
  curl --fail --silent --show-error --location --proto "$CURL_PROTOCOLS" "$CHECKSUM_URL" --output "$CHECKSUM_PATH" \
    || die "could not download the checksum for Home Base ${RELEASE_VERSION} (${CHECKSUM_URL})"
fi

EXPECTED_SHA256="$(awk 'NF { print $1; exit }' "$CHECKSUM_PATH")"
printf '%s\n' "$EXPECTED_SHA256" | grep -Eq '^[0-9a-fA-F]{64}$' \
  || die 'checksum file does not contain a 64-character SHA-256 digest'

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
else
  ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
fi
[ "$(printf '%s' "$ACTUAL_SHA256" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$EXPECTED_SHA256" | tr '[:upper:]' '[:lower:]')" ] \
  || die 'release archive checksum verification failed'

python3 - "$ARCHIVE_PATH" <<'PY'
import pathlib
import sys
import tarfile

archive = sys.argv[1]
with tarfile.open(archive, 'r:gz') as handle:
    members = handle.getmembers()
    if not members:
        raise SystemExit('release archive is empty')
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or '\n' in member.name or '\r' in member.name:
            raise SystemExit(f'unsafe archive path: {member.name}')
        if member.isdev() or member.issym() or member.islnk():
            raise SystemExit(f'unsupported archive entry: {member.name}')
PY

EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"
SOURCE_DIR="$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[ -n "$SOURCE_DIR" ] || die 'release archive must contain one top-level directory'
[ "$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 1 ] \
  || die 'release archive must contain exactly one top-level directory'
[ -f "$SOURCE_DIR/package.json" ] && [ -f "$SOURCE_DIR/package-lock.json" ] && [ -f "$SOURCE_DIR/server.js" ] && [ -d "$SOURCE_DIR/src" ] && [ -f "$SOURCE_DIR/executor/server.js" ] \
  || die 'release archive is missing required Home Base files'

if [ "$ADD_EXECUTOR" -eq 1 ]; then
  log "adding the typed executor next to the legacy service; its code goes to ${COEXIST_EXECUTOR_DIR} (root-owned)"
  STAGE_DIR="${COEXIST_EXECUTOR_DIR}.new"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  cp -R "$SOURCE_DIR"/. "$STAGE_DIR"/
  if [ "$TEST_MODE" != '1' ]; then
    (cd "$STAGE_DIR" && npm ci --omit=dev --ignore-scripts)
    chown -R root:root "$STAGE_DIR"
    chmod -R go-w "$STAGE_DIR"
    chmod 0755 "$STAGE_DIR"
  fi
  rm -rf "${COEXIST_EXECUTOR_DIR}.old"
  if [ -d "$COEXIST_EXECUTOR_DIR" ]; then mv "$COEXIST_EXECUTOR_DIR" "${COEXIST_EXECUTOR_DIR}.old"; fi
  mv "$STAGE_DIR" "$COEXIST_EXECUTOR_DIR"
  rm -rf "${COEXIST_EXECUTOR_DIR}.old"
  if [ "$TEST_MODE" != '1' ]; then
    getent group "$EXECUTOR_GROUP" >/dev/null 2>&1 || groupadd --system "$EXECUTOR_GROUP"
    usermod -a -G "$EXECUTOR_GROUP" "$RUNTIME_USER"
  fi
  if [ -n "$GIT_SSH_KEY_SOURCE" ]; then
    install_git_deploy_key
    # Only the executor fetches with the root-only key; HOME_BASE_GIT_TRANSPORT keeps serving legacy apps.
    set_env_value HOME_BASE_EXECUTOR_GIT_TRANSPORT ssh
    log "installed the executor git key at ${GIT_DEPLOY_KEY_PATH} (root-only); legacy git settings unchanged"
  fi
  set_env_value HOME_BASE_EXECUTOR_SOCKET "$EXECUTOR_SOCKET_PATH"
  write_executor_units "$COEXIST_EXECUTOR_DIR"
  mkdir -p "$(dirname "$COEXIST_MARKER")"
  printf 'Written by install.sh --add-executor; removed by --switch-to-executor. While it exists the executor accepts adopt.\n' > "$COEXIST_MARKER"
  if [ "$TEST_MODE" != '1' ]; then chown root:root "$COEXIST_MARKER"; chmod 0644 "$COEXIST_MARKER"; fi
  if [ "$TEST_MODE" != '1' ] && [ "$NO_START" -eq 0 ]; then
    systemctl daemon-reload
    systemctl enable homebase-executor.socket
    require_executor_idle
    systemctl stop homebase-executor.service 2>/dev/null || true
    systemctl restart homebase-executor.socket
    systemctl is-active --quiet homebase-executor.socket \
      || die 'homebase-executor.socket did not become active; inspect journalctl -u homebase-executor.socket'
    [ "$(stat -c '%U:%G %a' "$EXECUTOR_SOCKET_PATH")" = "root:${EXECUTOR_GROUP} 660" ] \
      || die "executor socket has unexpected owner or mode: $EXECUTOR_SOCKET_PATH"
    probe_executor || die 'executor hello/capability probe failed; inspect journalctl -u homebase-executor'
    # The web service picks up its new socket group only when it restarts; wait until it answers again.
    if systemctl try-restart homebase.service; then
      WEB_PORT="$(env_value PORT)"
      WEB_HEALTHY=0
      for _attempt in $(seq 1 30); do
        if curl --fail --silent "http://127.0.0.1:${WEB_PORT:-$PORT}/api/homebase/health" >/dev/null; then WEB_HEALTHY=1; break; fi
        sleep 1
      done
      [ "$WEB_HEALTHY" -eq 1 ] || log 'WARNING: Home Base did not answer its health check within 30s after the restart; inspect journalctl -u homebase'
    else
      log 'homebase.service did not restart; inspect journalctl -u homebase'
    fi
  fi
  log 'executor added; this host stays in legacy-sudo mode'
  log 'Next: 1) add "include /etc/nginx/sovereign-home.d/*.conf;" beside "include /etc/nginx/snippets/*.conf;" in your nginx server block, then: sudo nginx -t && sudo systemctl reload nginx'
  log '      2) adopt each app from its Home Base page (preview first)'
  log '      3) when every app is adopted: sudo bash install.sh --switch-to-executor'
  exit 0
fi

VERSION_MARKER="${INSTALL_DIR}/.homebase-version"
if [ "$SWITCH_TO_EXECUTOR" -eq 1 ]; then
  # Parent root-owned before anything moves, so nobody can plant a symlink where the managed install goes.
  if [ "$TEST_MODE" != '1' ]; then install -d -m 0755 -o root -g root "$(dirname "$INSTALL_DIR")"; fi
  [ ! -L "$INSTALL_DIR" ] || die "${INSTALL_DIR} is a symlink; refusing to install through it"
  # Everything a manual rollback needs, root-only: the env file and the legacy unit. A resumed switch keeps
  # the first backup, which is the only one that still holds the pre-switch state.
  SWITCH_BACKUP="$(find "$(dirname "$ENV_FILE")" -maxdepth 1 -type d -name 'switch-backup-*' 2>/dev/null | sort | head -1)"
  if [ "$SWITCH_RESUMING" -eq 0 ] || [ -z "$SWITCH_BACKUP" ]; then
    SWITCH_BACKUP="$(dirname "$ENV_FILE")/switch-backup-$(date +%Y%m%d%H%M%S)"
    mkdir -p "$SWITCH_BACKUP" && chmod 0700 "$SWITCH_BACKUP"
    cp -p "$ENV_FILE" "$SWITCH_BACKUP/"
    if [ -f "$UNIT_FILE" ]; then cp -p "$UNIT_FILE" "$SWITCH_BACKUP/"; fi
  fi
  log "the pre-switch env file and web unit are in ${SWITCH_BACKUP} for a manual rollback"
fi
if [ "$SWITCH_TO_EXECUTOR" -eq 1 ] && [ -e "$INSTALL_DIR" ] && [ ! -f "$VERSION_MARKER" ]; then
  # The legacy web checkout (owned by the runtime user) is kept aside, not deleted.
  LEGACY_ASIDE="${INSTALL_DIR}.legacy-$(date +%Y%m%d%H%M%S)"
  log "moving the legacy web checkout aside to ${LEGACY_ASIDE}"
  if [ "$TEST_MODE" != '1' ]; then systemctl stop homebase.service 2>/dev/null || true; fi
  mv "$INSTALL_DIR" "$LEGACY_ASIDE"
fi
if [ -e "$INSTALL_DIR" ] && [ ! -f "$VERSION_MARKER" ]; then
  die "existing install directory is not managed by this installer: $INSTALL_DIR"
fi
if [ -f "$VERSION_MARKER" ]; then
  INSTALLED_VERSION="$(cat "$VERSION_MARKER")"
  [ "$INSTALLED_VERSION" = "$RELEASE_VERSION" ] \
    || die "Home Base ${INSTALLED_VERSION} is already installed; upgrades are not implemented by this installer yet"
  if [ "$REPAIR" -eq 1 ]; then
    log "repairing managed Home Base code while preserving config and state"
    cp -a "$SOURCE_DIR"/. "$INSTALL_DIR"/
  elif [ "$REPAIR_EXECUTOR" -eq 1 ]; then
    # The executor loads shared, trusted modules from src/ and schemas/; refreshing executor/ alone
    # would run new executor code against old policy and compilers.
    log "repairing executor code and the shared modules it loads while preserving config and state"
    for component in executor src schemas; do
      mkdir -p "$INSTALL_DIR/$component"
      cp -a "$SOURCE_DIR/$component"/. "$INSTALL_DIR/$component"/
    done
    cp -a "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$INSTALL_DIR"/
  else
    log "Home Base ${RELEASE_VERSION} is already installed; preserving code, config, and state"
  fi
else
  [ "$REPAIR_EXECUTOR" -eq 0 ] || die '--repair-executor requires an existing managed Home Base installation'
  if [ "$TEST_MODE" = '1' ]; then
    mkdir -p "$INSTALL_DIR"
    cp -R "$SOURCE_DIR"/. "$INSTALL_DIR"/
  else
    install -d -m 0755 -o root -g root "$(dirname "$INSTALL_DIR")"
    install -d -m 0755 -o root -g root "$INSTALL_DIR"
    cp -a "$SOURCE_DIR"/. "$INSTALL_DIR"/
  fi
  printf '%s\n' "$RELEASE_VERSION" > "$VERSION_MARKER"
fi
if [ "$TEST_MODE" != '1' ]; then
  (cd "$INSTALL_DIR" && npm ci --omit=dev --ignore-scripts)
  chown -R root:root "$INSTALL_DIR"
  chmod -R go-w "$INSTALL_DIR"
fi

if [ "$TEST_MODE" = '1' ]; then
  mkdir -p "$(dirname "$EXECUTOR_SOCKET_UNIT")" "$(dirname "$EXECUTOR_SERVICE_UNIT")"
  if [ "$REPAIR_EXECUTOR" -eq 0 ]; then
    mkdir -p "$STATE_DIR" "$(dirname "$ENV_FILE")" "$(dirname "$UNIT_FILE")"
  fi
else
  if ! getent group "$EXECUTOR_GROUP" >/dev/null 2>&1; then
    groupadd --system "$EXECUTOR_GROUP"
  fi
  if ! id -u "$RUNTIME_USER" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$RUNTIME_USER"
  fi
  usermod -a -G "$EXECUTOR_GROUP" "$RUNTIME_USER"
  if [ "$REPAIR_EXECUTOR" -eq 0 ]; then
    install -d -m 0700 -o "$RUNTIME_USER" -g "$RUNTIME_USER" "$STATE_DIR"
    install -d -m 0755 -o root -g root "$(dirname "$ENV_FILE")"
  fi
fi

if [ "$REPAIR_EXECUTOR" -eq 0 ] && [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
PORT=${PORT}
HOME_BASE_BIND_HOST=127.0.0.1
HOME_BASE_DATA_DIR=${STATE_DIR}
HOME_BASE_STATE_DB=${STATE_DIR}/home-base.sqlite3
HOME_BASE_RUNTIME_USER=${RUNTIME_USER}
HOME_BASE_APP_DIR=${INSTALL_DIR}
HOME_BASE_RUNTIME_STATE_DIR=${STATE_DIR}
HOME_BASE_ENV_FILE=${ENV_FILE}
HOME_BASE_INSTALL_DIR=/opt/sovereign-home/apps
HOME_BASE_SHARED_ROOT=/opt/sovereign-home
HOME_BASE_ASSETS_ROOT=/opt/sovereign-home/assets
HOME_BASE_BACKUP_DIR=/var/lib/sovereign-home/backups
HOME_BASE_CONFIG_DIR=/etc/sovereign-home
HOME_BASE_GIT_TRANSPORT=https
HOME_BASE_EXECUTION_MODE=executor
HOME_BASE_ENABLE_PRIVILEGED_JOBS=1
HOME_BASE_AUTO_BOOTSTRAP=0
HOME_BASE_EXECUTOR_SOCKET=${EXECUTOR_SOCKET_PATH}
EOF
  if [ "$TEST_MODE" != '1' ]; then
    chown root:"$RUNTIME_USER" "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
  fi
elif [ "$REPAIR_EXECUTOR" -eq 0 ]; then
  log "preserving existing environment file: $ENV_FILE"
fi

if [ "$SWITCH_TO_EXECUTOR" -eq 1 ]; then
  # Executor mode never auto-runs host plans; the legacy auto-bootstrap setting goes with the sudo policy.
  set_env_value HOME_BASE_AUTO_BOOTSTRAP 0
  if [ "$TEST_MODE" != '1' ]; then
    # The web must not be able to rewrite its own mode (root-owned, readable by the runtime user only).
    chown root:"$RUNTIME_USER" "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
    # Before the web restarts: a process keeps the groups it started with.
    if id -nG "$RUNTIME_USER" 2>/dev/null | tr ' ' '\n' | grep -qx sovereign; then
      gpasswd -d "$RUNTIME_USER" sovereign >/dev/null || die "could not remove ${RUNTIME_USER} from the sovereign group"
    fi
  fi
fi
if { [ "$REPAIR" -eq 1 ] || [ "$SWITCH_TO_EXECUTOR" -eq 1 ]; } && [ -f "$ENV_FILE" ]; then
  # These keys define the executor-mode boundary; repair restores them if they drifted.
  set_env_value HOME_BASE_EXECUTION_MODE executor
  set_env_value HOME_BASE_ENABLE_PRIVILEGED_JOBS 1
  set_env_value HOME_BASE_EXECUTOR_SOCKET "$EXECUTOR_SOCKET_PATH"
  set_env_value HOME_BASE_BIND_HOST 127.0.0.1
  log "restored executor-mode settings in $ENV_FILE (other settings preserved)"
fi

if [ -n "$GIT_SSH_KEY_SOURCE" ]; then
  [ -f "$ENV_FILE" ] || die "--git-ssh-key requires an existing environment file: $ENV_FILE"
  install_git_deploy_key
  set_env_value HOME_BASE_GIT_TRANSPORT ssh-key
  set_env_value HOME_BASE_GIT_SSH_KEY_PATH "$GIT_DEPLOY_KEY_PATH"
  log "installed git deploy key at ${GIT_DEPLOY_KEY_PATH} (root-only); Home Base will clone app repositories over SSH"
fi

if [ "$REPAIR_EXECUTOR" -eq 0 ]; then
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Home Base Control Plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUNTIME_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} server.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=${STATE_DIR}

[Install]
WantedBy=multi-user.target
EOF
fi

write_executor_units "$INSTALL_DIR"

if [ "$TEST_MODE" != '1' ]; then
  if [ "$REPAIR_EXECUTOR" -eq 0 ]; then
    chown root:root "$UNIT_FILE"
    chmod 0644 "$UNIT_FILE"
  fi
  systemctl daemon-reload
  systemctl enable homebase-executor.socket
  if [ "$REPAIR_EXECUTOR" -eq 0 ]; then
    systemctl enable homebase.service
  fi
  if [ "$NO_START" -eq 0 ]; then
    if [ "$REPAIR" -eq 1 ] || [ "$REPAIR_EXECUTOR" -eq 1 ]; then
      # Code was refreshed: stop the running executor so the next connection loads it, but never
      # interrupt a plan in flight (a half-finished restore or uninstall is worse than stale code).
      # Defense in depth: the maintenance flag already prevents new plans, so this should never fire.
      require_executor_idle
      systemctl stop homebase-executor.service 2>/dev/null || true
    fi
    systemctl restart homebase-executor.socket
    systemctl is-active --quiet homebase-executor.socket \
      || die 'homebase-executor.socket did not become active; inspect journalctl -u homebase-executor.socket'
    [ "$(stat -c '%U:%G %a' "$EXECUTOR_SOCKET_PATH")" = "root:${EXECUTOR_GROUP} 660" ] \
      || die "executor socket has unexpected owner or mode: $EXECUTOR_SOCKET_PATH"
    probe_executor || die 'executor hello/capability probe failed; inspect journalctl -u homebase-executor'
    if [ "$REPAIR_EXECUTOR" -eq 1 ] && [ -z "$GIT_SSH_KEY_SOURCE" ]; then
      # Keep web and executor on the same shared code; an unhealthy web service is not a blocker here.
      systemctl try-restart homebase.service || log 'homebase.service did not restart; inspect journalctl -u homebase'
    fi
    if [ "$REPAIR_EXECUTOR" -eq 0 ] || [ -n "$GIT_SSH_KEY_SOURCE" ]; then
      systemctl restart homebase.service
      # The service listens where its env file says (a preserved legacy env may not use the default).
      SERVICE_PORT="$(env_value PORT)"
      SERVICE_PORT="${SERVICE_PORT:-$PORT}"
      HEALTHY=0
      for _attempt in $(seq 1 30); do
        if curl --fail --silent "http://127.0.0.1:${SERVICE_PORT}/api/homebase/health" >/dev/null; then
          HEALTHY=1
          break
        fi
        sleep 1
      done
      systemctl is-active --quiet homebase.service \
        || die 'homebase.service did not become active; inspect journalctl -u homebase'
      [ "$HEALTHY" -eq 1 ] \
        || die "homebase.service is active but its loopback health endpoint did not respond on port ${SERVICE_PORT}"
    fi
  fi
fi

if [ "$SWITCH_TO_EXECUTOR" -eq 1 ]; then
  # Only now that the hardened service answers: the legacy sudo policy, adopt, and the coexistence copy go.
  rm -f "$LEGACY_SUDOERS_FILE" "$COEXIST_MARKER"
  rm -rf "$COEXIST_EXECUTOR_DIR"
  # Only broad grants matter: distributions add fixed-command rules for every user (Linux Mint's
  # /etc/sudoers.d/mintupdate), and the hardened unit's NoNewPrivileges keeps the service from sudo anyway.
  if [ "$TEST_MODE" != '1' ] && sudo -n -l -U "$RUNTIME_USER" 2>/dev/null | grep -Eq '\)[[:space:]]*(NOPASSWD:[[:space:]]*)?ALL[[:space:]]*$'; then
    log "WARNING: ${RUNTIME_USER} can still run any command through sudo (another sudoers file or group); remove that rule: sudo -l -U ${RUNTIME_USER}"
  fi
  log "switched to executor mode: removed ${LEGACY_SUDOERS_FILE} and ${COEXIST_EXECUTOR_DIR}; the legacy web checkout is kept at ${LEGACY_ASIDE:-its old path}; rollback copies in ${SWITCH_BACKUP}"
  log 'Consider deleting any app-readable copy of the git key now that only the executor needs it.'
fi

log "Home Base ${RELEASE_VERSION} installed with an unprivileged executor-mode web service and typed executor"
log "Open locally: http://127.0.0.1:${PORT}/"
log 'Inspect status: systemctl status homebase'
log 'Inspect logs:   journalctl -u homebase --no-pager'
log 'Next: open Home Base, review the generated host plan, and run approved changes from an operator shell.'
