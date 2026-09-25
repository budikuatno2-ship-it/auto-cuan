#!/usr/bin/env bash
# FastWatcher Live — 4 Pilar (Bagian 3: Jadwal Live Bursa 09:00-16:00 WIB)
# Scanner live volume spike / momentum ticker per menit.
# Dijalankan setiap 5 menit selama jam bursa aktif untuk menangkap spike volume mendadak.
#
# Crontab (WIB, CRON_TZ=Asia/Jakarta):
#   */5 9-15 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-fastwatcher.sh --send >> /home/ubuntu/auto-cuan-runner/logs/fastwatcher.log 2>&1
# Crontab (UTC):
#   */5 2-8 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-fastwatcher.sh --send >> /home/ubuntu/auto-cuan-runner/logs/fastwatcher.log 2>&1
#
# Defaults to dry-run when no arguments are provided.
# --send broadcasts via Telegram (skip_market_guard=true for screener card).

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
LOCK_FILE="$RUNNER_DIR/state/fastwatcher.lock"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || echo "")"
fi

[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  echo "NODE_NOT_EXECUTABLE=$NODE_BIN"
  exit 1
}

cd "$REPO"

SEND_FLAG=""
for arg in "$@"; do
  [ "$arg" = "--send" ] && SEND_FLAG="--send"
  [ "$arg" = "--dry-run" ] && SEND_FLAG="--dry-run"
done

# Default to dry-run if no flag
if [ -z "$SEND_FLAG" ]; then
  SEND_FLAG="--dry-run"
fi

echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] FastWatcher live — mode=fastwatcher $SEND_FLAG"

exec /usr/bin/flock -n "$LOCK_FILE" \
  "$NODE_BIN" tools/run-screener.js --mode=fastwatcher "$SEND_FLAG"
