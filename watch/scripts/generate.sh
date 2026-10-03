#!/bin/sh
# Generate AIStatus.xcodeproj from project.yml.
#   ./scripts/generate.sh [--team TEAMID] [--host NAME.local] [--prefix com.you]
# First run writes Config/Local.xcconfig (gitignored) with this Mac's Bonjour
# name as the watch's default host and a per-user bundle id prefix.
set -eu
cd "$(dirname "$0")/.."
TEAM="" HOST="" PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --team) TEAM="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
LOCAL=Config/Local.xcconfig
if [ ! -f "$LOCAL" ] || [ -n "$TEAM$HOST$PREFIX" ]; then
  [ -n "$HOST" ] || HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"
  [ -n "$PREFIX" ] || PREFIX="dev.$(id -un | tr -cd 'A-Za-z0-9' | tr 'A-Z' 'a-z')"
  if [ -z "$TEAM" ] && [ -f "$LOCAL" ]; then
    TEAM="$(sed -n 's/^DEVELOPMENT_TEAM *= *//p' "$LOCAL")"
  fi
  cat > "$LOCAL" <<EOT
// Written by scripts/generate.sh — per-machine, not committed.
BUNDLE_ID_PREFIX = $PREFIX
AISTATUS_DEFAULT_HOST = $HOST
DEVELOPMENT_TEAM = $TEAM
EOT
  echo "wrote $LOCAL:"; sed 's/^/  /' "$LOCAL"
fi
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen not found. Install it (brew install xcodegen, or https://github.com/yonaskolb/XcodeGen/releases) and re-run." >&2
  exit 1
fi
xcodegen generate --spec project.yml
echo "open $(pwd)/AIStatus.xcodeproj"
