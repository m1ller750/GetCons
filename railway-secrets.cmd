@echo off
rem Double-click: copies the secret keys from .env to Railway (values are never printed).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\railway-secrets.ps1"
echo.
pause
