@echo off
title Auto-Cuan - Day Trade Morning (Fast)
cd /d "%~dp0\.."
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade morning-fast
pause
