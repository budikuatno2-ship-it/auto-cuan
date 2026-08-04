#!/usr/bin/env bash
set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/run-telegram-monitor-local.js"
LOCK_FILE="$RUNNER_DIR/state/telegram-monitor-local.lock"

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

[ -x "$NODE_BIN" ] || {
  echo "NODE_NOT_EXECUTABLE=$NODE_BIN"
  exit 1
}

[ -f "$RUNNER_JS" ] || {
  echo "RUNNER_NOT_FOUND=$RUNNER_JS"
  exit 1
}

cd "$REPO"

# Live mode remains fail-closed inside the Node runner unless this exact
# production approval flag is present in the environment.
exec /usr/bin/flock -n "$LOCK_FILE" \
  "$NODE_BIN" "$RUNNER_JS" "$@"
