<#
.SYNOPSIS
  Install (or remove) the aistatus Codex hooks on a Windows PC so its Codex
  sessions show up on the Mac running aistatusd (and on the watch).

.DESCRIPTION
  1. Writes %USERPROFILE%\.aistatus\config.json  { host, port, token, machine }
  2. Copies aistatus-hook.ps1 to %USERPROFILE%\.aistatus\aistatus-hook.ps1
     (from ..\hooks\ or this folder; when run without a file, e.g. via the
     one-line install, it is downloaded from http://<MacHost>:<Port>/setup/).
  3. Merges hook entries into %USERPROFILE%\.codex\hooks.json:
     backup first (to %USERPROFILE%\.aistatus\backups\), idempotent, refuses
     to touch invalid JSON, never changes entries that are not ours.
  -Uninstall removes only our entries (commands containing "aistatus-hook").

  The hook command line is constant:
    powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<you>/.aistatus/aistatus-hook.ps1
  so re-running with a new IP/port/token only rewrites config.json and Codex
  does not ask to trust the hooks again.

  Compatible with Windows PowerShell 5.1. Keep this file ASCII-only.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -MacHost 192.168.1.20 -Token abc123
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$MacHost,
    [int]$Port = 0,
    [string]$Token,
    [string]$Machine,
    [switch]$Uninstall,
    [switch]$SkipTest
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Windows PowerShell 5.1 serialises arrays as {"value":[...],"Count":n} when
# this extended type data is present; removing it keeps ConvertTo-Json sane.
try { Remove-TypeData -TypeName System.Array -ErrorAction SilentlyContinue } catch { }

# Must match CODEX_EVENTS in src/installer.js (checked by test/windows-scripts.test.js).
$Events = @('SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'SessionEnd')
$HookTimeoutSec = 3      # Codex allows at most 3s for SessionEnd / Interrupt
$Marker = 'aistatus-hook'

$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
$DataDir = Join-Path $env:USERPROFILE '.aistatus'
$ConfigFile = Join-Path $DataDir 'config.json'
$HookFile = Join-Path $DataDir 'aistatus-hook.ps1'
$BackupDir = Join-Path $DataDir 'backups'
$CodexDir = Join-Path $env:USERPROFILE '.codex'
$CodexHooks = Join-Path $CodexDir 'hooks.json'
# Forward slashes: valid for PowerShell -File and safe under cmd, PowerShell or a POSIX shell.
$HookCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + ($HookFile -replace '\\', '/') + '"'

function Write-Utf8File([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = $Path + '.aistatus-tmp'
    [System.IO.File]::WriteAllText($tmp, $Text, $Utf8NoBom)   # Codex's JSON parser rejects a BOM
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    Move-Item -LiteralPath $tmp -Destination $Path
}

function Read-JsonObject([string]$Path) {
    # Returns $null when the file is missing or blank; throws on invalid JSON.
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $raw = [System.IO.File]::ReadAllText($Path)
    if (-not $raw.Trim()) { return $null }
    try { $obj = ConvertFrom-Json -InputObject $raw }
    catch { throw "$Path is not valid JSON ($($_.Exception.Message)); refusing to modify it" }
    if ($obj -isnot [System.Management.Automation.PSCustomObject]) { throw "$Path is not a JSON object; refusing to modify it" }
    return $obj
}

function Test-Ours($handler) {
    return ($handler -is [System.Management.Automation.PSCustomObject]) -and
        ($handler.PSObject.Properties['command']) -and
        ([string]$handler.command).Contains($Marker)
}

function Get-OurEntries($data) {
    # Canonical list of our handlers, for idempotency comparison.
    $list = New-Object System.Collections.Generic.List[string]
    if ($null -eq $data -or -not $data.PSObject.Properties['hooks']) { return ,$list }
    $hooks = $data.hooks
    if ($hooks -isnot [System.Management.Automation.PSCustomObject]) { return ,$list }
    foreach ($prop in $hooks.PSObject.Properties) {
        foreach ($group in @($prop.Value)) {
            if ($group -isnot [System.Management.Automation.PSCustomObject] -or -not $group.PSObject.Properties['hooks']) { continue }
            foreach ($h in @($group.hooks)) {
                if (Test-Ours $h) {
                    $list.Add(($prop.Name, [string]$group.matcher, [string]$h.type, [string]$h.command, [string]$h.timeout) -join '|')
                }
            }
        }
    }
    $list.Sort()
    return ,$list
}

function Remove-OurHooks($data) {
    if (-not $data.PSObject.Properties['hooks']) { return }
    $hooks = $data.hooks
    if ($hooks -isnot [System.Management.Automation.PSCustomObject]) { return }
    $removed = $false
    foreach ($prop in @($hooks.PSObject.Properties)) {
        if ($prop.Value -isnot [array]) { continue }
        $kept = @()
        foreach ($group in $prop.Value) {
            if ($group -is [System.Management.Automation.PSCustomObject] -and $group.PSObject.Properties['hooks'] -and $group.hooks -is [array]) {
                $handlers = @($group.hooks | Where-Object { -not (Test-Ours $_) })
                if ($handlers.Count -eq $group.hooks.Count) { $kept += ,$group; continue }
                $removed = $true
                if ($handlers.Count -gt 0) { $group.hooks = $handlers; $kept += ,$group }
            } else {
                $kept += ,$group
            }
        }
        if ($kept.Count -gt 0) { $hooks.($prop.Name) = $kept }
        else { $hooks.PSObject.Properties.Remove($prop.Name) }
    }
    if ($removed -and @($hooks.PSObject.Properties).Count -eq 0) { $data.PSObject.Properties.Remove('hooks') }
}

function Add-OurHooks($data) {
    Remove-OurHooks $data
    if (-not $data.PSObject.Properties['hooks'] -or $data.hooks -isnot [System.Management.Automation.PSCustomObject]) {
        if ($data.PSObject.Properties['hooks']) { $data.PSObject.Properties.Remove('hooks') }
        $data | Add-Member -NotePropertyName 'hooks' -NotePropertyValue (New-Object PSObject)
    }
    foreach ($ev in $Events) {
        # Codex: an omitted matcher matches everything (same as the Mac installer).
        $handler = [pscustomobject]@{ type = 'command'; command = $HookCommand; timeout = $HookTimeoutSec }
        $group = [pscustomobject]@{ hooks = @($handler) }
        $existing = $data.hooks.PSObject.Properties[$ev]
        if ($existing -and $existing.Value -is [array]) {
            $data.hooks.$ev = @($existing.Value) + @($group)
        } else {
            if ($existing) { $data.hooks.PSObject.Properties.Remove($ev) }
            $data.hooks.PSObject.Properties.Add([System.Management.Automation.PSNoteProperty]::new($ev, [object[]]@($group)))
        }
    }
}

function Update-CodexHooks([bool]$Install) {
    $data = Read-JsonObject $CodexHooks
    $exists = Test-Path -LiteralPath $CodexHooks
    if ($null -eq $data) {
        if (-not $Install) { Write-Host "codex: nothing to remove in $CodexHooks"; return }
        $data = New-Object PSObject
    }
    $before = (Get-OurEntries $data) -join "`n"
    if ($Install) { Add-OurHooks $data } else { Remove-OurHooks $data }
    $after = (Get-OurEntries $data) -join "`n"
    if ($before -eq $after) {
        if ($Install) { Write-Host "codex: hooks already installed in $CodexHooks" }
        else { Write-Host "codex: nothing to remove in $CodexHooks" }
        return
    }
    if ($exists) {
        if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
        $backup = Join-Path $BackupDir "codex-hooks.$stamp.json"
        Copy-Item -LiteralPath $CodexHooks -Destination $backup
        Write-Host "codex: backup of $CodexHooks -> $backup"
    }
    $json = ConvertTo-Json -InputObject $data -Depth 32
    Write-Utf8File $CodexHooks ($json + "`n")
    if ($Install) { Write-Host "codex: installed aistatus hooks into $CodexHooks" }
    else { Write-Host "codex: removed aistatus hooks from $CodexHooks" }
}

function Install-HookScript([string]$MacHostForDownload, [int]$PortForDownload) {
    $candidates = @()
    if ($PSScriptRoot) {
        $candidates += (Join-Path (Split-Path -Parent $PSScriptRoot) 'hooks\aistatus-hook.ps1')
        $candidates += (Join-Path $PSScriptRoot 'aistatus-hook.ps1')
    }
    $src = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($src) {
        $text = [System.IO.File]::ReadAllText($src)
    } else {
        $h = $MacHostForDownload
        if ($h.Contains(':') -and -not $h.StartsWith('[')) { $h = '[' + $h + ']' }
        $url = "http://${h}:${PortForDownload}/setup/aistatus-hook.ps1"
        Write-Host "downloading hook script from $url"
        $wc = New-Object System.Net.WebClient
        $wc.Encoding = [System.Text.Encoding]::UTF8
        $text = $wc.DownloadString($url)
        if (-not $text.Contains($Marker)) { throw "unexpected content from $url" }
    }
    Write-Utf8File $HookFile $text
    Write-Host "hook script: $HookFile"
}

function Test-Remote($cfg) {
    # Sends a SessionStart for a dummy session: it creates no visible card on the
    # watch, but proves address, port, firewall and token in one request.
    $h = [string]$cfg.host
    if ($h.Contains(':') -and -not $h.StartsWith('[')) { $h = '[' + $h + ']' }
    $uri = "http://${h}:$($cfg.port)/hook/codex?machine=" + [System.Uri]::EscapeDataString([string]$cfg.machine)
    $body = [System.Text.Encoding]::UTF8.GetBytes('{"session_id":"aistatus-install-check","hook_event_name":"SessionStart","source":"startup"}')
    try {
        $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($uri)
        $req.Method = 'POST'
        $req.ContentType = 'application/json; charset=utf-8'
        $req.Timeout = 3000
        $req.Proxy = $null
        $req.ContentLength = $body.Length
        if ($cfg.token) { $req.Headers.Add('Authorization', 'Bearer ' + [string]$cfg.token) }
        $out = $req.GetRequestStream(); $out.Write($body, 0, $body.Length); $out.Close()
        $resp = $req.GetResponse(); $resp.Close()
        Write-Host "test: OK, the Mac accepted a hook from '$($cfg.machine)'" -ForegroundColor Green
    } catch [System.Net.WebException] {
        $code = 0
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        switch ($code) {
            401 { Write-Warning 'test: the Mac rejected the token (401). Check it with `aistatus token` on the Mac.' }
            403 { Write-Warning 'test: the Mac has remote hooks disabled (403). On the Mac run `aistatus token --new --hooks-only` and restart the daemon.' }
            0 { Write-Warning "test: cannot reach $uri ($($_.Exception.Message)). Same network? Mac awake? macOS firewall allowing node? Daemon running?" }
            default { Write-Warning "test: unexpected HTTP $code from $uri" }
        }
    } catch {
        Write-Warning "test: failed ($($_.Exception.Message))"
    }
}

# ------------------------------------------------------------------- main
if ($Uninstall) {
    Update-CodexHooks $false
    Write-Host "left $DataDir in place (config + hook script); delete it manually if you no longer need it."
    exit 0
}

# Merge parameters over an existing config so re-running with only -Token works.
$old = $null
try { $old = Read-JsonObject $ConfigFile } catch { Write-Warning "ignoring unreadable $ConfigFile" }
if (-not $MacHost -and $old) { $MacHost = [string]$old.host }
if ($Port -le 0) { if ($old -and $old.port) { $Port = [int]$old.port } else { $Port = 7778 } }
if (-not $PSBoundParameters.ContainsKey('Token') -and $old) { $Token = [string]$old.token }
if (-not $Machine) { if ($old -and $old.machine) { $Machine = [string]$old.machine } else { $Machine = [string]$env:COMPUTERNAME } }
if (-not $MacHost) { throw 'missing -MacHost <Mac IP address> (run `aistatus remote-setup` on the Mac to see it)' }
if (-not $Token) { Write-Warning 'no -Token given: the Mac will refuse these hooks until a token is configured on both sides.' }

$cfg = [pscustomobject]@{ host = $MacHost; port = $Port; token = $Token; machine = $Machine }
Write-Utf8File $ConfigFile ((ConvertTo-Json -InputObject $cfg) + "`n")
Write-Host "config: $ConfigFile (host=$MacHost port=$Port machine=$Machine)"

Install-HookScript $MacHost $Port
if (-not (Test-Path -LiteralPath $CodexDir)) { Write-Warning "$CodexDir does not exist yet (is Codex installed and started once?); creating it." }
Update-CodexHooks $true

if (-not $SkipTest) { Test-Remote $cfg }
Write-Host ''
Write-Host 'Next: open Codex and trust the new hooks once (/hooks in the Codex CLI, or the hooks review prompt in the desktop app).'
Write-Host 'Codex skips untrusted hooks, so nothing is sent before that.'
