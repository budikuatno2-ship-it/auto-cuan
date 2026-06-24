@echo off
title Auto-Cuan - Run Non-Konglo Screener
echo.
echo  ========================================
echo   Auto-Cuan: Non-Konglo Swing Screener
echo  ========================================
echo.
cd /d "%~dp0\.."
node tools/local_scan_runner.js nonkonglo
echo.
pause
