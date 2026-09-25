#!/usr/bin/env bash
# Swing Non-Konglomerat — 4 Pilar (Bagian 3: Jadwal EOD 19:30 WIB / 12:30 UTC)
# Filter saham swing untuk emiten potensial di luar konglomerasi (UTAMA/PENGEMBANGAN ex-konglo).
# Dijalankan pukul 19:30 WIB setelah Swing Konglo selesai.
#
# Crontab (WIB, CRON_TZ=Asia/Jakarta):
#   30 19 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-swing-non-konglo.sh --send >> /home/ubuntu/auto-cuan-runner/logs/swing-non-konglo.log 2>&1
# Crontab (UTC):
#   30 12 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-swing-non-konglo.sh --send >> /home/ubuntu/auto-cuan-runner/logs/swing-non-konglo.log 2>&1
#
# Defaults to dry-run when no arguments are provided.
# --send broadcasts via Telegram (skip_market_guard=true for screener card).

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
LOCK_FILE="$RUNNER_DIR/state/swing-non-konglo.lock"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

# Load environment files (runner-level first, then repo-level overrides like .env.local)
for env_file in "$RUNNER_DIR/.env" "$REPO/.env" "$REPO/.env.intraday-runtime" "$REPO/.env.local"; do
  if [ -f "$env_file" ]; then
    set -a
    source "$env_file" 2>/dev/null || true
    set +a
  fi
done

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

if [ -z "$SEND_FLAG" ]; then
  SEND_FLAG="--dry-run"
fi

echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] Swing Non-Konglo — mode=swing-non-konglo $SEND_FLAG"

exec /usr/bin/flock -n "$LOCK_FILE" \
  "$NODE_BIN" tools/run-screener.js --mode=swing-non-konglo "$SEND_FLAG"
