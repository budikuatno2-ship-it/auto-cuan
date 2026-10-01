#!/usr/bin/env bash
# Historical Bandarmologi Backfill (Juni-Juli 2026) — safe VPS runner wrapper.
#
# Usage in VPS crontab (after testing):
#   5 0 * * *  /home/ubuntu/auto-cuan/deploy/vps/run-historical-backfill.sh >> /home/ubuntu/auto-cuan-runner/logs/historical-backfill.log 2>&1
#
# That's 00:05 WIB every day — just after Arjum's daily quota resets. The
# worker stops itself well before the 18:00-20:00 WIB daily update job
# (Bagian 3) via --stop-at-time and --reserve-quota (see backfill-arjum-data.js),
# so this cron entry is safe to run every day, including weekends, until the
# Juni-Juli backfill is complete. After that it becomes a fast no-op (every
# date is already cached) — no need to remove the cron line urgently.
#
# Guarantees:
#   - forces TZ=Asia/Jakarta for child process;
#   - non-blocking flock — prevents overlapping invocations (e.g. a slow
#     previous run still going when this fires again);
#   - logs status clearly without printing credentials.
#
# Quota config: ARJUM_DAILY_QUOTA env var (see lib/arjum-client.js) controls
# the assumed daily plan size. UPDATE IT after buying more quota or when a
# 30-day package expires — do not edit backfill-arjum-data.js for this.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
RUNNER_JS="$REPO/tools/backfill-arjum-data.js"
LOCK_FILE="$RUNNER_DIR/state/historical-backfill.lock"

# Historical range being backfilled (Bagian 2) — update once, here, if the
# range needs to change; no code edit required.
START_DATE="${AUTO_CUAN_BACKFILL_START_DATE:-2026-06-01}"
END_DATE="${AUTO_CUAN_BACKFILL_END_DATE:-2026-07-31}"
STOP_AT_TIME="${AUTO_CUAN_BACKFILL_STOP_AT:-16:00}"
RESERVE_QUOTA="${AUTO_CUAN_BACKFILL_RESERVE_QUOTA:-3000}"

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
  "$NODE_BIN" "$RUNNER_JS" --all \
  --start-date "$START_DATE" --end-date "$END_DATE" \
  --stop-at-time "$STOP_AT_TIME" --reserve-quota "$RESERVE_QUOTA"
