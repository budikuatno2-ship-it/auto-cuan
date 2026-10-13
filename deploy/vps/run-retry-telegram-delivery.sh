#!/usr/bin/env bash
# Telegram delivery retry worker wrapper — every 15 minutes (17:00-23:45 WIB).
#
# Sweeps stuck rows: DELIVERY_RETRYABLE and stale DELIVERY_PENDING/IN_PROGRESS
# claims that were stranded between prepare and finalize. Production evidence
# (audit 1-12 Okt 2026): 48 RETRYABLE rows piled up and MEDC 2026-10-12 sat at
# DELIVERY_PENDING with first_sent_at=null because nothing ever swept the queue.
#
# Guarantees:
#   - forces TZ=Asia/Jakarta;
#   - non-blocking flock so runs never overlap;
#   - passes --apply and requires ALLOW_PROD_DB_WRITE=1 for the production DB;
#   - never prints credentials.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RETRY_JS="$REPO/tools/retry-telegram-delivery.js"
LOCK_FILE="$RUNNER_DIR/state/retry-telegram-delivery.lock"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || echo "")"
fi

[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  echo "NODE_NOT_EXECUTABLE=$NODE_BIN"
  exit 1
}

[ -f "$RETRY_JS" ] || {
  echo "RETRY_RUNNER_NOT_FOUND=$RETRY_JS"
  exit 1
}

cd "$REPO"

exec /usr/bin/flock -n "$LOCK_FILE" \
  env ALLOW_PROD_DB_WRITE=1 "$NODE_BIN" "$RETRY_JS" "$@"
