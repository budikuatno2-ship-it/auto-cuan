@echo off
title Auto-Cuan - Day Trade Midday
echo.
echo  ========================================
echo   Auto-Cuan: Day Trade Screener (Midday)
echo  ========================================
echo.
cd /d "%~dp0\.."
node tools/local_scan_runner.js daytrade midday
echo.
pause
