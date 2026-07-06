@echo off
title Auto-Cuan - Day Trade Full (Auto Waktu)
cd /d "%~dp0\.."
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade auto-full
pause
