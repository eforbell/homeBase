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
printf '%s\n' "$RELEASE_VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  || die "version must be a tag such as v0.1.0"
printf '%s\n' "$RUNTIME_USER" | grep -Eq '^[a-z_][a-z0-9_-]*$' \
  || die 'runtime user must be a valid system account name'
case "$PORT" in
  ''|*[!0-9]*) die 'port must be an integer' ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die 'port must be between 1 and 65535'

if [ -n "$SOURCE_DIR" ]; then
  case "$SOURCE_DIR" in
    /*) ;;
    *) die '--source-dir must be an absolute path' ;;
  esac
  [ -d "$SOURCE_DIR" ] || die "--source-dir does not exist or is not a directory: $SOURCE_DIR"
fi

for candidate in "$INSTALL_DIR" "$STATE_DIR" "$ENV_FILE" "$UNIT_FILE" "$LEGACY_SUDOERS_FILE" "$EXECUTOR_SOCKET_UNIT" "$EXECUTOR_SERVICE_UNIT" "$EXECUTOR_SOCKET_PATH"; do
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
if { [ "$REPAIR" -eq 1 ] || [ "$REPAIR_EXECUTOR" -eq 1 ]; } && [ "$TEST_MODE" != '1' ] && [ -d "$(dirname "$EXECUTOR_SOCKET_PATH")" ]; then
  install -m 0644 -o root -g root /dev/null "$MAINTENANCE_FLAG"
  MAINTENANCE_HELD=1
  require_executor_idle
  log 'executor quiesced for repair; new jobs wait until it finishes'
fi

OS_ID="${HOMEBASE_OS_ID:-}"
OS_VERSION_ID="${HOMEBASE_OS_VERSION_ID:-}"
if [ -z "$OS_ID" ]; then
  OS_RELEASE_FILE="${HOMEBASE_OS_RELEASE_FILE:-/etc/os-release}"
  [ -r "$OS_RELEASE_FILE" ] || die 'supported Ubuntu or Debian host required'
  OS_ID="$(awk -F= '$1 == "ID" { value=substr($0, index($0, "=")+1); gsub(/^"|"$/, "", value); print value; exit }' "$OS_RELEASE_FILE")"
  OS_VERSION_ID="$(awk -F= '$1 == "VERSION_ID" { value=substr($0, index($0, "=")+1); gsub(/^"|"$/, "", value); print value; exit }' "$OS_RELEASE_FILE")"
fi

OS_MAJOR="${OS_VERSION_ID%%.*}"
printf '%s\n' "$OS_MAJOR" | grep -Eq '^[0-9]+$' || die "invalid operating-system version: ${OS_VERSION_ID:-unknown}"
case "$OS_ID" in
  ubuntu)
    [ "${OS_MAJOR:-0}" -ge 24 ] || die 'Ubuntu 24.04 or newer is required'
    ;;
  debian)
    [ "${OS_MAJOR:-0}" -ge 12 ] || die 'Debian 12 or newer is required'
    ;;
  *)
    die "unsupported operating system: ${OS_ID:-unknown}"
    ;;
esac

ARCHIVE_NAME="homebase-${RELEASE_VERSION#v}.tar.gz"
RELEASE_BASE="https://github.com/eforbell/homeBase/releases/download/${RELEASE_VERSION}"
ARCHIVE_URL="${HOMEBASE_ARCHIVE_URL:-${RELEASE_BASE}/${ARCHIVE_NAME}}"
CHECKSUM_URL="${HOMEBASE_CHECKSUM_URL:-${RELEASE_BASE}/${ARCHIVE_NAME}.sha256}"

if [ "$DRY_RUN" -eq 1 ]; then
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
  Execution mode: executor
  Privileged jobs: disabled
  Auto-bootstrap: disabled
EOF
  exit 0
fi

if [ -e "$LEGACY_SUDOERS_FILE" ]; then
  die "existing Home Base sudoers policy detected at ${LEGACY_SUDOERS_FILE}; inspect and remove it before installing the hardened service"
fi
if [ -f "$ENV_FILE" ]; then
  UNSAFE_ENV_SETTING=''
  if ! UNSAFE_ENV_SETTING="$(validate_preserved_env "$ENV_FILE")"; then
    die "existing environment enables unsafe or unknown execution settings (${UNSAFE_ENV_SETTING:-unknown}): $ENV_FILE"
  fi
fi

if [ "$TEST_MODE" != '1' ]; then
  export DEBIAN_FRONTEND=noninteractive
  log 'installing runtime prerequisites'
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl tar python3 nodejs npm ${SOURCE_DIR:+git}
fi

for command in curl tar python3 node npm ${SOURCE_DIR:+git}; do
  command -v "$command" >/dev/null 2>&1 || die "required command unavailable: $command"
done
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 or newer is required; found $(node --version)"
NODE_BIN="$(command -v node)"

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
  curl --fail --silent --show-error --location --proto "$CURL_PROTOCOLS" "$ARCHIVE_URL" --output "$ARCHIVE_PATH"
  curl --fail --silent --show-error --location --proto "$CURL_PROTOCOLS" "$CHECKSUM_URL" --output "$CHECKSUM_PATH"
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

VERSION_MARKER="${INSTALL_DIR}/.homebase-version"
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

set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

if [ "$REPAIR" -eq 1 ] && [ -f "$ENV_FILE" ]; then
  # These keys define the executor-mode boundary; repair restores them if they drifted.
  set_env_value HOME_BASE_EXECUTION_MODE executor
  set_env_value HOME_BASE_ENABLE_PRIVILEGED_JOBS 1
  set_env_value HOME_BASE_EXECUTOR_SOCKET "$EXECUTOR_SOCKET_PATH"
  set_env_value HOME_BASE_BIND_HOST 127.0.0.1
  log "restored executor-mode settings in $ENV_FILE (other settings preserved)"
fi

if [ -n "$GIT_SSH_KEY_SOURCE" ]; then
  [ -f "$ENV_FILE" ] || die "--git-ssh-key requires an existing environment file: $ENV_FILE"
  if [ "$TEST_MODE" = '1' ]; then
    mkdir -p "$GIT_DEPLOY_KEY_DIR"
    cp "$GIT_SSH_KEY_SOURCE" "$GIT_DEPLOY_KEY_PATH"
    chmod 0600 "$GIT_DEPLOY_KEY_PATH"
  else
    install -d -m 0700 -o root -g root "$GIT_DEPLOY_KEY_DIR"
    install -m 0600 -o root -g root "$GIT_SSH_KEY_SOURCE" "$GIT_DEPLOY_KEY_PATH"
  fi
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
ExecStart=${NODE_BIN} ${INSTALL_DIR}/executor/server.js
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
  if [ "$REPAIR_EXECUTOR" -eq 0 ]; then
    chown root:root "$UNIT_FILE"
    chmod 0644 "$UNIT_FILE"
  fi
  chown root:root "$EXECUTOR_SOCKET_UNIT" "$EXECUTOR_SERVICE_UNIT"
  chmod 0644 "$EXECUTOR_SOCKET_UNIT" "$EXECUTOR_SERVICE_UNIT"
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
    if ! runuser -u "$RUNTIME_USER" -- "$NODE_BIN" - "$EXECUTOR_SOCKET_PATH" <<'NODE'
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
    then
      die 'executor hello/capability probe failed; inspect journalctl -u homebase-executor'
    fi
    if [ "$REPAIR_EXECUTOR" -eq 1 ] && [ -z "$GIT_SSH_KEY_SOURCE" ]; then
      # Keep web and executor on the same shared code; an unhealthy web service is not a blocker here.
      systemctl try-restart homebase.service || log 'homebase.service did not restart; inspect journalctl -u homebase'
    fi
    if [ "$REPAIR_EXECUTOR" -eq 0 ] || [ -n "$GIT_SSH_KEY_SOURCE" ]; then
      systemctl restart homebase.service
      HEALTHY=0
      for _attempt in $(seq 1 30); do
        if curl --fail --silent "http://127.0.0.1:${PORT}/api/homebase/health" >/dev/null; then
          HEALTHY=1
          break
        fi
        sleep 1
      done
      systemctl is-active --quiet homebase.service \
        || die 'homebase.service did not become active; inspect journalctl -u homebase'
      [ "$HEALTHY" -eq 1 ] \
        || die "homebase.service is active but its loopback health endpoint did not respond on port ${PORT}"
    fi
  fi
fi

log "Home Base ${RELEASE_VERSION} installed with an unprivileged executor-mode web service and typed executor"
log "Open locally: http://127.0.0.1:${PORT}/"
log 'Inspect status: systemctl status homebase'
log 'Inspect logs:   journalctl -u homebase --no-pager'
log 'Next: open Home Base, review the generated host plan, and run approved changes from an operator shell.'
