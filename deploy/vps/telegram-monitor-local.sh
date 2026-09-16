#!/usr/bin/env bash
# VPS-Local Telegram Monitor Runner
#
# Recommended crontab schedule on VPS (active market hours: 09:05 - 16:05 WIB, Mon-Fri):
#   */15 9-16 * * 1-5  /home/ubuntu/auto-cuan/deploy/vps/telegram-monitor-local.sh --execute >> /home/ubuntu/auto-cuan-runner/logs/telegram-monitor-local.log 2>&1
#
# Guarantees:
#   - forces TZ=Asia/Jakarta for child process;
#   - non-blocking flock — prevents overlapping invocations;
#   - sets/supports production approval flag for live execution;
#   - fallback to system node if custom path is missing;
#   - logs status clearly without printing credentials.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/run-telegram-monitor-local.js"
LOCK_FILE="$RUNNER_DIR/state/telegram-monitor-local.lock"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

# Fallback to system node if custom path does not exist
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

# Set / support production approval flag for live monitoring runner
export LOCAL_MONITOR_LIVE_APPROVED="${LOCAL_MONITOR_LIVE_APPROVED:-YES}"

# Live mode uses non-blocking flock to avoid overlapping executions
exec /usr/bin/flock -n "$LOCK_FILE" \
  "$NODE_BIN" "$RUNNER_JS" "$@"
