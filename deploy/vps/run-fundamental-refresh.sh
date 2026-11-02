#!/bin/bash
# ============================================================
# AUTO-CUAN VPS - Pilar 5: Fundamental Rolling Refresh
# Run daily at 22:20 WIB via crontab
# ============================================================

set -e

APP_DIR="/home/ubuntu/auto-cuan"
RUNNER_DIR="/home/ubuntu/auto-cuan-runner"
NODE_BIN="/home/ubuntu/.local/node-v22/bin/node"

echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Starting Fundamental Rolling Refresh..."

if [ -f "$RUNNER_DIR/.env" ]; then
  set -a
  source "$RUNNER_DIR/.env"
  set +a
fi

cd "$APP_DIR"
$NODE_BIN tools/run-fundamental-refresh.js --batch=20 --apply >> "$RUNNER_DIR/logs/fundamental.log" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Fundamental Rolling Refresh completed."
