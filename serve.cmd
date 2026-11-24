@echo off
REM Serve device-check locally. WebUSB requires HTTPS or localhost.
cd /d "%~dp0"
python -m http.server 8771
