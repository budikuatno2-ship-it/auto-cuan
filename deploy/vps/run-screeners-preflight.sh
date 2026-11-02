#!/usr/bin/env bash
# Nightly screener preflight wrapper (2026-10-13, P5 degradasi anggun 2026-10-31).
#
# P5 — CABUT hard-fail pemblokir screener (jalan pintas #21).
# Root cause lama (audit 1-12 Okt 2026): running the nightly screener at 19:00 WIB
# scanned partial data — the EOD candle set for all 963 emiten only reaches
# full coverage around 21:12 WIB, so the 19:00 sweep saw ~87% and produced
# defective signals. Schedule moved to 21:30 WIB + coverage gate deferred/skip.
# Triage P0 (28 Okt 2026): COVERAGE_INSUFFICIENT 830/962=86.28% <95% lalu
# screeners.log 0 B = sweep dilewati tanpa sinyal ("Screener Error").
#
# Perilaku P5 (degradasi anggun, tanpa blokir):
# - 3 screener (DayTrade, Swing Konglo, Swing Non-Konglo) WAJIB tetap jalan
#   memproses SELURUH 963 emiten walau cakupan candle/Foreign <95%.
# - Jika emiten/tanggal belum ada Foreign lengkap, engine tetap skor dari
#   Candle/Volume/LPM/SR/Broksum ALL/Domestik yang tersedia + sematkan badge
#   jujur "Data asing belum lengkap" (lihat api/sector-hot.js).
# - Preflight HANYA memberi peringatan + jeda bounded, TIDAK PERNAH exit 0
#   tanpa menjalankan screener. Setelah deferral habis, screener tetap
#   dieksekusi dengan penanda GRACEFUL_DEGRADED.
#
# Guarantees:
#   - forces TZ=Asia/Jakarta;
#   - non-blocking flock so runs never overlap;
#   - defaults to safe dry-run when no arguments are provided;
#   - never prints credentials.
#
# Usage in VPS crontab (WIB):
#   30 21 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-screeners-preflight.sh --execute --send >> /home/ubuntu/auto-cuan-runner/logs/screeners.log 2>&1

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
SCREENER_JS="$REPO/tools/run-all-screeners-vps.js"
COVERAGE_JS="$REPO/tools/check-candle-coverage.js"
LOCK_FILE="$RUNNER_DIR/state/screeners.lock"
COVERAGE_LOG="$RUNNER_DIR/logs/screener-preflight.log"

# P5: ambang cakupan hanya untuk PERINGATAN + jeda bounded, BUKAN hard-fail.
# 963 emiten penuh (IHSG dikecualikan dari hitungan emiten).
MIN_COVERAGE_PCT="${AUTO_CUAN_SCREENER_MIN_COVERAGE_PCT:-95}"
# Bounded deferral: 4 attempts x 15 minutes = 60 minutes max.
MAX_DEFERRALS="${AUTO_CUAN_SCREENER_MAX_DEFERRALS:-4}"
DEFER_SLEEP_SEC="${AUTO_CUAN_SCREENER_DEFER_SLEEP_SEC:-900}"
# P5: set 1 untuk melewati jeda (mis. uji gate); default tetap jeda bounded.
SKIP_DEFER_SLEEP="${AUTO_CUAN_SCREENER_SKIP_DEFER_SLEEP:-0}"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || echo "")"
fi

[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  echo "NODE_NOT_EXECUTABLE=$NODE_BIN"
  exit 1
}

[ -f "$SCREENER_JS" ] || {
  echo "RUNNER_NOT_FOUND=$SCREENER_JS"
  exit 1
}

cd "$REPO"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*"
}

# Coverage gate: when the checker is available, defer until the threshold is
# met. A missing checker degrades to the plain producer (never blocks forever).
coverage_ok() {
  if [ ! -f "$COVERAGE_JS" ]; then
    log "preflight: coverage checker tidak ada; lanjut tanpa gate."
    return 0
  fi
  local out
  out="$("$NODE_BIN" "$COVERAGE_JS" --min-pct="$MIN_COVERAGE_PCT" 2>&1)" || true
  echo "$out" >> "$COVERAGE_LOG"
  local verdict
  verdict="$(printf '%s\n' "$out" | grep -E '^COVERAGE_(OK|INSUFFICIENT)' | tail -1 || true)"
  case "$verdict" in
    COVERAGE_OK) return 0 ;;
    COVERAGE_INSUFFICIENT) return 1 ;;
    *)
      log "preflight: verdict tidak terbaca; lanjut tanpa gate."
      return 0
      ;;
  esac
}

# P5 degradasi anggun: preflight HANYA menunda bounded untuk memberi EOD
# mengejar ketertinggalan, lalu SELALU menjalankan screener penuh 963 emiten.
# DILARANG exit 0 tanpa menjalankan screener (jalan pintas #21).
deferral=0
degraded=0
while ! coverage_ok; do
  deferral=$((deferral + 1))
  if [ "$deferral" -gt "$MAX_DEFERRALS" ]; then
    log "P5-GRACEFUL: cakupan candle hari-T masih < ${MIN_COVERAGE_PCT}% setelah ${MAX_DEFERRALS} deferral; TETAP menjalankan screener penuh 963 emiten dengan badge jujur (GRACEFUL_DEGRADED=1)."
    degraded=1
    break
  fi
  log "DEFERRED: cakupan candle < ${MIN_COVERAGE_PCT}%; menunggu ${DEFER_SLEEP_SEC}s (deferral ${deferral}/${MAX_DEFERRALS})."
  if [ "$SKIP_DEFER_SLEEP" != "1" ]; then
    sleep "$DEFER_SLEEP_SEC"
  fi
done

if [ "$degraded" = "1" ]; then
  log "preflight: coverage di bawah ambang (>= ${MIN_COVERAGE_PCT}% tidak tercapai); menjalankan screener GRACEFUL_DEGRADED."
  export AUTO_CUAN_SCREENER_GRACEFUL_DEGRADED=1
else
  log "preflight: coverage OK (>= ${MIN_COVERAGE_PCT}%); menjalankan screener."
fi

exec /usr/bin/flock -n "$LOCK_FILE" \
  "$NODE_BIN" "$SCREENER_JS" "$@"
