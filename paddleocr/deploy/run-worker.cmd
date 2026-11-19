@echo off
rem Keeps the OCR worker (worker.js) running: restarts it 10 s after it exits
rem or crashes. Started at boot by the "Health360 OCR Worker" scheduled task
rem (deploy\install-tasks.ps1); can also be run by hand. Settings come from
rem ..\.env (OCR_API_URL, OCR_API_KEY, ...). Log: logs\service\worker.log
setlocal
cd /d "%~dp0.."
if not exist logs\service mkdir logs\service

:loop
echo [%date% %time%] starting worker.js>> logs\service\worker.log
node worker.js >> logs\service\worker.log 2>&1
echo [%date% %time%] worker.js exited with code %errorlevel% - restarting in 10 s>> logs\service\worker.log
timeout /t 10 /nobreak > nul
goto loop
