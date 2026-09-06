#!/usr/bin/env bash
# Daily Bandarmologi Update (Bagian 3) — safe VPS runner wrapper.
#
# Arjum's broker-summary for today's session is usually published between
# 18:00-20:00 WIB, so this fires every 30 minutes from 20:00 to 22:00 WIB
# (5 firings). Each firing is a fast no-op once a completion marker exists
# for the day (see tools/run-daily-broker-update.js), so it is safe to run
# on this cadence every day — it self-skips on non-trading days too (no
# broker-summary is ever published then, so every ticker just stays
# "pending" until the marker naturally never completes; --final at 22:00
# reports that plainly rather than looping forever).
#
# Usage in VPS crontab (after testing):
#   0,30 20-21 * * *  /home/ubuntu/auto-cuan/deploy/vps/run-daily-broker-update.sh >> /home/ubuntu/auto-cuan-runner/logs/daily-broker-update.log 2>&1
#   0 22 * * *        /home/ubuntu/auto-cuan/deploy/vps/run-daily-broker-update.sh --final >> /home/ubuntu/auto-cuan-runner/logs/daily-broker-update.log 2>&1
#
# That's 20:00, 20:30, 21:00, 21:30 as normal retries, and 22:00 as the
# final attempt for the night (reports a real failure if still incomplete,
# instead of silently promising another retry that will never come).
#
# Guarantees:
#   - forces TZ=Asia/Jakarta for child process;
#   - non-blocking flock — prevents overlapping invocations (e.g. a slow
#     20:00 run still going when 20:30 fires);
#   - logs status clearly without printing credentials.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/run-daily-broker-update.js"
LOCK_FILE="$RUNNER_DIR/state/daily-broker-update.lock"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

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

exec /usr/bin/flock -n "$LOCK_FILE" \
  "$NODE_BIN" "$RUNNER_JS" "$@"
