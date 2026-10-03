#!/usr/bin/env bash
# Daily Bandarmologi Update (Bagian 3) — safe VPS runner wrapper.
#
# NOTE (Wave 2): production does not call this wrapper directly any more.
# The durable coordinator deploy/vps/run-daily-market-update.sh fires every
# 30 minutes across the EOD window (18:00-23:30 WIB, Mon-Fri) and appends
# --final only on its 23:30 WIB pass. This wrapper remains for manual runs
# and is kept in sync with that schedule.
#
# Arjum's broker-summary for today's session is usually published between
# 18:00-20:00 WIB. Each firing is a fast no-op once a completion marker
# exists for the day (see tools/run-daily-broker-update.js); it self-skips on
# non-trading days too. The terminal --final pass runs at 23:30 WIB — the end
# of the EOD operating window — and reports a real failure if still
# incomplete instead of promising a retry that will never come.
#
# Usage in VPS crontab (manual wrapper form):
#   0,30 18-23 * * 1-5  /home/ubuntu/auto-cuan/deploy/vps/run-daily-broker-update.sh >> /home/ubuntu/auto-cuan-runner/logs/daily-broker-update.log 2>&1
#   # the coordinator adds --final on the 23:30 firing only
#
# That's 18:00 through 23:00 as normal retries, and 23:30 as the final
# attempt for the night.
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

# Cron gets a minimal environment and does not inherit PM2/shell variables.
# Load runner-level secrets first; the JS worker then reads repo .env/.env.local
# only for keys that are still unset, so a production runner secret cannot be
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
