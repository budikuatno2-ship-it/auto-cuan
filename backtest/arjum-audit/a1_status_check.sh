#!/usr/bin/env bash
# A1 evidence: current status codes for representative /data/ paths, origin-only.
# Prints only HTTP status codes. No file content is downloaded to disk.
set -uo pipefail
cd /home/ubuntu/auto-cuan || exit 1

CANDLE=$(ls data/daily-candles/*.json 2>/dev/null | head -1)
BROKSUM=$(ls data/broker-hunter-indexes/*-7d.json 2>/dev/null | head -1)
LEGIT="/data/bandarmologi-intel-indexes/latest_7d.json"
CANDLE_URL="/data/${CANDLE#data/}"
BROKSUM_URL="/data/${BROKSUM#data/}"

code() { curl -s -o /dev/null -w "%{http_code}" -X HEAD "http://127.0.0.1:3000$1"; }

echo "origin_latest_index=$(code "$LEGIT")"
echo "origin_candle=$(code "$CANDLE_URL")"
echo "origin_broksum=$(code "$BROKSUM_URL")"
echo "sample_candle_path=$CANDLE_URL"
echo "sample_broksum_path=$BROKSUM_URL"
# Control: a path that does not exist, to distinguish 404-because-missing vs 404-because-blocked.
echo "origin_absent=$(code "/data/__does_not_exist_$(date +%s).json")"