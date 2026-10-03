# aistatus hook forwarder for Codex on Windows (Windows PowerShell 5.1+ / pwsh 7).
#
# Codex runs this for each lifecycle hook with the hook JSON on stdin:
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<you>/.aistatus/aistatus-hook.ps1
# It POSTs the raw JSON bytes to the Mac running aistatusd:
#   <url>/hook/codex?machine=<name>                  when "url" is set, e.g. a public
#                                                     https URL (Tailscale Funnel)
#   http://<host>:<port>/hook/codex?machine=<name>   otherwise (same LAN)
#   (Authorization: Bearer <token>)
# Settings come from %USERPROFILE%\.aistatus\config.json:
#   { "host": "192.168.1.20", "port": 7778, "url": "https://mac.tailnet.ts.net",
#     "token": "...", "machine": "WIN-PC" }
# so the hook command line never changes (Codex trusts hooks by their hash).
#
# Guarantees: no output on stdout/stderr, always exit 0, gives up quickly
# (about 1s per network step on the LAN, 1.4s over https; Codex allows 3s),
# never blocks or breaks the Codex session.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    # Raw stdin bytes: avoids console code page (e.g. GBK) mangling UTF-8 text.
    $stdin = [Console]::OpenStandardInput()
    $buffer = New-Object System.IO.MemoryStream
    $stdin.CopyTo($buffer)
    $body = $buffer.ToArray()

    if ($body.Length -gt 0) {
        $configPath = Join-Path $env:USERPROFILE '.aistatus\config.json'
        $cfg = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json

        $base = ''
        $timeoutMs = 1000
        $url = [string]$cfg.url
        $mac = [string]$cfg.host
        if ($url) {
            # Full base URL, e.g. https://mac.tailnet.ts.net (default port 443).
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
    # Mac asleep, wrong address, firewall, bad token, missing config: ignore.
}
exit 0
