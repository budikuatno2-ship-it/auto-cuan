#!/usr/bin/env bash
# Screener channel dispatch wrapper — 4 Pilar (Daytrade, FastWatcher, Swing Konglo, Swing Non-Konglo)
# Sends the screener cards to the Telegram channel using the repository's own dry-run-capable
# runner (tools/run-screener.js). The runner sets skip_market_guard because a
# screener card is an after-session recap, not an intraday order-book signal.
#
# Usage in VPS crontab (WIB):
#   45 19 * * 1-5  /home/ubuntu/auto-cuan/deploy/vps/run-screener-dispatch.sh --send >> /home/ubuntu/auto-cuan-runner/logs/screener-dispatch.log 2>&1
#   45 12 * * 1-5  /home/ubuntu/auto-cuan/deploy/vps/run-screener-dispatch.sh --send >> /home/ubuntu/auto-cuan-runner/logs/screener-dispatch.log 2>&1  # EOD 19:45 WIB
#
# Defaults to dry-run when no arguments are provided.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
LOCK_FILE="$RUNNER_DIR/state/screener-dispatch.lock"

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
done

# Diagnostic line first (always safe, never sends) — 4 pilar dry-run.
exec /usr/bin/flock -n "$LOCK_FILE" bash -c '
  echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] === SCREENER DISPATCH DRY-RUN (4 PILAR) ==="
  "$0" tools/run-screener.js --mode=daytrade --dry-run || true
  echo "---"
  "$0" tools/run-screener.js --mode=fastwatcher --dry-run || true
  echo "---"
  "$0" tools/run-screener.js --mode=swing-konglo --dry-run || true
  echo "---"
  "$0" tools/run-screener.js --mode=swing-non-konglo --dry-run || true
  if [ "$1" = "--send" ]; then
    echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] === SCREENER DISPATCH SEND (4 PILAR, skip_market_guard=true) ==="
    "$0" tools/run-screener.js --mode=daytrade --send || true
    echo "---"
    "$0" tools/run-screener.js --mode=fastwatcher --send || true
    echo "---"
    "$0" tools/run-screener.js --mode=swing-konglo --send || true
    echo "---"
    "$0" tools/run-screener.js --mode=swing-non-konglo --send || true
  fi
' "$NODE_BIN" "$SEND_FLAG"
