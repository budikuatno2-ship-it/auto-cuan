@echo off
title Auto-Cuan Scan Menu
color 0A

cd /d "%~dp0\.."

:: Check if .env.local exists
if not exist ".env.local" (
    echo.
    echo  ========================================================
    echo   File .env.local belum ada.
    echo.
    echo   Jalankan SETUP_LOCAL_SCAN_ENV.bat dulu untuk setup
    echo   sekali saja.
    echo.
    echo   File ada di: tools\SETUP_LOCAL_SCAN_ENV.bat
    echo  ========================================================
    echo.
    pause
    exit /b 1
)

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
echo   8. Exit
echo.
echo  ========================================================
echo.
set /p choice="  Pilih nomor (1-8): "

if "%choice%"=="1" goto konglo
if "%choice%"=="2" goto nonkonglo
if "%choice%"=="3" goto swingall
if "%choice%"=="4" goto dt_morning
if "%choice%"=="5" goto dt_midday
if "%choice%"=="6" goto dt_afternoon
if "%choice%"=="7" goto dt_full
if "%choice%"=="8" goto exitapp

echo.
echo   Pilihan tidak valid. Coba lagi.
pause
goto menu

:konglo
node tools/local_scan_runner.js konglo
goto done

:nonkonglo
node tools/local_scan_runner.js nonkonglo
goto done

:swingall
node tools/local_scan_runner.js swing-all
goto done

:dt_morning
node tools/local_scan_runner.js daytrade morning
goto done

:dt_midday
node tools/local_scan_runner.js daytrade midday
goto done

:dt_afternoon
node tools/local_scan_runner.js daytrade afternoon
goto done

:dt_full
node tools/local_scan_runner.js daytrade full
goto done

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
