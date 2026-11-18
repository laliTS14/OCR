@echo off
rem Keeps the Tesseract text service (..\tesseract-ocr\tesseract_text_service.py,
rem port 8799) running: restarts it 10 s after it exits or crashes. Only
rem double OCR uses it (OCR_DOUBLE_ENABLED=true + a report's double_ocr = 1).
rem Started at boot by the "Health360 OCR Tesseract Service" scheduled task
rem (deploy\install-tasks.ps1); can also be run by hand.
rem Log: logs\service\tesseract-service.log (in paddleocr\)
setlocal
cd /d "%~dp0.."
if not exist logs\service mkdir logs\service
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
set LOG=%CD%\logs\service\tesseract-service.log
cd /d ..\tesseract-ocr

:loop
echo [%date% %time%] starting tesseract_text_service.py>> "%LOG%"
.venv\Scripts\python.exe tesseract_text_service.py >> "%LOG%" 2>&1
echo [%date% %time%] tesseract_text_service.py exited with code %errorlevel% - restarting in 10 s>> "%LOG%"
timeout /t 10 /nobreak > nul
goto loop
