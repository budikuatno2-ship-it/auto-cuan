#!/usr/bin/env bash
# Swing Non-Konglo — diagnostic-only wrapper.
#
# Public delivery is intentionally NOT owned by this generic snapshot runner.
# The canonical nk-screener finalizer owns public Swing Non-Konglo delivery and applies the real Swing signal gates.
#
# Any --send request is refused fail-closed so production cannot bypass the
# canonical quality/confirmation/dedupe/cooldown path by accident.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
LOCK_FILE="$RUNNER_DIR/state/swing-non-konglo.lock"

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
    echo "DIRECT_GENERIC_SEND_DISABLED mode=swing-non-konglo"
    echo "Use the canonical signal owner; this wrapper is diagnostic-only."
    exit 2
  fi
done

cd "$REPO"
echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] Swing Non-Konglo — diagnostic dry-run"

exec /usr/bin/flock -n "$LOCK_FILE"   "$NODE_BIN" tools/run-screener.js --mode=swing-non-konglo --dry-run
