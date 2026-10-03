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
echo "ALL LOCAL CHECKS PASSED"
