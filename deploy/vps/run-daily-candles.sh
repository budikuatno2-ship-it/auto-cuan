#!/usr/bin/env bash
# Daily Arjum OHLCV refresh — quota-safe, freshness-aware, VPS wrapper.
#
# J2 writes its OWN log so execution is provable even when the cron redirect is
# absent or misconfigured. Location matches every other job
# (autocuan-runner/logs). AUTO_CUAN_CANDLE_LOG overrides it for tests.
set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/fetch-daily-candles.js"
LOCK_FILE="$RUNNER_DIR/state/daily-candles.lock"
LOG_FILE="${AUTO_CUAN_CANDLE_LOG:-$RUNNER_DIR/logs/daily-candles.log}"

export TZ=Asia/Jakarta
mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"
mkdir -p "$(dirname "$LOG_FILE")"

stamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }
log() { echo "[$(stamp)] [J2-CANDLES] $*" >> "$LOG_FILE"; }

if [ -f "$RUNNER_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$RUNNER_DIR/.env"
  set +a
fi

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || echo "")"
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  log "ABORT NODE_NOT_EXECUTABLE=${NODE_BIN:-<empty>}"
  echo "NODE_NOT_EXECUTABLE=$NODE_BIN"
  exit 1
fi

if [ ! -f "$RUNNER_JS" ]; then
  log "ABORT RUNNER_NOT_FOUND=$RUNNER_JS"
  echo "RUNNER_NOT_FOUND=$RUNNER_JS"
  exit 1
fi

log "START argv=$* lock=$LOCK_FILE"
cd "$REPO"

# flock -n: a concurrent run is a NO-OP (do not corrupt state). Exit code 1 with
# no work is normal when the 16:40 and 23:30 windows overlap.
set +e
/usr/bin/flock -n "$LOCK_FILE" "$NODE_BIN" "$RUNNER_JS" "$@"
RC=$?
set -e

if [ "$RC" -eq 1 ]; then
  log "SKIP lock busy (another J2 run is active). rc=$RC"
else
  log "END rc=$RC"
fi

exit "$RC"
