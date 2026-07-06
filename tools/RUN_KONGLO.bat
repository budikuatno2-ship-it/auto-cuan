@echo off
title Auto-Cuan - Run Konglo Screener
cd /d "%~dp0\.."
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 konglo
pause
