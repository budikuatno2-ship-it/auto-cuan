#!/usr/bin/env bash
# READ-ONLY probe A2: hasil job harian 20-22 Okt (log runner).
set -uo pipefail
L=/home/ubuntu/auto-cuan-runner/logs

echo "== daftar log =="
ls -la $L 2>/dev/null | grep -E "daily-market-update|backfill-broksum|daily-candles|ihsg-candle|backfill-candles" || true

echo
echo "== daily-market-update.log : baris kunci (Status/SKIP/exit/ERROR) =="
grep -n -E "Status:|SKIPPED_ARJUM_BUSY|CIRCUIT|EKSPEKTASI|exit|DONE|GAGAL|BERHASIL" $L/daily-market-update.log 2>/dev/null | tail -80

echo
echo "== daily-market-update.log : 30 baris terakhir =="
tail -30 $L/daily-market-update.log 2>/dev/null
