#!/usr/bin/env bash
# READ-ONLY probe: crontab + lokasi log job harian.
set -uo pipefail

echo "== CRONTAB =="
crontab -l 2>/dev/null

echo
echo "== pm2 list =="
pm2 list 2>/dev/null | head -40
