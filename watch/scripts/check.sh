#!/bin/sh
# Everything that can be verified without Xcode / the watchOS SDK:
#  1. swift build of AIStatusKit + AIStatusUI (macOS)
#  2. the AIStatusChecks runner (unit + view-model + render smoke tests)
#  3. type-check of the app and widget entry points (App/, Widget/) against the
#     built modules, for macOS (watch-only branches behind #if os(watchOS) are skipped)
#  4. plist / YAML syntax of the Xcode inputs
# Live checks against a real daemon: node AIStatusKit/scripts/live-check.mjs
set -eu
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
quiet() { grep -v -E 'XCTest|xcrun: error|PlatformPath|^ *$' || true; }
echo "== swift build"
(cd AIStatusKit && swift build 2>&1 | quiet)
echo "== checks"
(cd AIStatusKit && ./.build/debug/AIStatusChecks)
BIN="$(cd AIStatusKit && swift build --show-bin-path 2>/dev/null)"
SDK="$(xcrun --show-sdk-path)"
for dir in App Widget; do
  echo "== type-check $dir/*.swift (macOS)"
  xcrun swiftc -typecheck -parse-as-library -sdk "$SDK" -target arm64-apple-macos14.0 \
    -I "$BIN/Modules" -I "$BIN" "$ROOT/$dir"/*.swift
done
echo "== plists"
plutil -lint App/Info.plist Widget/Info.plist App/AIStatus.entitlements Widget/AIStatusWidget.entitlements
echo "== project.yml"
ruby -ryaml -e 'YAML.load_file("project.yml"); puts "project.yml: YAML OK"'

echo "== build-time defaults: generate.sh -> xcconfig -> Info.plist (dummy values)"
fail() { echo "FAIL: $*" >&2; exit 1; }
[ "$(plutil -extract AIStatusDefaultHost raw App/Info.plist)" = '$(AISTATUS_DEFAULT_HOST)' ] || fail "Info.plist AIStatusDefaultHost"
[ "$(plutil -extract AIStatusDefaultToken raw App/Info.plist)" = '$(AISTATUS_DEFAULT_TOKEN)' ] || fail "Info.plist AIStatusDefaultToken"
grep -q '^AISTATUS_DEFAULT_TOKEN =$' Config/Base.xcconfig || fail "Base.xcconfig must not carry a token"
if git -C "$ROOT" rev-parse >/dev/null 2>&1; then
  git -C "$ROOT" check-ignore -q Config/Local.xcconfig || fail "Config/Local.xcconfig must be gitignored (it may hold a token)"
fi
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
X="$TMPD/Local.xcconfig"
D_HOST="https://dummy-host.example.ts.net"
D_TOKEN="dummy_TOKEN-0123456789abcdef"
AISTATUS_LOCAL_XCCONFIG="$X" ./scripts/generate.sh --no-xcodegen --team DUMMYTEAM --prefix dev.check --host "$D_HOST" --token "$D_TOKEN" | grep -q '<set, hidden>' || fail "generate.sh must not echo the token"
grep -v '^//' "$X" | grep -q '//' && fail "a value in $X contains '//' (would be cut off as a comment)"
[ "$(stat -f %Lp "$X")" = 600 ] || fail "Local.xcconfig should be mode 600"
# a later run with other options keeps host and token
AISTATUS_LOCAL_XCCONFIG="$X" ./scripts/generate.sh --no-xcodegen --prefix dev.check2 >/dev/null
grep -q '^AISTATUS_DEFAULT_HOST = https:/\$()/\$()dummy-host.example.ts.net$' "$X" || fail "host not kept/escaped: $(grep HOST "$X")"
grep -q "^AISTATUS_DEFAULT_TOKEN = $D_TOKEN\$" "$X" || fail "token not kept"
grep -q '^DEVELOPMENT_TEAM = DUMMYTEAM$' "$X" || fail "team not kept"
AISTATUS_LOCAL_XCCONFIG="$X" ./scripts/generate.sh --no-xcodegen --token '$(EVIL)' >/dev/null 2>&1 && fail "bad token accepted"
AISTATUS_LOCAL_XCCONFIG="$X" ./scripts/generate.sh --no-xcodegen --host 'ftp://x' >/dev/null 2>&1 && fail "non-http URL accepted"
echo "generate.sh: escaping, preservation, validation OK"
if [ -d AIStatus.xcodeproj ]; then
  # How Xcode itself expands the values (what ends up in the built Info.plist).
  S="$(xcodebuild -project AIStatus.xcodeproj -target AIStatus -showBuildSettings -xcconfig "$X" 2>/dev/null | sed -n '/^Build settings for action/,$p')"
  echo "$S" | grep -q "^ *AISTATUS_DEFAULT_HOST = $D_HOST\$" || fail "xcodebuild expands host to: $(echo "$S" | grep AISTATUS_DEFAULT_HOST)"
  echo "$S" | grep -q "^ *AISTATUS_DEFAULT_TOKEN = $D_TOKEN\$" || fail "xcodebuild expands token to: $(echo "$S" | grep AISTATUS_DEFAULT_TOKEN)"
  echo "xcodebuild -showBuildSettings: AISTATUS_DEFAULT_HOST = $D_HOST, token expanded OK"
else
  echo "SKIP xcodebuild expansion check (no AIStatus.xcodeproj; run scripts/generate.sh first)"
fi
echo "ALL LOCAL CHECKS PASSED"
