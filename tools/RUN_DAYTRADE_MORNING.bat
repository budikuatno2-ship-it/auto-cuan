@echo off
title Auto-Cuan - Day Trade Morning
echo.
echo  ========================================
echo   Auto-Cuan: Day Trade Screener (Morning)
echo  ========================================
echo.
cd /d "%~dp0\.."
node tools/local_scan_runner.js daytrade morning
echo.
pause
