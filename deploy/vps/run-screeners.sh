#!/usr/bin/env bash
# Screener producer wrapper — fixes the silent-channel root cause.
#
# Before this wrapper existed there was NO scheduled producer for the Daytrade /
# FastWatcher / Swing screeners; only the Top 5 Vercel cron ran. The Telegram
# channel therefore stayed silent even though the sender was healthy.
#
# This wrapper runs the repository's own orchestration against the local VPS
# daemon (auto-cuan-local-app on 127.0.0.1:3000), which is where the heavy
# universe sweep can complete. It is safe: dry-run unless --execute is passed.
#
# Usage in VPS crontab (WIB):
#   10 16 * * 1-5  /home/ubuntu/auto-cuan/deploy/vps/run-screeners.sh --execute --send >> /home/ubuntu/auto-cuan-runner/logs/screeners.log 2>&1
#
# Guarantees:
#   - forces TZ=Asia/Jakarta;
#   - non-blocking flock so runs never overlap;
#   - defaults to dry-run when no arguments are provided;
#   - never prints credentials.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/run-all-screeners-vps.js"
LOCK_FILE="$RUNNER_DIR/state/screeners.lock"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

# Load environment files (runner-level first, then repo-level overrides like .env.local)
for env_file in "$RUNNER_DIR/.env" "$REPO/.env" "$REPO/.env.intraday-runtime" "$REPO/.env.local"; do
  if [ -f "$env_file" ]; then
    set -a
    source "$env_file" 2>/dev/null || true
    set +a
  fi
done

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
