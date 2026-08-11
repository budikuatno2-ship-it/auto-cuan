#!/usr/bin/env bash
# Daily Market Context — safe VPS runner wrapper.
#
# NOT installed into any crontab by this change. This script exists so an
# operator can review and manually add ONE cron line once satisfied:
#
#   15 16 * * 1-5  /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-context-collector.sh >> /home/ubuntu/auto-cuan-runner/logs/daily-market-context.log 2>&1
#
# That's 16:15 WIB (09:15 UTC) on weekdays — after IDX trading closes
# (~15:30/16:00 WIB EOD data settle window), matching the target timing in
# the task spec. Adjust the crontab's own TZ or the UTC offset above if the
# host crontab does not run in Asia/Jakarta.
#
# What this wrapper guarantees:
#   - forces TZ=Asia/Jakarta for the child process, regardless of host TZ;
#   - non-blocking flock — a second overlapping invocation exits immediately
#     instead of queueing or double-running;
#   - a bounded overall timeout (default 20 minutes) so a hung Yahoo request
#     can never wedge the VPS indefinitely;
#   - the underlying script's own market-day guard still runs FIRST inside
#     Node (isTradingDay check) — this wrapper's lock/timeout apply whether
#     or not that guard ends up skipping the real work;
#   - never sends Telegram (the collector script has no Telegram code path);
#   - never touches Fast Watcher state;
#   - prints no secrets — only counts and short status lines.
#
# Usage:
#   ./run-daily-market-context-collector.sh                    # real run, full universe
#   ./run-daily-market-context-collector.sh --dry-run           # validate only
#   ./run-daily-market-context-collector.sh BBCA,BBRI,TLKM      # explicit ticker list (CLI wins)
#   AUTO_CUAN_COLLECTOR_TICKERS=BBCA,TLKM ./run-daily-market-context-collector.sh
#
# Ticker-list precedence: explicit CLI positional argument >
# AUTO_CUAN_COLLECTOR_TICKERS env var > full eligible universe (neither set).
# Exactly one of these ever becomes the positional ticker-list argument
# forwarded to the Node script — an empty value is NEVER forwarded, so it can
# never shadow a real ticker list positioned after it.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/scripts/collect-daily-market-context.js"
LOCK_FILE="$RUNNER_DIR/state/daily-market-context-collector.lock"
TIMEOUT_SECONDS="${AUTO_CUAN_COLLECTOR_TIMEOUT_SECONDS:-1200}"
TICKERS="${AUTO_CUAN_COLLECTOR_TICKERS:-}"

export TZ=Asia/Jakarta

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

# Build the argument list without ever inserting an empty positional slot:
#   - an explicit CLI positional (first arg, unless it's a flag like
#     --dry-run) always wins and is used as-is;
#   - otherwise, if AUTO_CUAN_COLLECTOR_TICKERS is non-empty, use that;
#   - otherwise no ticker-list argument is forwarded at all, so the Node
#     script falls back to the full eligible universe.
# Remaining args (e.g. --dry-run) are always passed through untouched.
COLLECTOR_ARGS=()
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then
  # $1 exists and does not start with "--" -> treat as the ticker list.
  COLLECTOR_ARGS+=("$1")
  shift
elif [ -n "$TICKERS" ]; then
  COLLECTOR_ARGS+=("$TICKERS")
fi
COLLECTOR_ARGS+=("$@")

exec /usr/bin/flock -n "$LOCK_FILE" \
  /usr/bin/timeout --signal=TERM --kill-after=30 "${TIMEOUT_SECONDS}s" \
  "$NODE_BIN" "$RUNNER_JS" "${COLLECTOR_ARGS[@]}"
