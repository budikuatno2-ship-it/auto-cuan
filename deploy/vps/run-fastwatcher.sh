#!/usr/bin/env bash
# FastWatcher Live — 4 Pilar (Bagian 3: Jadwal Live Bursa 09:00-16:00 WIB)
# Scanner live volume spike / momentum ticker per menit.
# Dijalankan setiap 5 menit selama jam bursa aktif untuk menangkap spike volume mendadak.
#
# Crontab (WIB, CRON_TZ=Asia/Jakarta):
#   */5 9-15 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-fastwatcher.sh --send >> /home/ubuntu/auto-cuan-runner/logs/fastwatcher.log 2>&1
# Crontab (UTC):
#   */5 2-8 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-fastwatcher.sh --send >> /home/ubuntu/auto-cuan-runner/logs/fastwatcher.log 2>&1
#
# Defaults to dry-run when no arguments are provided.
# --send runs the canonical guarded-live engine in record mode; actual Telegram
# publication remains opt-in via the FAST_WATCHER_* kill switches (see
# lib/intraday-fast-watcher-publisher.js) — --send never bypasses them.
#
# BUG-3C-01: this wrapper used to run `tools/run-screener.js --mode=fastwatcher`,
# which read a `fastwatcher` key that data/screener-latest.json never contains,
# producing 0 candidates on 100% of runs. The canonical FastWatcher engine is
# the dedicated intraday pipeline (lib/intraday-fast-watcher-guarded-live.js,
# 2/2 confirmation + anti-chase + market-session window). This wrapper now:
#   1. materializes the DayTrade full-screener shortlist (read-only daemon GET)
#      via tools/materialize-fastwatcher-shortlist.js;
#   2. runs the canonical guarded-live engine every cadence tick.
# Non-trading days (weekend / IDX holiday) skip before any fetch.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
LOCK_FILE="$RUNNER_DIR/state/fastwatcher.lock"
SHORTLIST_FILE="$REPO/data/fastwatcher-shortlist.json"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

# Environment precedence (BUG-RT-02): repository files first, runner-owned
# runtime env LAST so it deterministically overrides stale repo .env.local.
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

cd "$REPO"

SEND_FLAG=""
for arg in "$@"; do
  [ "$arg" = "--send" ] && SEND_FLAG="--send"
  [ "$arg" = "--dry-run" ] && SEND_FLAG="--dry-run"
done

# Default to dry-run if no flag
if [ -z "$SEND_FLAG" ]; then
  SEND_FLAG="--dry-run"
fi

# Single-flight: the whole pipeline (materialize + engine) shares one lock so a
# slow run can never overlap the next 5-minute tick.
exec /usr/bin/flock -n "$LOCK_FILE" bash -c '
  set -euo pipefail
  NODE_BIN="$1"; REPO="$2"; SHORTLIST_FILE="$3"; SEND_FLAG="$4"; shift 4

  echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] FastWatcher live — canonical guarded-live engine $SEND_FLAG"

  # Step 1: materialize the DayTrade full-screener shortlist the engine reads.
  # Exit 3 = non-trading day (weekend/IDX holiday): skip the whole tick.
  set +e
  "$NODE_BIN" "$REPO/tools/materialize-fastwatcher-shortlist.js" --output "$SHORTLIST_FILE"
  MAT_RC=$?
  set -e
  if [ "$MAT_RC" -eq 3 ]; then
    echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] SKIP_NON_TRADING_DAY — FastWatcher tidak jalan."
    exit 0
  fi
  if [ "$MAT_RC" -ne 0 ]; then
    echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] FASTWATCHER_SHORTLIST_MATERIALIZE_FAILED rc=$MAT_RC — skip tick (fail-closed, no candidates invented)."
    exit 1
  fi

  # Step 2: canonical intraday FastWatcher engine. Market-session windows,
  # anti-chase, 2/2 confirmation and Telegram kill switches all live inside.
  # The engine is asked for --json so the wrapper can classify expected skips
  # (outside session window, Friday break, full screener running, concurrent
  # lock) as a safe exit 0 while genuine failures stay non-zero.
  SAMPLE_DATE="$(TZ=Asia/Jakarta date +%F)"
  SCHEDULED_TIME="$(TZ=Asia/Jakarta date +%H:%M)"
  ENGINE_FLAG="--dry-run"
  [ "$SEND_FLAG" = "--send" ] && ENGINE_FLAG=""

  set +e
  ENGINE_OUT="$("$NODE_BIN" "$REPO/tools/run-intraday-fast-watcher-guarded-live.js" \
    --sample-date "$SAMPLE_DATE" \
    --scheduled-time "$SCHEDULED_TIME" \
    --shortlist-file "$SHORTLIST_FILE" \
    --json \
    ${ENGINE_FLAG:+"$ENGINE_FLAG"} 2>&1)"
  ENGINE_RC=$?
  set -e
  printf '%s\n' "$ENGINE_OUT"

  STATUS="$(printf '%s\n' "$ENGINE_OUT" | sed -n "s/.*\"status\": *\"\([a-z_]*\)\".*/\1/p" | head -n1)"
  ERROR_CODE="$(printf '%s\n' "$ENGINE_OUT" | sed -n "s/.*\"error_code\": *\"\([a-z_]*\)\".*/\1/p" | head -n1)"

  case "$STATUS" in
    live_disabled|empty_shortlist|skipped_screener_running|skipped_due_to_production_lock|lock_busy)
      echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] SKIP_$STATUS — FastWatcher tick selesai tanpa kandidat."
      exit 0 ;;
    invalid_input)
      if [ "$ERROR_CODE" = "outside_supported_market_window" ]; then
        echo "[$(date +"%Y-%m-%d %H:%M:%S %Z")] SKIP_OUTSIDE_MARKET_WINDOW — di luar jendela sesi."
        exit 0
      fi
      exit 1 ;;
    *)
      exit "$ENGINE_RC" ;;
  esac
' bash "$NODE_BIN" "$REPO" "$SHORTLIST_FILE" "$SEND_FLAG"
