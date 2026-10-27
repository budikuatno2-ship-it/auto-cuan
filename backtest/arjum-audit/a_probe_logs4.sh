#!/usr/bin/env bash
# READ-ONLY probe A2d: J1 20-22 Okt (baris bertanggal + konteks).
set -uo pipefail
L=/home/ubuntu/auto-cuan-runner/logs/daily-market-update.log

echo "== jumlah baris total =="
wc -l $L

echo
echo "== baris yang memuat 2026-10-20/21/22 (30 terakhir) =="
grep -n -E "2026-10-(20|21|22)" $L | tail -30

echo
echo "== 60 baris terakhir =="
tail -60 $L

echo
echo "== pola penanda hari (10 terakhir) =="
grep -n -E "^\[20[0-9]{2}-|^\[[A-Z-]+ [0-9]{2}:[0-9]{2}:[0-9]{2}|WIB\]" $L | tail -20
