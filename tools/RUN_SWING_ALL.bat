@echo off
title Auto-Cuan - Run Swing All
cd /d "%~dp0\.."
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 swing-all
pause
