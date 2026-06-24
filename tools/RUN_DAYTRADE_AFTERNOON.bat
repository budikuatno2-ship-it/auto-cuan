@echo off
title Auto-Cuan - Day Trade Afternoon
echo.
echo  ========================================
echo   Auto-Cuan: Day Trade Screener (Afternoon)
echo  ========================================
echo.
cd /d "%~dp0\.."
node tools/local_scan_runner.js daytrade afternoon
echo.
pause
