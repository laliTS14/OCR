<#
  Stops and removes the OCR text service and OCR worker scheduled tasks
  (run as Administrator). A report the worker was processing is re-queued
  automatically after OCR_WORKER_STUCK_MINUTES once a worker runs again.
#>
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this script from an elevated (Administrator) PowerShell.' }

foreach ($name in @('Health360 OCR Worker', 'Health360 OCR Text Service')) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host "$name is not registered."; continue }
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "Removed: $name"
}

# stop any launcher loop first (else it restarts its child), then the
# node / python processes, which outlive the stopped task
$procs = Get-CimInstance Win32_Process
$procs | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'run-worker\.cmd|run-ocr-service\.cmd' } |
    ForEach-Object { Write-Host "Stopping launcher ($($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$procs | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'worker\.js') -or
                        ($_.Name -eq 'python.exe' -and $_.CommandLine -match 'paddle_text_service\.py') } |
    ForEach-Object { Write-Host "Stopping $($_.Name) ($($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
