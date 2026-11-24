@echo off
REM Serve lifyt_device_diag locally. WebUSB requires HTTPS or localhost.
cd /d "%~dp0"
python -m http.server 8771
