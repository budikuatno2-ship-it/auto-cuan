#!/usr/bin/env bash
# One durable EOD queue for broker summary, accumulation, insiders and OHLCV.
set -euo pipefail
REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
export TZ=Asia/Jakarta
mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"
if [ -f "$RUNNER_DIR/.env" ]; then
  set -a
  source "$RUNNER_DIR/.env"
  set +a
fi
if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node)"; fi
cd "$REPO"
exec /usr/bin/flock -n "$RUNNER_DIR/state/daily-market-update.lock" "$NODE_BIN" tools/run-daily-market-update.js "$@"
