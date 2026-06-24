@echo off
title Auto-Cuan - Run Konglo Screener
echo.
echo  ========================================
echo   Auto-Cuan: Konglo Swing Screener
echo  ========================================
echo.
cd /d "%~dp0\.."
node tools/local_scan_runner.js konglo
echo.
pause
