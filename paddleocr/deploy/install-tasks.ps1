<#
  Registers the OCR text service, the Tesseract text service (double OCR)
  and the OCR worker to start at boot
  (Windows Task Scheduler, run as SYSTEM, no login needed). Run as
  Administrator on the OCR server, after:
    - paddleocr\.venv-rapid is set up (see README.md, "OCR service")
    - npm install in paddleocr
    - paddleocr\.env has OCR_API_URL / OCR_API_KEY for the installed OCR API
      (backend\Health_360_OCR\deploy\install-service.ps1)
    - for double OCR only: Tesseract installed (UB Mannheim build) and
      ..\tesseract-ocr\.venv set up (tesseract-ocr\README.md). Without that
      venv the Tesseract task is skipped and double OCR reports save their
      Tesseract result as FAILED (the RapidOCR result is unaffected).

    .\deploy\install-tasks.ps1            # register all, start them now
    .\deploy\install-tasks.ps1 -NoStart   # register only (start at next boot)

  Each task runs a deploy\run-*.cmd launcher that restarts its process if it
  exits; logs go to paddleocr\logs\service\. The worker task starts 1 minute
  after boot so the API and the OCR service are up first (the worker also
  just retries if they aren't). Re-running replaces the tasks.
#>
param([switch]$NoStart)
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this script from an elevated (Administrator) PowerShell.' }

$appDir = Split-Path -Parent $PSScriptRoot       # ...\OCR\paddleocr
foreach ($required in @('.env', '.venv-rapid\Scripts\python.exe', 'node_modules')) {
    if (-not (Test-Path (Join-Path $appDir $required))) { throw "Missing $required in $appDir - see the notes at the top of this script." }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is not on PATH.' }

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
# no time limit; if the launcher itself ever dies, Task Scheduler restarts it
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

$tasks = @(
    @{ Name = 'Health360 OCR Text Service'; Script = 'run-ocr-service.cmd'; Delay = $null;
       Description = 'RapidOCR text service (paddle_text_service.py, port 8794) for the OCR worker.' },
    @{ Name = 'Health360 OCR Tesseract Service'; Script = 'run-tesseract-service.cmd'; Delay = $null;
       Requires = '..\tesseract-ocr\.venv\Scripts\python.exe';
       Description = 'Tesseract text service (tesseract-ocr\tesseract_text_service.py, port 8799): second engine for double OCR.' },
    @{ Name = 'Health360 OCR Worker'; Script = 'run-worker.cmd'; Delay = 'PT1M';
       Description = 'OCR worker (worker.js): claims queued pathology reports, extracts them, saves via the OCR API.' }
)

foreach ($t in $tasks) {
    if ($t.Requires -and -not (Test-Path (Join-Path $appDir $t.Requires))) {
        Write-Host "Skipped: $($t.Name) - missing $($t.Requires)"
        continue
    }
    $cmd = Join-Path $PSScriptRoot $t.Script
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`"" -WorkingDirectory $appDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    if ($t.Delay) { $trigger.Delay = $t.Delay }
    Register-ScheduledTask -TaskName $t.Name -Description $t.Description -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "Registered: $($t.Name)"
    if (-not $NoStart) { Start-ScheduledTask -TaskName $t.Name; Write-Host "  started" }
}

Write-Host ''
Write-Host "Logs: $appDir\logs\service\ (ocr-service.log, tesseract-service.log, worker.log)"
Write-Host "Status: Get-ScheduledTask -TaskName 'Health360 OCR*' | Select TaskName, State"
