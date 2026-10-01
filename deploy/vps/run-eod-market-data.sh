#!/usr/bin/env bash
# Canonical Auto-Cuan EOD market-data bundle.
#
# Runs on Asia/Jakarta wall clock. Each hourly firing repairs only missing data:
#   1) dated broker summary
#   2) broker accumulation
#   3) insider transactions
#   4) daily OHLCV candle (includes volume)
#
# Broker marker v2 makes completed auxiliary work idempotent. Candle worker
# skips tickers whose target-date candle is already present.
set -uo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
LOCK_FILE="$RUNNER_DIR/state/eod-market-data.lock"

export TZ=Asia/Jakarta
mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

cd "$REPO" || exit 1

run_bundle() {
  local hour broker_rc candle_rc
  hour="$(date +%H)"
  broker_rc=0
  candle_rc=0

  echo "=== AUTO-CUAN EOD MARKET DATA ==="
  echo "started_at=$(date '+%F %T %Z %z')"
  echo "hour_wib=$hour"

  if [ "$hour" = "23" ]; then
    echo "--- broker bundle: FINAL ---"
    bash "$REPO/deploy/vps/run-daily-broker-update.sh" --limit 5000 --final
    broker_rc=$?
  else
    echo "--- broker bundle: RETRY ---"
    bash "$REPO/deploy/vps/run-daily-broker-update.sh" --limit 5000
    broker_rc=$?
  fi

  echo "broker_exit=$broker_rc"

  echo "--- candle + volume ---"
  bash "$REPO/deploy/vps/run-daily-candles.sh"
  candle_rc=$?
  echo "candle_exit=$candle_rc"

  echo "finished_at=$(date '+%F %T %Z %z')"

  # In 18:00-22:00 retry windows an incomplete broker marker is expected and
  # must not prevent candle refresh. At the 23:00 final pass expose a real
  # broker failure to monitoring/log inspection.
  if [ "$hour" = "23" ] && [ "$broker_rc" -ne 0 ]; then
    return "$broker_rc"
  fi
  if [ "$candle_rc" -ne 0 ]; then
    return "$candle_rc"
  fi
  return 0
}

exec 9>"$LOCK_FILE"
if ! /usr/bin/flock -n 9; then
  echo "EOD bundle already running; skip overlapping firing."
  exit 0
fi
run_bundle
