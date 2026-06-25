@echo off
title Auto-Cuan Scan Menu
color 0A
cd /d "%~dp0\.."

:menu
cls
echo.
echo  ========================================================
echo            AUTO-CUAN SCAN MENU
echo  ========================================================
echo.
echo   1. Run Konglo
echo   2. Run Non-Konglo
echo   3. Run Swing All (Konglo + Non-Konglo)
echo   4. Run Day Trade Fast (Auto Waktu)
echo   5. Run Day Trade Full (Auto Waktu)
echo.
echo   S. Settings (setup/ubah config)
echo   X. Exit
echo.
echo  ========================================================
echo.
set /p choice="  Pilih (1-5, S, X): "

if "%choice%"=="1" goto konglo
if "%choice%"=="2" goto nonkonglo
if "%choice%"=="3" goto swingall
if "%choice%"=="4" goto dt_fast
if "%choice%"=="5" goto dt_full
if /i "%choice%"=="s" goto settings
if /i "%choice%"=="x" goto exitapp

echo.
echo   Pilihan tidak valid. Coba lagi.
pause
goto menu

:konglo
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 konglo
goto done

:nonkonglo
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 nonkonglo
goto done

:swingall
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 swing-all
goto done

:dt_fast
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade auto-fast
goto done

:dt_full
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade auto-full
goto done

:settings
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 setup
pause
goto menu

:done
echo.
echo  ========================================================
echo.
set /p again="  Kembali ke menu? (y/n): "
if /i "%again%"=="y" goto menu
goto exitapp

:exitapp
echo.
echo   Bye!
exit /b 0
