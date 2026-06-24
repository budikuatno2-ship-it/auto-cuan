@echo off
title Auto-Cuan - Day Trade Full Scan
echo.
echo  ========================================
echo   Auto-Cuan: Day Trade Screener (Full)
echo  ========================================
echo.
cd /d "%~dp0\.."
node tools/local_scan_runner.js daytrade full
echo.
pause
