#!/usr/bin/env bash
# B3 (2026-10-22) — daily H-1 refill backlog age alarm wrapper.
#
# Runs once per day after the EOD window. If the refill backlog is older than 24h
# and not shrinking, it sends ONE Telegram alert and persists the state the Admin
# Console reads. AUTO_CUAN_BACKLOG_LOG overrides the log path for tests.
set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/check-backlog-age.js"
LOG_FILE="${AUTO_CUAN_BACKLOG_LOG:-$RUNNER_DIR/logs/backlog-age-alarm.log}"

export TZ=Asia/Jakarta
mkdir -p "$RUNNER_DIR/logs"
mkdir -p "$(dirname "$LOG_FILE")"

stamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }

if [ -f "$RUNNER_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$RUNNER_DIR/.env"
  set +a
fi

if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node || echo "")"; fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[$(stamp)] [BACKLOG-ALARM] ABORT NODE_NOT_EXECUTABLE" >> "$LOG_FILE"
  exit 1
fi

cd "$REPO"
echo "[$(stamp)] [BACKLOG-ALARM] START" >> "$LOG_FILE"
"$NODE_BIN" "$RUNNER_JS" "$@" >> "$LOG_FILE" 2>&1
RC=$?
echo "[$(stamp)] [BACKLOG-ALARM] END rc=$RC" >> "$LOG_FILE"
exit "$RC"
