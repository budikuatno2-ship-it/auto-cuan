@echo off
title Auto-Cuan - Day Trade Afternoon
cd /d "%~dp0\.."
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade afternoon
pause
