#!/usr/bin/env bash
# Watchdog script: wait for catchup-missing-dates.js to finish,
# then immediately launch backfill-broksum.js to burn remaining Sunday quota.

LOG="/home/ubuntu/auto-cuan-runner/logs/sunday-chain.log"
mkdir -p /home/ubuntu/auto-cuan-runner/logs

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Watcher started. Waiting for catchup-missing-dates.js to complete..." >> "$LOG"

while ps aux | grep -v grep | grep "catchup-missing-dates.js" > /dev/null; do
  sleep 10
done

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Catchup complete! Starting backfill-broksum.js --mode=weekend to burn remaining Sunday quota..." >> "$LOG"
/home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/backfill-broksum.js --mode=weekend >> /home/ubuntu/auto-cuan-runner/logs/backfill-broksum.log 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] backfill-broksum.js finished or limited." >> "$LOG"
