#!/usr/bin/env bash
# READ-ONLY probe: layout data di VPS (tanpa isi file).
set -uo pipefail
cd /home/ubuntu/auto-cuan || exit 1

echo "== branch/head =="
git rev-parse --abbrev-ref HEAD
git log --oneline -1

echo "== data dirs =="
for d in data data/arjum-data data/broker-summary data/broker-summary-F data/broker-accumulation data/insiders data/daily-candles data/broker-hunter-indexes data/bandarmologi-intel-indexes; do
  if [ -d "$d" ]; then
    echo "DIR $d count=$(ls -1 "$d" 2>/dev/null | wc -l)"
  else
    echo "DIR $d MISSING"
  fi
done

echo "== sample ticker dir =="
find data -maxdepth 4 -type d -name "BBCA" 2>/dev/null | head -5

echo "== marker dir =="
ls -1 data/_daily-update-marker 2>/dev/null | head -20
echo "-- quarantine --"
ls -1 data/_daily-update-marker/_quarantine 2>/dev/null | head -20

echo "== logs =="
ls -1 logs 2>/dev/null | head -40
ls -1 /home/ubuntu/auto-cuan-runner 2>/dev/null | head -40
