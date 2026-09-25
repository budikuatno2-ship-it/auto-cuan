#!/usr/bin/env bash
# Screener channel dispatch wrapper — sends the Daytrade/Swing/FastWatcher
# cards to the Telegram channel using the repository's own dry-run-capable
# runner (tools/run-screener.js). The runner sets skip_market_guard because a
# screener card is an after-session recap, not an intraday order-book signal.
#
# Usage in VPS crontab (WIB):
#   45 19 * * 1-5  /home/ubuntu/auto-cuan/deploy/vps/run-screener-dispatch.sh --send >> /home/ubuntu/auto-cuan-runner/logs/screener-dispatch.log 2>&1
#
# Defaults to dry-run when no arguments are provided.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
LOCK_FILE="$RUNNER_DIR/state/screener-dispatch.lock"

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
done

# Diagnostic line first (always safe, never sends).
exec /usr/bin/flock -n "$LOCK_FILE" bash -c '
  "$0" tools/run-screener.js --mode=daytrade --dry-run || true
  "$0" tools/run-screener.js --mode=swing --dry-run || true
  "$0" tools/run-screener.js --mode=fastwatcher --dry-run || true
  if [ "$1" = "--send" ]; then
    "$0" tools/run-screener.js --mode=daytrade --send || true
    "$0" tools/run-screener.js --mode=swing --send || true
  fi
' "$NODE_BIN" "$SEND_FLAG"
