@echo off
rem Keeps the OCR text service (paddle_text_service.py, RapidOCR) running:
rem restarts it 10 s after it exits or crashes. Started at boot by the
rem "Health360 OCR Text Service" scheduled task (deploy\install-tasks.ps1);
rem can also be run by hand. Log: logs\service\ocr-service.log
setlocal
cd /d "%~dp0.."
if not exist logs\service mkdir logs\service
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
if "%OCR_ENGINE%"=="" set OCR_ENGINE=rapid
set VENV=.venv-rapid
if /i "%OCR_ENGINE%"=="paddle" set VENV=.venv

:loop
echo [%date% %time%] starting paddle_text_service.py (OCR_ENGINE=%OCR_ENGINE%)>> logs\service\ocr-service.log
"%VENV%\Scripts\python.exe" paddle_text_service.py >> logs\service\ocr-service.log 2>&1
echo [%date% %time%] paddle_text_service.py exited with code %errorlevel% - restarting in 10 s>> logs\service\ocr-service.log
timeout /t 10 /nobreak > nul
goto loop
