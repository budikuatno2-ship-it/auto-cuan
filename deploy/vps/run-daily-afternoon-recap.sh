#!/usr/bin/env bash
# Daily Afternoon Recap — safe VPS runner wrapper (V3-F06: broadcast malam 21:45 WIB).
#
# Usage in VPS crontab (after testing):
#   45 21 * * 1-5  /home/ubuntu/auto-cuan/deploy/vps/run-daily-afternoon-recap.sh --send >> /home/ubuntu/auto-cuan-runner/logs/daily-afternoon-recap.log 2>&1
#
# That's 21:45 WIB (14:45 UTC) on weekdays — rekap malam setelah screener
# preflight 21:25 + Top5 21:35 + landing snapshot 21:40 (final-schedule.cron).
# Dynamic Preflight Gate: skrip ini TIDAK memblokir saat foreign belum lengkap;
# runner tetap kirim rekap (fallback jujur bila picks kosong) agar rutin terkirim.
#
# Guarantees:
#   - forces TZ=Asia/Jakarta for child process;
#   - non-blocking flock — prevents overlapping invocations;
#   - defaults to safe dry-run if no arguments provided;
#   - logs status clearly without printing credentials.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/run-daily-afternoon-recap.js"
LOCK_FILE="$RUNNER_DIR/state/daily-afternoon-recap.lock"

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

exec /usr/bin/flock -n "$LOCK_FILE" \
  "$NODE_BIN" "$RUNNER_JS" "$@"
