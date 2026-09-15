#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="${1:-}"
OUTPUT_DIR="${2:-dist}"

printf '%s\n' "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  || { echo 'usage: scripts/build-release.sh vX.Y.Z [output-dir]' >&2; exit 2; }

[ -z "$(git status --porcelain)" ] \
  || { echo 'refusing to package a dirty working tree' >&2; exit 1; }

mkdir -p "$OUTPUT_DIR"
ARCHIVE="${OUTPUT_DIR}/homebase-${VERSION#v}.tar.gz"
git archive --format=tar.gz --prefix="homebase-${VERSION#v}/" --output="$ARCHIVE" HEAD

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUTPUT_DIR" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
else
  (cd "$OUTPUT_DIR" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
fi

printf 'Created %s and %s.sha256\n' "$ARCHIVE" "$ARCHIVE"
