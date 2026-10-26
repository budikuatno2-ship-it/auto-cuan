#!/usr/bin/env bash
# READ-ONLY probe A1: lokasi marker, quota tracker, log job harian.
set -uo pipefail
cd /home/ubuntu/auto-cuan || exit 1

echo "== data/arjum-data subdirs =="
ls -1 data/arjum-data 2>/dev/null

echo "== cari marker =="
find /home/ubuntu -maxdepth 5 -type d -name "_daily-update-marker" 2>/dev/null | head -5
find /home/ubuntu -maxdepth 6 -name "*daily-update-marker*" -maxdepth 6 2>/dev/null | head -10

echo "== cari state.json / quota tracker =="
find /home/ubuntu -maxdepth 5 -name "state.json" 2>/dev/null | head -10
find /home/ubuntu -maxdepth 5 -name "*quota*" 2>/dev/null | head -20

echo "== log job harian (runner) =="
ls -1 /home/ubuntu/auto-cuan-runner/*.log 2>/dev/null | head -60
