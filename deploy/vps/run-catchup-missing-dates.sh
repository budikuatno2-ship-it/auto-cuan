#!/usr/bin/env bash
# C (2026-10-23) — catch up the broker-summary dates J1 missed.
#
# Runs on the weekend (no J1/J2), newest date first, batch 50, and stops if more
# than 20% of a batch fails. The budget guard keeps a small web+retry reserve
# (max 1,500) on weekends. AUTO_CUAN_CATCHUP_LOG overrides the log path.
set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/catchup-missing-dates.js"
LOCK_FILE="$RUNNER_DIR/state/catchup-missing-dates.lock"
LOG_FILE="${AUTO_CUAN_CATCHUP_LOG:-$RUNNER_DIR/logs/catchup-missing-dates.log}"

export TZ=Asia/Jakarta
mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"
mkdir -p "$(dirname "$LOG_FILE")"

stamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }
log() { echo "[$(stamp)] [CATCHUP] $*" >> "$LOG_FILE"; }

if [ -f "$RUNNER_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$RUNNER_DIR/.env"
  set +a
fi

if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node || echo "")"; fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  log "ABORT NODE_NOT_EXECUTABLE"
  exit 1
fi
if [ ! -f "$RUNNER_JS" ]; then
  log "ABORT RUNNER_NOT_FOUND=$RUNNER_JS"
  exit 1
fi

log "START argv=$*"
cd "$REPO"

set +e
/usr/bin/flock -n "$LOCK_FILE" "$NODE_BIN" "$RUNNER_JS" "$@" >> "$LOG_FILE" 2>&1
RC=$?
set -e

log "END rc=$RC"
exit "$RC"
