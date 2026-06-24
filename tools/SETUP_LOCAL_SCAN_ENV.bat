@echo off
title Auto-Cuan - Setup Local Scan Environment
color 0E

echo.
echo  ========================================================
echo        AUTO-CUAN: SETUP LOCAL SCAN ENVIRONMENT
echo  ========================================================
echo.
echo  Setup ini hanya perlu dilakukan SEKALI.
echo  Setelah selesai, cukup double-click AUTO_CUAN_SCAN_MENU.bat.
echo.
echo  ========================================================
echo.

cd /d "%~dp0\.."

:: Check if .env.local already exists
if exist ".env.local" (
    echo  [OK] File .env.local sudah ada.
    echo.
    echo  Setup sudah selesai sebelumnya.
    echo  Kamu bisa langsung double-click AUTO_CUAN_SCAN_MENU.bat.
    echo.
    pause
    exit /b 0
)

echo  File .env.local belum ada. Mari buat sekarang.
echo.
echo  --------------------------------------------------------
echo  OPSI 1: Pull otomatis dari Vercel (recommended)
echo  --------------------------------------------------------
echo.
echo  Jika kamu sudah login Vercel CLI, env bisa di-pull otomatis.
echo  Command: npx vercel env pull .env.local --environment=preview
echo.
set /p pullChoice="  Coba pull dari Vercel? (y/n): "

if /i "%pullChoice%"=="y" (
    echo.
    echo  Menjalankan: npx vercel env pull .env.local --environment=preview
    echo.
    npx vercel env pull .env.local --environment=preview
    echo.
    if exist ".env.local" (
        echo  [OK] .env.local berhasil dibuat dari Vercel!
        echo.
        echo  Setup selesai. Double-click AUTO_CUAN_SCAN_MENU.bat untuk scan.
        echo.
        pause
        exit /b 0
    ) else (
        echo  [GAGAL] Pull dari Vercel tidak berhasil.
        echo  Mungkin Vercel CLI belum terinstall atau belum login.
        echo.
        echo  Install Vercel CLI: npm i -g vercel
        echo  Login: vercel login
        echo  Link project: vercel link
        echo  Lalu coba lagi.
        echo.
    )
)

echo.
echo  --------------------------------------------------------
echo  OPSI 2: Buat .env.local secara manual
echo  --------------------------------------------------------
echo.
echo  Buat file .env.local di ROOT project (folder auto-cuan)
echo  dengan isi:
echo.
echo    SUPABASE_URL=https://your-project.supabase.co
echo    SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
echo    CRON_SECRET=your-cron-secret
echo.
echo  Nilai bisa dicopy dari:
echo    - Vercel Dashboard ^> Project ^> Settings ^> Environment Variables
echo    - Supabase Dashboard ^> Settings ^> API
echo.
echo  JANGAN share file .env.local ke siapapun.
echo  JANGAN commit ke git.
echo.
echo  ========================================================
echo.
echo  Setelah .env.local dibuat, double-click AUTO_CUAN_SCAN_MENU.bat.
echo.
pause
exit /b 0
