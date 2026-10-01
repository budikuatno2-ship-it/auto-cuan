#!/usr/bin/env bash
# Install ONLY the canonical EOD market-data schedule.
# Does not touch unrelated cron jobs (including webhook/sector jobs).
set -euo pipefail

RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
BACKUP_DIR="$RUNNER_DIR/backup"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
CURRENT="$(mktemp)"
WORK="$(mktemp)"
trap 'rm -f "$CURRENT" "$WORK"' EXIT

crontab -l > "$CURRENT" 2>/dev/null || true
cp "$CURRENT" "$BACKUP_DIR/crontab-before-eod-$STAMP.bak"

# Remove superseded standalone broker/candle entries only.
grep -v -E 'run-daily-broker-update\.sh|run-daily-candles\.sh|run-eod-market-data\.sh' "$CURRENT" > "$WORK" || true

# Ensure timezone is explicitly pinned for all Auto-Cuan wall-clock schedules.
if ! grep -q '^CRON_TZ=Asia/Jakarta$' "$WORK"; then
  {
    echo 'CRON_TZ=Asia/Jakarta'
    cat "$WORK"
  } > "$WORK.tz"
  mv "$WORK.tz" "$WORK"
fi

cat >> "$WORK" <<'EOF'

# Auto-Cuan canonical EOD market-data bundle (WIB)
# broker summary + accumulation + insiders + candle/volume; retries hourly
0 18-23 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-eod-market-data.sh >> /home/ubuntu/auto-cuan-runner/logs/eod-market-data.log 2>&1
EOF

crontab "$WORK"

echo "Backup: $BACKUP_DIR/crontab-before-eod-$STAMP.bak"
echo "Installed EOD schedule:"
crontab -l | grep -E 'CRON_TZ=Asia/Jakarta|run-eod-market-data\.sh'
