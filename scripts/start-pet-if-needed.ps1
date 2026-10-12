<#
.SYNOPSIS
  Keeps the native Live2D pet window alive on a DSH desktop install.

.DESCRIPTION
  The page inside the Electron desktop app cannot load the pet's model assets:
  its renderer asks for them through the app's own `dsh-app://` scheme, which
  404s on plugin routes served under `/api/...`. The pet ships a native window
  instead (`dsh-pet-live2d-desktop.exe --attach http://127.0.0.1:<port>`), which
  fetches the same files over plain HTTP, and while its heartbeat file stays
  fresh the in-page copy stands down by itself.

  This script is meant for Task Scheduler: run it at logon and every half hour.
  It starts nothing when the window is already up, when the DSH host is not
  listening yet (a logon that raced the app), or when the pet was parked in
  page-only mode by the user.

.EXAMPLE
  # one-off
  pwsh -File scripts/start-pet-if-needed.ps1

.EXAMPLE
  # register the self-healing task (logon + every 30 minutes)
  $script = "$PWD\scripts\start-pet-if-needed.ps1"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
  $logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $logon.Delay = 'PT45S'
  $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(10)) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'DSHPetLive2D' -Action $action -Trigger @($logon, $repeat) `
    -Settings $settings -Principal $principal -Force
#>
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 script in
# the ANSI codepage, which would corrupt non-ASCII text in here.
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'desktop',
  [int]$Port = 19387,
  [string]$Exe,
  [int]$WaitSeconds = 5
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $DshHome 'dsh-pet-autostart.log'

function Write-Log([string]$Message) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  $line | Out-File -FilePath $log -Append -Encoding utf8
}

# Resolve the binary: explicit path wins, otherwise any platform subpackage.
if (-not $Exe) {
  $pattern = Join-Path $DshHome "profiles\$Profile\node_modules\dsh-pet-live2d-desktop-*\bin\dsh-pet-live2d-desktop.exe"
  $found = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $Exe = $found.FullName }
}
if (-not $Exe -or -not (Test-Path $Exe)) {
  Write-Log "pet binary not found (looked under $DshHome\profiles\$Profile); install dsh-pet-live2d first"
  exit 1
}

# The user can park the pet in the page (mode=inline); never fight that choice.
$pref = Join-Path $DshHome 'pet-desktop.json'
if (Test-Path $pref) {
  try {
    $mode = (Get-Content $pref -Raw | ConvertFrom-Json).mode
    if ($mode -eq 'inline') {
      Write-Log 'mode=inline - leaving the pet to the page'
      exit 0
    }
  } catch {
    Write-Log 'pet-desktop.json unreadable; continuing'
  }
}

if (Get-Process -Name 'dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue) {
  exit 0
}

if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
  Write-Log "DSH host is not listening on $Port yet - retrying on the next run"
  exit 0
}

Write-Log "starting the native pet window (--attach http://127.0.0.1:$Port)"
Start-Process -FilePath $Exe -ArgumentList '--attach', "http://127.0.0.1:$Port" -WorkingDirectory (Split-Path $Exe)
Start-Sleep -Seconds $WaitSeconds
$started = Get-Process -Name 'dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue
if ($started) {
  Write-Log ('pet window up, pid ' + $started[0].Id)
} else {
  Write-Log 'the pet window exited immediately'
}
