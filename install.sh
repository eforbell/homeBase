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
  --repair-executor    Restore only executor code, group, socket, and service assets
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
done

if [ "$TEST_MODE" != '1' ]; then
  [ "$(id -u)" -eq 0 ] || die 'run this installer through sudo or as root'
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
    log "repairing managed executor code while preserving Home Base code, config, and state"
    mkdir -p "$INSTALL_DIR/executor"
    cp -a "$SOURCE_DIR/executor"/. "$INSTALL_DIR/executor"/
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
HOME_BASE_EXECUTOR_PROTOCOL_VERSION=1
EOF
  if [ "$TEST_MODE" != '1' ]; then
    chown root:"$RUNTIME_USER" "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
  fi
elif [ "$REPAIR_EXECUTOR" -eq 0 ]; then
  log "preserving existing environment file: $ENV_FILE"
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
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
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
    systemctl restart homebase-executor.socket
    systemctl is-active --quiet homebase-executor.socket \
      || die 'homebase-executor.socket did not become active; inspect journalctl -u homebase-executor.socket'
    [ "$(stat -c '%U:%G %a' "$EXECUTOR_SOCKET_PATH")" = "root:${EXECUTOR_GROUP} 660" ] \
      || die "executor socket has unexpected owner or mode: $EXECUTOR_SOCKET_PATH"
    if ! runuser -u "$RUNTIME_USER" -- "$NODE_BIN" - "$EXECUTOR_SOCKET_PATH" <<'NODE'
const net = require('net');
const socketPath = process.argv[2];
const request = { protocolVersion: 1, requestId: require('crypto').randomUUID(), type: 'hello' };
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
    process.exit(payload.protocolVersion === 1 && payload.ok === true && payload.result?.capabilities?.mutationsEnabled === true ? 0 : 1);
  } catch { process.exit(1); }
});
NODE
    then
      die 'executor hello/capability probe failed; inspect journalctl -u homebase-executor'
    fi
    if [ "$REPAIR_EXECUTOR" -eq 0 ]; then
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
