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
echo   4. Start Day Trade Fast AUTO LOOP
echo   5. Start Day Trade Full AUTO LOOP
echo   6. Refresh Sektor Hot / Group Hot
echo   7. Refresh All Ringan
echo   8. Import / Upload Foreign Data
echo.
echo   S. Settings (setup/ubah config)
echo   X. Exit
echo.
echo  ========================================================
echo.
set /p choice="  Pilih (1-8, S, X): "

if "%choice%"=="1" goto konglo
if "%choice%"=="2" goto nonkonglo
if "%choice%"=="3" goto swingall
if "%choice%"=="4" goto dt_fast
if "%choice%"=="5" goto dt_full
if "%choice%"=="6" goto sektor
if "%choice%"=="7" goto refreshall
if "%choice%"=="8" goto foreignimport
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
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade-auto fast
goto done

:dt_full
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade-auto full
goto done

:sektor
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 sektor-hot
goto done

:refreshall
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 refresh-all
goto done

:foreignimport
powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 foreign-import
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
