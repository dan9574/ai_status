#!/bin/sh
# Generate AIStatus.xcodeproj from project.yml.
#   ./scripts/generate.sh [--team TEAMID] [--host HOST|URL] [--token TOKEN] [--prefix com.you]
#                         [--no-xcodegen]
#   --host   default daemon host baked into the app: a Bonjour name
#            (Daniels-MacBook-Air.local), an IP, or a full URL such as
#            https://mac.tailnet.ts.net (https without a port = 443)
#   --token  default daemon read token (aistatus token --read), so it need not
#            be typed on the watch; --token "" removes it
# Values go to Config/Local.xcconfig (gitignored). The first run writes it with
# this Mac's Bonjour name as the default host and a per-user bundle id prefix;
# later runs keep every value you do not pass again.
# AISTATUS_LOCAL_XCCONFIG=path overrides the file (used by scripts/check.sh).
set -eu
cd "$(dirname "$0")/.."
TEAM="" HOST="" TOKEN="" PREFIX=""
TEAM_SET="" HOST_SET="" TOKEN_SET="" PREFIX_SET="" XCODEGEN=1
need() { [ $# -ge 2 ] || { echo "missing value for $1" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --team) need "$@"; TEAM="$2"; TEAM_SET=1; shift 2 ;;
    --host) need "$@"; HOST="$2"; HOST_SET=1; shift 2 ;;
    --token) need "$@"; TOKEN="$2"; TOKEN_SET=1; shift 2 ;;
    --prefix) need "$@"; PREFIX="$2"; PREFIX_SET=1; shift 2 ;;
    --no-xcodegen) XCODEGEN=""; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

# xcconfig values: "//" starts a comment, so every "/" is written as "/$()"
# ($() expands to nothing): https://h -> https:/$()/$()h -> https://h.
xc_escape() { printf '%s' "$1" | sed 's#/#/$()#g'; }
xc_unescape() { printf '%s' "$1" | sed 's#\$()##g'; }
xc_get() { [ -f "$LOCAL" ] && xc_unescape "$(sed -n "s/^$1 *= *//p" "$LOCAL" | tail -n 1)" || true; }

case "$HOST" in *[!]A-Za-z0-9.:/_[-]*) echo "--host: unexpected characters in '$HOST'" >&2; exit 2 ;; esac
case "$TOKEN" in *[!A-Za-z0-9._~+/=-]*) echo "--token: only A-Z a-z 0-9 . _ ~ + / = - are allowed" >&2; exit 2 ;; esac
case "$TEAM$PREFIX" in *[!A-Za-z0-9.-]*) echo "--team / --prefix: unexpected characters" >&2; exit 2 ;; esac
case "$HOST" in
  *://*) case "$HOST" in http://*|https://*) ;; *) echo "--host: only http:// or https:// URLs" >&2; exit 2 ;; esac ;;
esac

LOCAL="${AISTATUS_LOCAL_XCCONFIG:-Config/Local.xcconfig}"
if [ ! -f "$LOCAL" ] || [ -n "$TEAM_SET$HOST_SET$TOKEN_SET$PREFIX_SET" ]; then
  [ -n "$TEAM_SET" ] || TEAM="$(xc_get DEVELOPMENT_TEAM)"
  [ -n "$HOST_SET" ] || HOST="$(xc_get AISTATUS_DEFAULT_HOST)"
  [ -n "$TOKEN_SET" ] || TOKEN="$(xc_get AISTATUS_DEFAULT_TOKEN)"
  [ -n "$PREFIX_SET" ] || PREFIX="$(xc_get BUNDLE_ID_PREFIX)"
  [ -n "$HOST" ] || HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"
  [ -n "$PREFIX" ] || PREFIX="dev.$(id -un | tr -cd 'A-Za-z0-9' | tr 'A-Z' 'a-z')"
  umask 077 # may hold a token
  cat > "$LOCAL" <<EOT
// Written by scripts/generate.sh - per-machine, not committed.
// "/" is written as "/\$()" because "//" would start a comment.
BUNDLE_ID_PREFIX = $PREFIX
AISTATUS_DEFAULT_HOST = $(xc_escape "$HOST")
AISTATUS_DEFAULT_TOKEN = $(xc_escape "$TOKEN")
DEVELOPMENT_TEAM = $TEAM
EOT
  echo "wrote $LOCAL:"
  sed -e 's/^/  /' -e 's/^\(  AISTATUS_DEFAULT_TOKEN = \).\{1,\}$/\1<set, hidden>/' "$LOCAL"
  echo "  (default host: $HOST)"
fi
[ -n "$XCODEGEN" ] || exit 0
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen not found. Install it (brew install xcodegen, or https://github.com/yonaskolb/XcodeGen/releases) and re-run." >&2
  exit 1
fi
xcodegen generate --spec project.yml
echo "open $(pwd)/AIStatus.xcodeproj"
