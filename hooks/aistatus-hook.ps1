# aistatus hook forwarder for Codex on Windows (Windows PowerShell 5.1+ / pwsh 7).
#
# Codex runs this for each lifecycle hook with the hook JSON on stdin:
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<you>/.aistatus/aistatus-hook.ps1
# It POSTs the raw JSON bytes to the Mac running aistatusd:
#   http://<host>:<port>/hook/codex?machine=<name>   (Authorization: Bearer <token>)
# Settings come from %USERPROFILE%\.aistatus\config.json:
#   { "host": "192.168.1.20", "port": 7778, "token": "...", "machine": "WIN-PC" }
# so the hook command line never changes (Codex trusts hooks by their hash).
#
# Guarantees: no output on stdout/stderr, always exit 0, gives up quickly
# (about 1s per network step), never blocks or breaks the Codex session.
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

        $mac = [string]$cfg.host
        if ($mac) {
            $port = 7778
            if ($cfg.port) { $port = [int]$cfg.port }
            $machine = [string]$cfg.machine
            if (-not $machine) { $machine = [string]$env:COMPUTERNAME }
            if ($mac.Contains(':') -and -not $mac.StartsWith('[')) { $mac = '[' + $mac + ']' }
            $uri = 'http://' + $mac + ':' + $port + '/hook/codex?machine=' + [System.Uri]::EscapeDataString($machine)

            $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($uri)
            $req.Method = 'POST'
            $req.ContentType = 'application/json; charset=utf-8'
            $req.Timeout = 1000
            $req.ReadWriteTimeout = 1000
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
