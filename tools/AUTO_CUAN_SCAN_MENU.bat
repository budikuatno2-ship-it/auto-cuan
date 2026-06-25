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
echo   --- Swing ---
echo   1. Run Konglo
echo   2. Run Non-Konglo
echo   3. Run Swing All (Konglo + Non-Konglo)
echo.
echo   --- Day Trade (Fast Mode - shortlist ~150 liquid) ---
echo   4. Day Trade Morning (Fast)
echo   5. Day Trade Midday (Fast)
echo   6. Day Trade Afternoon (Fast)
echo.
echo   --- Day Trade (Full - all universe) ---
echo   7. Day Trade Morning (Full)
echo   8. Day Trade Midday (Full)
echo   9. Day Trade Afternoon (Full)
echo.
echo   --- Other ---
echo   S. Settings (setup/ubah config)
echo   X. Exit
echo.
echo  ========================================================
echo.
set /p choice="  Pilih (1-9, S, X): "

if "%choice%"=="1" goto konglo
if "%choice%"=="2" goto nonkonglo
if "%choice%"=="3" goto swingall
if "%choice%"=="4" goto dt_morning_fast
if "%choice%"=="5" goto dt_midday_fast
if "%choice%"=="6" goto dt_afternoon_fast
if "%choice%"=="7" goto dt_morning_full
if "%choice%"=="8" goto dt_midday_full
if "%choice%"=="9" goto dt_afternoon_full
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

:dt_morning_fast
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade morning-fast
goto done

:dt_midday_fast
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade midday-fast
goto done

:dt_afternoon_fast
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade afternoon-fast
goto done

:dt_morning_full
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade morning
goto done

:dt_midday_full
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade midday
goto done

:dt_afternoon_full
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade afternoon
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
