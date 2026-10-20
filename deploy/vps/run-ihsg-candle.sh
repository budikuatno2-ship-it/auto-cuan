#!/usr/bin/env bash
# B5 (2026-10-20): standalone IHSG benchmark fetch (1 Arjum request/day).
#
# The IHSG bar is the anchor for market-regime / breadth, so it must not depend
# on the 962-stock candle pass (which can bail out on a failed cross-check).
# This job runs on its own schedule and alerts when today's bar is still
# missing at/after 17:30 WIB.
set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/fetch-ihsg-candle.js"
LOCK_FILE="$RUNNER_DIR/state/ihsg-candle.lock"
LOG_FILE="${AUTO_CUAN_IHSG_LOG:-$RUNNER_DIR/logs/ihsg-candle.log}"

export TZ=Asia/Jakarta
mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"
mkdir -p "$(dirname "$LOG_FILE")"

stamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }
log() { echo "[$(stamp)] [J2-IHSG] $*" >> "$LOG_FILE"; }

if [ -f "$RUNNER_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$RUNNER_DIR/.env"
  set +a
fi

if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node || echo "")"; fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  log "ABORT NODE_NOT_EXECUTABLE=${NODE_BIN:-<empty>}"
  exit 1
fi
if [ ! -f "$RUNNER_JS" ]; then
  log "ABORT RUNNER_NOT_FOUND=$RUNNER_JS"
  exit 1
fi

log "START argv=$*"
cd "$REPO"

set +e
/usr/bin/flock -n "$LOCK_FILE" "$NODE_BIN" "$RUNNER_JS" "$@"
RC=$?
set -e

if [ "$RC" -eq 1 ]; then
  log "SKIP lock busy (another IHSG run is active). rc=$RC"
else
  log "END rc=$RC"
fi

exit "$RC"