<#
.SYNOPSIS
  Opens the awesome-dsh-plugin catalog PR for a plugin repo, once it qualifies.

.DESCRIPTION
  The curated list (what dsh-market reads) accepts one YAML entry per plugin and
  requires the plugin repository to be at least one day old. This script is what
  submitted dsh-mimo-tts: it checks the age, refuses to submit early, refuses to
  open a second PR for the same branch, and otherwise pushes the PR upstream with
  the `gh` CLI using the signed-in user's own credentials.

  It expects the fork to already exist with the entry committed on a branch —
  see scripts/README.md for the two commands that set that up.

.EXAMPLE
  pwsh -File scripts/open-catalog-pr.ps1

.EXAMPLE
  # register a one-shot task so it runs without anyone at the machine
  $script = "$PWD\scripts\open-catalog-pr.ps1"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date '2026-10-01 13:10:00')
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
    -ExecutionTimeLimit ([TimeSpan]::FromMinutes(15))
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'DSHMimoTtsCatalogPr' -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force
#>
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 script in
# the ANSI codepage, which would corrupt non-ASCII text in here.
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Repo = 'lengmodkx/dsh-mimo-tts',
  [string]$Upstream = 'awesome-dsh-plugin/awesome-dsh-plugin',
  [string]$Head = 'lengmodkx:add/lengmodkx-dsh-mimo-tts',
  [string]$Title = 'Add lengmodkx/dsh-mimo-tts (voice)',
  [string]$Gh = 'C:\Program Files\GitHub CLI\gh.exe'
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $DshHome 'dsh-mimo-tts-catalog-pr.log'

function Write-Log([string]$Message) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  $line | Out-File -FilePath $log -Append -Encoding utf8
}

Write-Log '--- catalog PR run started ---'

if (-not (Test-Path $Gh)) {
  $Gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
}
if (-not $Gh) {
  Write-Log 'gh CLI not found; install it or pass -Gh <path>'
  exit 1
}

# 1) The catalog checks that the plugin repository is at least one day old.
$createdRaw = (& $Gh api "repos/$Repo" --jq '.created_at' 2>&1 | Out-String).Trim()
Write-Log "plugin repo created_at: $createdRaw"
$created = $null
try { $created = [datetime]::Parse($createdRaw).ToUniversalTime() } catch { }
if ($null -eq $created) {
  Write-Log 'could not read created_at; aborting rather than submitting blind'
  exit 1
}
$ageHours = ((Get-Date).ToUniversalTime() - $created).TotalHours
Write-Log ('repo age: {0:N1} hours' -f $ageHours)
if ($ageHours -lt 24) {
  Write-Log 'younger than 24h - leaving it for the next run'
  exit 0
}

# 2) Never open a second PR for the same branch.
$existing = (& $Gh pr list --repo $Upstream --head $Head --state all --json url --jq '.[0].url' 2>&1 | Out-String).Trim()
if ($existing -like 'http*') {
  Write-Log "a PR already exists: $existing"
  exit 0
}

# 3) Open it.
$body = @'
Adds `lengmodkx/dsh-mimo-tts` under **voice**.

MiMo voice for DeepSeek Harness: reads each finished answer aloud, turns composer dictation into text, and offers nine built-in voices plus a cloned-voice slot.

- `dsh.bundle` manifest: `cordis.patch.yml` in the repository root.
- Install: `dsh plugin --profile web add github:lengmodkx/dsh-mimo-tts` (a prebuilt tarball is attached to the v0.1.0 release and declared in the entry's `tarball:` field).
- Verified on DSH 0.2.0-rc.2: the host boots with the plugin mounted and `GET /dsh-mimo-tts/status` answers 200; the offline suite `node test/smoke.mjs` passes 18 checks (routes, browser-trust fence, text sanitizer, request validation).
- MIT licensed. No telemetry: the only network calls are to `token-plan-cn.xiaomimimo.com` with the user's own key.
'@

$result = (& $Gh pr create --repo $Upstream --base main --head $Head --title $Title --body $body 2>&1 | Out-String).Trim()
Write-Log "gh pr create: $result"
Write-Log '--- catalog PR run finished ---'
