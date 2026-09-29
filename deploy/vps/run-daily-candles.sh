#!/usr/bin/env bash
# Daily Arjum OHLCV refresh — quota-safe, freshness-aware, VPS wrapper.
set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/fetch-daily-candles.js"
LOCK_FILE="$RUNNER_DIR/state/daily-candles.lock"

export TZ=Asia/Jakarta
mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

if [ -f "$RUNNER_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$RUNNER_DIR/.env"
  set +a
fi

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || echo "")"
fi

[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  echo "NODE_NOT_EXECUTABLE=$NODE_BIN"
  exit 1
}

[ -f "$RUNNER_JS" ] || {
  echo "RUNNER_NOT_FOUND=$RUNNER_JS"
  exit 1
}

cd "$REPO"

exec /usr/bin/flock -n "$LOCK_FILE" "$NODE_BIN" "$RUNNER_JS" "$@"
