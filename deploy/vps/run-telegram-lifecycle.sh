#!/usr/bin/env bash
# Telegram member-lifecycle runner — safe VPS wrapper.
#
# Runs the daily member-lifecycle tasks:
#   * due legacy verification reminders (at most two per user, second >= 24h)
#   * due 30-day review requests (one per eligible member, never repeated)
#   * expired-member auto-kick (ban + immediate unban, so a returning
#     subscriber can rejoin) when --kick-expired is passed.
#
# Usage in VPS crontab (once daily at 02:15 WIB):
#   15 2 * * * /home/ubuntu/auto-cuan/deploy/vps/run-telegram-lifecycle.sh --execute --kick-expired >> /home/ubuntu/auto-cuan-runner/logs/telegram-lifecycle.log 2>&1
#
# Guarantees:
#   - forces TZ=Asia/Jakarta for the child process;
#   - non-blocking flock — prevents overlapping invocations;
#   - loads secrets from the runner-owned env file ONLY (never from crontab);
#   - logs status clearly without printing credentials.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/run-telegram-lifecycle.js"
LOCK_FILE="$RUNNER_DIR/state/telegram-lifecycle.lock"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

# Cron gets a minimal environment and does not inherit PM2/shell variables.
# Load runner-level secrets first; the JS runner reads repo .env/.env.local only
# for keys that are still unset, so a production runner secret cannot be
# shadowed by a placeholder repo value.
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

exec /usr/bin/flock -n "$LOCK_FILE" \
  "$NODE_BIN" "$RUNNER_JS" "$@"
