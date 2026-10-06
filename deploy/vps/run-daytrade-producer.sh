#!/usr/bin/env bash
# DayTrade intraday producer — VPS local only.
#
# Runs the canonical FAST DayTrade producer during live IDX sessions, defers
# public stock-signal delivery to FastWatcher, then refreshes screener-latest.
# The Node runner itself fail-closes outside live sessions, so a simple 15-minute
# cron cadence is safe across lunch breaks / Friday schedule / exchange holidays.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
LOCK_FILE="$RUNNER_DIR/state/daytrade-producer.lock"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/load-env.sh
source "$SCRIPT_DIR/lib/load-env.sh"
load_auto_cuan_env "$REPO" "$RUNNER_DIR"
require_nonempty_env "CRON_SECRET" "${CRON_SECRET:-}"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || echo "")"
fi

[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  echo "NODE_NOT_EXECUTABLE=$NODE_BIN"
  exit 1
}

cd "$REPO"

MODE="--dry-run"
for arg in "$@"; do
  [ "$arg" = "--execute" ] && MODE="--execute"
  [ "$arg" = "--dry-run" ] && MODE="--dry-run"
done

echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] DayTrade intraday producer $MODE"

# Single-flight: a slow scan may overlap the next 15-minute cron tick; the next
# tick must exit cleanly rather than start a second heavy universe scan.
if ! /usr/bin/flock -n "$LOCK_FILE"   "$NODE_BIN" tools/run-daytrade-intraday-producer.js "$MODE"; then
  rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "DAYTRADE_PRODUCER_SKIPPED_OR_FAILED rc=$rc"
  fi
  exit "$rc"
fi
