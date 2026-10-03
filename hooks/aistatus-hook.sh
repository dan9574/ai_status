#!/bin/sh
# aistatus hook forwarder for Claude Code / Codex lifecycle hooks.
# Usage: aistatus-hook <claude|codex> [port]
# Reads the hook JSON from stdin and POSTs it to the local aistatusd.
# Always exits 0 silently and quickly, even if the daemon is not running,
# so it can never block or break the agent session.
tool="${1:-claude}"
port="${2:-${AISTATUS_PORT:-7778}}"
/usr/bin/curl -s -o /dev/null --noproxy '*' --connect-timeout 0.5 --max-time 2 \
  -H 'Content-Type: application/json' --data-binary @- \
  "http://127.0.0.1:${port}/hook/${tool}" >/dev/null 2>&1
exit 0
