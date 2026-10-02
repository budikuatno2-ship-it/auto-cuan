#!/usr/bin/env bash
# Screener channel dispatch wrapper — EOD 3 Pilar (Daytrade, Swing Konglo, Swing Non-Konglo)
# Sends the screener cards to the Telegram channel using the repository's own dry-run-capable
# runner (tools/run-screener.js). The runner sets skip_market_guard because a
# screener card is an after-session recap, not an intraday order-book signal.
#
# BUG-3C-01: FastWatcher is intentionally NOT part of this dispatch. It is owned
# by the dedicated intraday engine (deploy/vps/run-fastwatcher.sh →
# tools/run-intraday-fast-watcher-guarded-live.js), which reads its own
# shortlist file and applies its own market-session windows and kill switches.
# The legacy `run-screener.js --mode=fastwatcher` path read a snapshot key that
# is never produced (always 0 candidates) and was removed from this wrapper.
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

# Environment precedence (BUG-RT-02): repository files first, runner-owned
# runtime env LAST so it deterministically overrides stale repo .env.local.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/load-env.sh
source "$SCRIPT_DIR/lib/load-env.sh"
load_auto_cuan_env "$REPO" "$RUNNER_DIR"

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

# BUG-3C-01: FastWatcher is NOT dispatched from the EOD snapshot. It has a
# dedicated intraday engine (deploy/vps/run-fastwatcher.sh →
# tools/run-intraday-fast-watcher-guarded-live.js) which owns its own
# shortlist, market-session windows and Telegram kill switches. The legacy
# `--mode=fastwatcher` path read a snapshot key that is never produced and
# produced 0 candidates on 100% of runs; it must not be dispatched here.
#
# Diagnostic lines first (always safe, never sends) — 3 EOD pillars dry-run.
exec /usr/bin/flock -n "$LOCK_FILE" bash -c '
  echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] === SCREENER DISPATCH DRY-RUN (EOD 3 PILAR) ==="
  "$0" tools/run-screener.js --mode=daytrade --dry-run || true
  echo "---"
  "$0" tools/run-screener.js --mode=swing-konglo --dry-run || true
  echo "---"
  "$0" tools/run-screener.js --mode=swing-non-konglo --dry-run || true
  if [ "$1" = "--send" ]; then
    echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] === SCREENER DISPATCH SEND (EOD 3 PILAR, skip_market_guard=true) ==="
    "$0" tools/run-screener.js --mode=daytrade --send || true
    echo "---"
    "$0" tools/run-screener.js --mode=swing-konglo --send || true
    echo "---"
    "$0" tools/run-screener.js --mode=swing-non-konglo --send || true
  fi
' "$NODE_BIN" "$SEND_FLAG"
