#!/usr/bin/env bash
# Bandar accumulation calculation wrapper — 18:00 WIB (2026-10-13).
#
# Runs after the EOD market-data window (16:30-17:30 WIB) so the broker-summary
# caches are complete, and before the 21:30 nightly screener so bandarmologi
# scores are available when the sweep runs.
#
# It also backfills any trading date from the last N days whose dated
# broker-accumulation files are missing (derived deterministically from that
# day's broker-summary — see tools/generate-broker-accumulation.js).
#
# Guarantees:
#   - forces TZ=Asia/Jakarta;
#   - non-blocking flock so runs never overlap;
#   - never prints credentials.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
GENERATOR_JS="$REPO/tools/generate-broker-accumulation.js"
LOCK_FILE="$RUNNER_DIR/state/broker-accumulation.lock"
LOOKBACK_DAYS="${AUTO_CUAN_ACCUMULATION_LOOKBACK_DAYS:-3}"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || echo "")"
fi

[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  echo "NODE_NOT_EXECUTABLE=$NODE_BIN"
  exit 1
}

[ -f "$GENERATOR_JS" ] || {
  echo "GENERATOR_NOT_FOUND=$GENERATOR_JS"
  exit 1
}

cd "$REPO"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*"
}

log "Kalkulasi akumulasi bandar mulai (lookback ${LOOKBACK_DAYS} hari)."

# Backfill the last N calendar days (weekends/holidays simply report zero
# candidates). Today is included so the same-day cache is refreshed too.
for offset in $(seq 0 "$LOOKBACK_DAYS"); do
  target="$(date -d "-${offset} day" '+%Y-%m-%d' 2>/dev/null || date -v-"${offset}"d '+%Y-%m-%d')"
  log "generate-broker-accumulation --date=${target} --apply"
  if ! ALLOW_PROD_DB_WRITE=1 "$NODE_BIN" "$GENERATOR_JS" --date="$target" --apply; then
    log "WARN: generator gagal untuk ${target} (lanjut ke tanggal berikutnya)."
  fi
done

log "Kalkulasi akumulasi bandar selesai."
