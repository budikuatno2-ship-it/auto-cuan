#!/usr/bin/env bash
set -uo pipefail
cd /home/ubuntu/auto-cuan || exit 1
echo "now=$(date '+%H:%M:%S')"
echo "--- processes ---"
ps -eo pid,etime,cmd | grep -E 'run-daily-market-update|run-daily-broker-update' | grep -v grep || echo "NO_PROCESS"
echo "--- output file ---"
ls -la /tmp/j1_verify.txt 2>/dev/null || echo "NO_OUTPUT_FILE"
echo "--- tail ---"
tail -8 /tmp/j1_verify.txt 2>/dev/null || true
echo "--- quota ---"
cat data/arjum-data/_quota-state/usage.json
