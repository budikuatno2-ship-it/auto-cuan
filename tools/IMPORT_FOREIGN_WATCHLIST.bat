@echo off
setlocal
cd /d "%~dp0\.."
node tools\import-foreign-watchlist.js %*
endlocal
