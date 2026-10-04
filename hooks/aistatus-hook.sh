#!/bin/sh
# aistatus hook forwarder for Claude Code / Codex lifecycle hooks.
# Usage: aistatus-hook <claude|codex> [port]
# Reads the hook JSON from stdin and forwards it:
#  - local mode (default): POST to the local aistatusd on 127.0.0.1:<port>;
#  - cloud mode, while ~/.aistatus/cloud.curl exists (`aistatus cloud setup`;
#    removed by `aistatus cloud off`): POST to the cloud hub (Supabase Edge
#    Function), and only the events that can change a card (see below).
# The command line in the agents' settings is the same in both modes, so
# switching never touches ~/.claude/settings.json or ~/.codex/hooks.json.
# Always exits 0 silently and quickly, even if nothing answers, so it can never
# block or break the agent session.
tool="${1:-claude}"
port="${2:-${AISTATUS_PORT:-7778}}"
dir="${AISTATUS_DIR:-$HOME/.aistatus}"
cloud="$dir/cloud.curl"

if [ ! -f "$cloud" ]; then
  /usr/bin/curl -s -o /dev/null --noproxy '*' --connect-timeout 0.5 --max-time 2 \
    -H 'Content-Type: application/json' --data-binary @- \
    "http://127.0.0.1:${port}/hook/${tool}" >/dev/null 2>&1
  exit 0
fi

# ---- cloud mode -------------------------------------------------------------
# cloud.curl (mode 600) is a curl config file holding the Authorization header;
# the base URL and the query (machine name) are in comment lines.
# Every forwarded event is one function invocation (free tier: 500k/month), so
# events the hub ignores are not sent at all:
#  - SessionStart, idle/auth Notifications, unknown events: never sent;
#  - tool activity (PostToolUse & co.) only matters to leave "waiting" (or to
#    continue right after a Stop): it is sent only while a marker file says this
#    session is waiting / just stopped. The marker is set when a wait or a Stop
#    is sent and removed when activity, a prompt or the end is sent.
# Activity events, and any payload over 256 KiB, are sent as a small JSON with
# only the fields the hub reads (tool output never leaves this Mac for them).
case "$tool" in claude|codex) ;; *) exit 0 ;; esac
base=$(/usr/bin/sed -n 's/^# base = //p' "$cloud" 2>/dev/null | /usr/bin/head -n 1)
query=$(/usr/bin/sed -n 's/^# query = //p' "$cloud" 2>/dev/null | /usr/bin/head -n 1)
[ -n "$base" ] || exit 0
body=$(/bin/cat 2>/dev/null)
[ -n "$body" ] || exit 0

# First occurrence of a top-level string field (they come before tool input/output).
field() {
  printf '%s' "$body" | /usr/bin/grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" 2>/dev/null \
    | /usr/bin/head -n 1 | /usr/bin/sed 's/.*"\([^"]*\)"$/\1/'
}
event=$(field hook_event_name)
sid=$(field session_id | /usr/bin/tr -cd 'A-Za-z0-9._-' | /usr/bin/cut -c 1-120)
marks="$dir/marks"
mark="$marks/$tool-$sid"
set_mark() { [ -n "$sid" ] && /bin/mkdir -p "$marks" 2>/dev/null && : > "$mark" 2>/dev/null; }
clear_mark() { [ -n "$sid" ] && /bin/rm -f "$mark" 2>/dev/null; }
# Small payload: session id, event and the few fields the hub looks at.
mini() {
  printf '{"session_id":"%s","hook_event_name":"%s"' "$(field session_id)" "$event"
  for k in agent_id notification_type tool_name cwd; do
    v=$(field "$k")
    case "$v" in ""|*\\) ;; *) printf ',"%s":"%s"' "$k" "$v" ;; esac
  done
  printf '}'
}
send() {
  if [ "${1:-}" = mini ] || [ "${#body}" -gt 262144 ]; then body=$(mini); fi
  printf '%s' "$body" | /usr/bin/curl -s -o /dev/null --connect-timeout 2 --max-time 2.5 -K "$cloud" \
    -H 'Content-Type: application/json' --data-binary @- \
    "$base/hook/$tool${query:+?$query}" >/dev/null 2>&1
}

case "$event" in
  UserPromptSubmit) clear_mark; send ;;
  PermissionRequest) set_mark; send ;;
  Notification)
    case "$(field notification_type)" in
      ""|permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input) set_mark; send ;;
    esac ;;
  PreToolUse)
    if [ "$(field tool_name)" = AskUserQuestion ]; then set_mark; send
    elif [ -f "$mark" ]; then clear_mark; send mini; fi ;;
  PostToolUse|PostToolUseFailure|PermissionDenied)
    if [ -f "$mark" ]; then clear_mark; send mini; fi ;;
  SubagentStart) clear_mark; send ;;
  SubagentStop) send ;;
  Stop|StopFailure|Interrupt) set_mark; send ;;
  SessionEnd)
    clear_mark; send
    /usr/bin/find "$marks" -type f -mtime +2 -delete >/dev/null 2>&1 ;;
esac
exit 0
