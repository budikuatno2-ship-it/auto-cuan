#!/usr/bin/env bash
# B1 (2026-10-22) — Broker Hunter index builder (scheduled).
#
# The broker-hunter index files under data/broker-hunter-indexes/ are what the
# Broker Hunter page reads. There was NO cron entry for this builder, so the
# index went stale from 12 Sep: the page kept serving an old snapshot with no
# job to refresh it. This wrapper runs the builder once per trading day at 22:45
# WIB — after J1's EOD broker-summary write has settled — so the index tracks the
# freshest local broker summaries. It reads local disk only (no Arjum quota).
#
# AUTO_CUAN_HUNTER_LOG overrides the log path for tests.
set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/run-broker-hunter-indexer.js"
LOCK_FILE="$RUNNER_DIR/state/broker-hunter-indexer.lock"
LOG_FILE="${AUTO_CUAN_HUNTER_LOG:-$RUNNER_DIR/logs/broker-hunter-indexer.log}"

export TZ=Asia/Jakarta
mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"
mkdir -p "$(dirname "$LOG_FILE")"

stamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }
log() { echo "[$(stamp)] [HUNTER] $*" >> "$LOG_FILE"; }

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

log "START argv=$* lock=$LOCK_FILE"
cd "$REPO"

set +e
/usr/bin/flock -n "$LOCK_FILE" "$NODE_BIN" "$RUNNER_JS" "$@"
RC=$?
set -e

if [ "$RC" -eq 1 ]; then
  log "SKIP lock busy (another broker-hunter indexing run is active). rc=$RC"
else
  log "END rc=$RC"
fi

exit "$RC"
