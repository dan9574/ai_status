# aistatus hook forwarder for Codex on Windows (Windows PowerShell 5.1+ / pwsh 7).
#
# Codex runs this for each lifecycle hook with the hook JSON on stdin:
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<you>/.aistatus/aistatus-hook.ps1
# It POSTs the JSON to the hub (the Mac's aistatusd, or the cloud hub):
#   <url>/hook/codex?machine=<name>                  when "url" is set: a public https
#                                                     URL (Tailscale Funnel) or the cloud
#                                                     hub, e.g. https://<ref>.supabase.co/functions/v1/aistatus
#   http://<host>:<port>/hook/codex?machine=<name>   otherwise (same LAN)
#   (Authorization: Bearer <token>)
# Settings come from %USERPROFILE%\.aistatus\config.json:
#   { "host": "192.168.1.20", "port": 7778, "url": "https://...",
#     "token": "...", "machine": "WIN-PC" }
# so the hook command line never changes (Codex trusts hooks by their hash).
#
# Only events that can change a card are sent (each one is a request, and on
# the cloud hub a billed function invocation):
#  - SessionStart and unknown events: never;
#  - tool activity (PostToolUse) only while a marker file says this session is
#    waiting (after PermissionRequest) or has just stopped (after Stop /
#    Interrupt); the marker is removed when activity, a prompt or the end is sent.
# Activity events, and payloads over 256 KiB, are sent as a small JSON with
# only the fields the hub reads.
#
# Guarantees: no output on stdout/stderr, always exit 0, gives up quickly
# (about 1s per network step on the LAN, 1.4s over https; Codex allows 3s),
# never blocks or breaks the Codex session.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$mode = ''
try {
    # Raw stdin bytes: avoids console code page (e.g. GBK) mangling UTF-8 text.
    $stdin = [Console]::OpenStandardInput()
    $buffer = New-Object System.IO.MemoryStream
    $stdin.CopyTo($buffer)
    $body = $buffer.ToArray()

    if ($body.Length -gt 0) {
        $text = [System.Text.Encoding]::UTF8.GetString($body)
        # First occurrence of a top-level string field (they come before tool input/output).
        function Get-Field([string]$Name) {
            $m = [regex]::Match($text, '"' + $Name + '"\s*:\s*"([^"]*)"')
            if ($m.Success) { return $m.Groups[1].Value }
            return ''
        }
        $hookEvent = Get-Field 'hook_event_name'
        $rawSid = Get-Field 'session_id'
        $sid = $rawSid -replace '[^A-Za-z0-9._-]', ''
        if ($sid.Length -gt 120) { $sid = $sid.Substring(0, 120) }
        $marks = Join-Path $env:USERPROFILE '.aistatus\marks'
        $mark = Join-Path $marks ('codex-' + $sid)
        # Marker trouble must never stop the event from being sent.
        function Set-Mark {
            try {
                if ($sid) {
                    if (-not (Test-Path -LiteralPath $marks)) { New-Item -ItemType Directory -Path $marks -Force | Out-Null }
                    [System.IO.File]::WriteAllText($mark, '')
                }
            } catch { }
        }
        function Clear-Mark {
            try { if ($sid -and (Test-Path -LiteralPath $mark)) { Remove-Item -LiteralPath $mark -Force } } catch { }
        }
        $hasMark = $sid -and (Test-Path -LiteralPath $mark)

        # 'full': the payload as is; 'mini': the small JSON; '': not sent.
        $mode = ''
        switch -CaseSensitive ($hookEvent) {
            'UserPromptSubmit' { Clear-Mark; $mode = 'full' }
            'PermissionRequest' { Set-Mark; $mode = 'full' }
            'Notification' {
                $nt = Get-Field 'notification_type'
                if (@('', 'permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input') -contains $nt) { Set-Mark; $mode = 'full' }
            }
            'PreToolUse' {
                if ((Get-Field 'tool_name') -eq 'AskUserQuestion') { Set-Mark; $mode = 'full' }
                elseif ($hasMark) { Clear-Mark; $mode = 'mini' }
            }
            'PostToolUse' { if ($hasMark) { Clear-Mark; $mode = 'mini' } }
            'PostToolUseFailure' { if ($hasMark) { Clear-Mark; $mode = 'mini' } }
            'PermissionDenied' { if ($hasMark) { Clear-Mark; $mode = 'mini' } }
            'SubagentStart' { Clear-Mark; $mode = 'full' }
            'SubagentStop' { $mode = 'full' }
            'Stop' { Set-Mark; $mode = 'full' }
            'StopFailure' { Set-Mark; $mode = 'full' }
            'Interrupt' { Set-Mark; $mode = 'full' }
            'SessionEnd' {
                Clear-Mark; $mode = 'full'
                try {
                    if (Test-Path -LiteralPath $marks) {
                        $old = (Get-Date).AddDays(-2)
                        Get-ChildItem -LiteralPath $marks -File | Where-Object { $_.LastWriteTime -lt $old } | Remove-Item -Force
                    }
                } catch { }
            }
        }
        if ($mode -and ($mode -eq 'mini' -or $body.Length -gt 262144)) {
            # Small payload: session id, event and the few fields the hub looks at.
            $mini = '{"session_id":"' + $rawSid + '","hook_event_name":"' + $hookEvent + '"'
            foreach ($k in @('agent_id', 'notification_type', 'tool_name', 'cwd')) {
                $v = Get-Field $k
                if ($v -and -not $v.EndsWith('\')) { $mini += ',"' + $k + '":"' + $v + '"' }
            }
            $body = [System.Text.Encoding]::UTF8.GetBytes($mini + '}')
        }
    }

    if ($body.Length -gt 0 -and $mode) {
        $configPath = Join-Path $env:USERPROFILE '.aistatus\config.json'
        $cfg = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json

        $base = ''
        $timeoutMs = 1000
        $url = [string]$cfg.url
        $mac = [string]$cfg.host
        if ($url) {
            # Full base URL, e.g. https://mac.tailnet.ts.net (default port 443) or
            # https://<ref>.supabase.co/functions/v1/aistatus (a path is fine).
            $base = $url.TrimEnd('/')
            $timeoutMs = 1400
            # Windows PowerShell 5.1 (.NET Framework) may not offer TLS 1.2 by default.
            [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
        } elseif ($mac) {
            $port = 7778
            if ($cfg.port) { $port = [int]$cfg.port }
            if ($mac.Contains(':') -and -not $mac.StartsWith('[')) { $mac = '[' + $mac + ']' }
            $base = 'http://' + $mac + ':' + $port
        }
        if ($base) {
            $machine = [string]$cfg.machine
            if (-not $machine) { $machine = [string]$env:COMPUTERNAME }
            $uri = $base + '/hook/codex?machine=' + [System.Uri]::EscapeDataString($machine)

            $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($uri)
            $req.Method = 'POST'
            $req.ContentType = 'application/json; charset=utf-8'
            $req.Timeout = $timeoutMs
            $req.ReadWriteTimeout = $timeoutMs
            $req.KeepAlive = $false
            $req.Proxy = $null
            $req.ContentLength = $body.Length
            if ($cfg.token) { $req.Headers.Add('Authorization', 'Bearer ' + [string]$cfg.token) }

            $out = $req.GetRequestStream()
            try { $out.Write($body, 0, $body.Length) } finally { $out.Close() }
            $resp = $req.GetResponse()
            $resp.Close()
        }
    }
} catch {
    # Hub asleep/unreachable, wrong address, firewall, bad token, missing config: ignore.
}
exit 0
