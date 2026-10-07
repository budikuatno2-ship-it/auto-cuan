#!/usr/bin/env bash
# Screener dispatch — diagnostic-only.
#
# Production delivery ownership:
#   DayTrade public signal -> canonical FastWatcher guarded-live engine
#   Swing Konglo          -> sendSwingKongloTelegramNotification()
#   Swing Non-Konglo      -> sendSwingNkTelegramNotification()
#
# This wrapper may inspect the materialized snapshot, but it MUST NOT broadcast
# generic DayTrade/Swing cards. Those generic cards bypass the strategy-specific
# quality/confirmation/dedupe/cooldown gates and can duplicate canonical sends.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
LOCK_FILE="$RUNNER_DIR/state/screener-dispatch.lock"

export TZ=Asia/Jakarta
mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/load-env.sh
source "$SCRIPT_DIR/lib/load-env.sh"
load_auto_cuan_env "$REPO" "$RUNNER_DIR"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || echo "")"
fi

[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  echo "NODE_NOT_EXECUTABLE=$NODE_BIN"
  exit 1
}

for arg in "$@"; do
  if [ "$arg" = "--send" ]; then
    echo "GENERIC_SCREENER_DISPATCH_SEND_DISABLED"
    echo "Canonical strategy-specific owners already control public delivery."
    exit 2
  fi
done

cd "$REPO"

exec /usr/bin/flock -n "$LOCK_FILE" bash -c '
  echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] === SCREENER DIAGNOSTICS ONLY ==="
  "$0" tools/run-screener.js --mode=daytrade --dry-run || true
  echo "---"
  "$0" tools/run-screener.js --mode=swing-konglo --dry-run || true
  echo "---"
  "$0" tools/run-screener.js --mode=swing-non-konglo --dry-run || true
' "$NODE_BIN"
