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
echo   4. Run Day Trade Morning
echo   5. Run Day Trade Midday
echo   6. Run Day Trade Afternoon
echo   7. Run Day Trade Full
echo   8. Settings (setup/ubah config)
echo   9. Exit
echo.
echo  ========================================================
echo.
set /p choice="  Pilih nomor (1-9): "

if "%choice%"=="1" goto konglo
if "%choice%"=="2" goto nonkonglo
if "%choice%"=="3" goto swingall
if "%choice%"=="4" goto dt_morning
if "%choice%"=="5" goto dt_midday
if "%choice%"=="6" goto dt_afternoon
if "%choice%"=="7" goto dt_full
if "%choice%"=="8" goto settings
if "%choice%"=="9" goto exitapp

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

:dt_morning
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade morning
goto done

:dt_midday
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade midday
goto done

:dt_afternoon
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade afternoon
goto done

:dt_full
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade full
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
