@echo off
title Auto-Cuan - Run Swing All (Konglo + Non-Konglo)
echo.
echo  ========================================
echo   Auto-Cuan: Swing All
echo   (Konglo first, then Non-Konglo)
echo  ========================================
echo.
cd /d "%~dp0\.."
node tools/local_scan_runner.js swing-all
echo.
pause
