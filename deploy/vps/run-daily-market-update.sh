#!/usr/bin/env bash
# One durable EOD queue for broker summary, accumulation, insiders and OHLCV.
set -euo pipefail
REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
export TZ=Asia/Jakarta
mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

# Environment precedence & canonical VPS market routing (BUG-RT-02 / BUG-3C-03)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/load-env.sh
source "$SCRIPT_DIR/lib/load-env.sh"
load_auto_cuan_env "$REPO" "$RUNNER_DIR"
export AUTO_CUAN_MARKET_DATA_VPS="${AUTO_CUAN_MARKET_DATA_VPS:-1}"

if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node)"; fi
cd "$REPO"
exec /usr/bin/flock -n "$RUNNER_DIR/state/daily-market-update.lock" "$NODE_BIN" tools/run-daily-market-update.js "$@"
