#!/usr/bin/env bash
# Pembungkus tunggal semua job cron WIB (job-wrapper) — V5 truth-telling edition.
# Kontrak: deploy/vps/final-schedule.cron WAJIB memanggil semua baris via
#   job-wrapper.sh <nama-job> <timeout-detik> <perintah...>
#
# ============================================================================
# TRI-STATE EXIT CONTRACT (BUG-V5-P0-007 / negative control N12)
# ============================================================================
#   0   = SUCCESS   job ran to completion and exited 0
#   1   = FAILED    job ran and failed (real exit code preserved)
#   2   = USAGE     wrapper misuse / invalid arguments / invalid job name
#   3   = SKIPPED   job self-reported a scheduled fail-closed skip (exit 3).
#                 The wrapper NEVER rewrites this to 0.
#   4   = BLOCKED   wrapper-level safety lock refused execution:
#                   - LOCK_BUSY            (single-flight lock held)
#                   - FORBIDDEN_WINDOW_SKIP (quota safety window 23:50-00:10 WIB
#                     is a HARD SAFETY LOCK, therefore BLOCKED=4, not SKIPPED)
#   124 = TIMEOUT   preserved verbatim from timeout(1)
#
# TRUTH RULE: the wrapper preserves the job's real exit code. A skipped or
# blocked run must never be recorded as exit 0 / SUCCESS by cron, monitoring,
# or the heartbeat JSON. Every heartbeat line carries BOTH `exitCode` (numeric)
# and `outcome` (SUCCESS|SKIPPED|BLOCKED|FAILED|TIMEOUT) plus the legacy
# `status` label kept for dashboard compatibility (OK / SCHEDULED_SKIP /
# LOCK_BUSY / FORBIDDEN_WINDOW_SKIP / TIMEOUT / ERROR).
#
# Fitur lain:
#   (a) set TZ=Asia/Jakarta + PATH lengkap (termasuk path Node/NVM VPS);
#   (b) cd ke direktori kerja benar (/home/ubuntu/auto-cuan atau -runner) + load .env aman (tanpa print nilai);
#   (c) cek jam WIB untuk job pemakai kuota: jendela terlarang 23:50 s.d. 00:10 WIB -> BLOCKED exit 4;
#   (d) flock -n /tmp/autocuan-<nama-job>.lock (bersihkan lockfile basi bila PID mati!), nice/ionice, timeout -k 15;
#   (e) tulis Heartbeat Nyata ke data/job-heartbeat/<nama-job>.json + log ke logs/cron/<nama-job>.log.
# Privasi: DILARANG print nilai .env/API key/token/SESSION_SECRET/*.key ke stdout/log.
set -u

WRAPPER_VERSION="V5-2.0.0-tristate"

# --- (a) TZ + PATH lengkap ---
export TZ=Asia/Jakarta
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/ubuntu/.local/node-v22/bin:/home/ubuntu/.nvm/versions/node/v22.23.1/bin:${PATH:-/usr/bin:/bin}"

# --- argumen ---
if [ "$#" -lt 3 ]; then
  echo "USAGE: job-wrapper.sh <nama-job> <timeout-detik> <perintah...>" >&2
  exit 2
fi
JOB_NAME="$1"
TIMEOUT_SEC="$2"
shift 2

# Validasi nama job: alfanumerik + dash/underscore saja (cegah path traversal).
case "$JOB_NAME" in
  ''|*[!a-zA-Z0-9_-]*)
    echo "JOB_WRAPPER_ERROR: nama-job tidak valid: $JOB_NAME" >&2
    exit 2
    ;;
esac
# Validasi timeout: angka positif.
case "$TIMEOUT_SEC" in
  ''|*[!0-9]*)
    echo "JOB_WRAPPER_ERROR: timeout-detik harus angka positif" >&2
    exit 2
    ;;
esac
if [ "$TIMEOUT_SEC" -le 0 ]; then
  echo "JOB_WRAPPER_ERROR: timeout-detik harus >0" >&2
  exit 2
fi

# --- (b) direktori kerja + load .env aman ---
# REPO = /home/ubuntu/auto-cuan (git repo), RUNNER = /home/ubuntu/auto-cuan-runner (data/logs/state).
REPO_DIR="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
# Fallback lokal (pengujian di laptop): pakai direktori repo saat ini bila path VPS tidak ada.
if [ ! -d "$REPO_DIR" ]; then
  # shellcheck disable=SC2164
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  # shellcheck disable=SC2164
  REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
  RUNNER_DIR="$REPO_DIR"
fi
HEARTBEAT_DIR="$REPO_DIR/data/job-heartbeat"
CRON_LOG_DIR="$RUNNER_DIR/logs/cron"
mkdir -p "$HEARTBEAT_DIR" "$CRON_LOG_DIR" /tmp 2>/dev/null || true
HEARTBEAT_FILE="$HEARTBEAT_DIR/$JOB_NAME.json"
LOG_FILE="$CRON_LOG_DIR/$JOB_NAME.log"

# Load .env aman: hanya nama variabel yang dicek, nilai TIDAK pernah di-print.
# Prioritas: repo/.env, repo/.env.intraday-runtime, repo/.env.local, runner/.env (menang).
load_env_safe() {
  local f
  for f in "$REPO_DIR/.env" "$REPO_DIR/.env.intraday-runtime" "$REPO_DIR/.env.local" "$RUNNER_DIR/.env"; do
    if [ -n "$f" ] && [ -f "$f" ]; then
      set -a
      # shellcheck disable=SC1090
      source "$f" 2>/dev/null || true
      set +a
    fi
  done
}
load_env_safe
# shellcheck disable=SC2164
cd "$REPO_DIR"

# --- helper waktu WIB (tanpa dependensi node; pakai TZ=Asia/Jakarta) ---
# Mengembalikan HH:MM WIB saat ini.
wib_hm() {
  TZ=Asia/Jakarta date +"%H:%M"
}
wib_iso() {
  TZ=Asia/Jakarta date +"%Y-%m-%dT%H:%M:%S%z"
}
wib_to_min() {
  # $1 = HH:MM -> menit sejak 00:00
  local hm="$1" h m
  h="${hm%%:*}"
  m="${hm##*:}"
  # shellcheck disable=SC2004
  echo $((10#$h * 60 + 10#$m))
}
# Konfigurasi jendela terlarang: baca dari config/quota.json bila ada, default 23:50-00:10.
FORBID_START="${FORBIDDEN_WINDOW_START_WIB:-}"
FORBID_END="${FORBIDDEN_WINDOW_END_WIB:-}"
if [ -z "$FORBID_START" ] || [ -z "$FORBID_END" ]; then
  if command -v node >/dev/null 2>&1 && [ -f "$REPO_DIR/config/quota.json" ]; then
    # Baca HANYA nilai waktu (HH:MM), bukan secret. Gagal baca -> default.
    _cfg_start="$(node -e "try{const c=require('$REPO_DIR/config/quota.json');process.stdout.write(String(c.forbiddenWindowStartWIB||''))}catch(e){}" 2>/dev/null || true)"
    _cfg_end="$(node -e "try{const c=require('$REPO_DIR/config/quota.json');process.stdout.write(String(c.forbiddenWindowEndWIB||''))}catch(e){}" 2>/dev/null || true)"
    [ -n "$_cfg_start" ] && FORBID_START="$_cfg_start"
    [ -n "$_cfg_end" ] && FORBID_END="$_cfg_end"
  fi
fi
[ -n "$FORBID_START" ] || FORBID_START="23:50"
[ -n "$FORBID_END" ] || FORBID_END="00:10"
# Override simulasi untuk pengujian gate: AUTO_CUAN_SIMULATED_WIB_TIME="HH:MM" atau "YYYY-MM-DDTHH:MM".
SIM_HM=""
if [ -n "${AUTO_CUAN_SIMULATED_WIB_TIME:-}" ]; then
  _sim="${AUTO_CUAN_SIMULATED_WIB_TIME}"
  # Ambil HH:MM dari format apapun yang mengandung HH:MM.
  SIM_HM="$(printf '%s' "$_sim" | grep -oE '[0-9]{2}:[0-9]{2}' | tail -1 || true)"
fi

# Daftar job 0-kuota (boleh jalan di jendela terlarang; tetap dicatat heartbeat).
# Semua job lain dianggap pemakai kuota (konservatif: diblokir di 23:50-00:10).
is_quota_job() {
  case "$JOB_NAME" in
    *-0quota|watchdog|security-monitor|suspension-guard|sector-hot*|lifecycle*|market-context|domestic-*|bandarmologi-intel|screeners-preflight|top5-radar|landing-snapshot|afternoon-recap|daily-candles*|fastwatcher*)
      return 1 ;;
    *) return 0 ;;
  esac
}
# Override eksplisit via env (cron dapat men-set JOB_USES_QUOTA=0 untuk job 0-kuota).
USES_QUOTA=1
if [ "${JOB_USES_QUOTA:-}" = "0" ]; then
  USES_QUOTA=0
elif [ "${JOB_USES_QUOTA:-}" = "1" ]; then
  USES_QUOTA=1
else
  if is_quota_job; then USES_QUOTA=1; else USES_QUOTA=0; fi
fi

in_forbidden_window() {
  local cur="$1" start="$2" end="$3"
  local c s e
  c="$(wib_to_min "$cur")"
  s="$(wib_to_min "$start")"
  e="$(wib_to_min "$end")"
  if [ "$s" -le "$e" ]; then
    [ "$c" -ge "$s" ] && [ "$c" -lt "$e" ]
  else
    [ "$c" -ge "$s" ] || [ "$c" -lt "$e" ]
  fi
}

# Heartbeat writer: semantic outcome + legacy status label + real exit code.
# $1=outcome $2=status_label $3=exit_code $4=duration_ms $5=requests_used $6=error_snippet
write_heartbeat() {
  local _outcome="$1" _status_label="$2" _exit_code="$3" _dur="$4" _req="$5" _err="$6"
  local _start_iso="$7" _end_iso="$8"
  printf '{"jobName":"%s","lastStartWIB":"%s","lastEndWIB":"%s","durationMs":%s,"exitCode":%s,"outcome":"%s","status":"%s","requestsUsed":%s,"lastErrorSnippet":"%s"}\n' \
    "$JOB_NAME" "$_start_iso" "$_end_iso" "$_dur" "$_exit_code" "$_outcome" "$_status_label" "$_req" "$_err" \
    > "$HEARTBEAT_FILE.tmp.$$" 2>/dev/null && mv "$HEARTBEAT_FILE.tmp.$$" "$HEARTBEAT_FILE" 2>/dev/null || true
}

NOW_HM="$(wib_hm)"
if [ -n "$SIM_HM" ]; then
  NOW_HM="$SIM_HM"
fi
NOW_ISO="$(wib_iso)"
START_MS="$(date +%s%3N 2>/dev/null || date +%s000)"

# --- (c) hard stop WIB untuk job pemakai kuota ---
# DESAIN (BUG-V5-P0-006/007): jendela 23:50-00:10 WIB adalah KUNCI KESELAMATAN
# kuota (safety lock), bukan sekadar skip kosmetik -> outcome BLOCKED, exit 4.
# Jangan pernah merekamnya sebagai exit 0/SUCCESS.
if [ "$USES_QUOTA" -eq 1 ] && in_forbidden_window "$NOW_HM" "$FORBID_START" "$FORBID_END"; then
  END_ISO="$(wib_iso)"
  write_heartbeat "BLOCKED" "FORBIDDEN_WINDOW_SKIP" 4 0 0 "" "$NOW_ISO" "$END_ISO"
  printf '[%s] %s BLOCKED forbidden window %s-%s WIB (hard safety lock) exit=4.\n' "$NOW_ISO" "$JOB_NAME" "$FORBID_START" "$FORBID_END" >> "$LOG_FILE" 2>/dev/null || true
  echo "[$NOW_ISO] $JOB_NAME BLOCKED forbidden window $FORBID_START-$FORBID_END WIB (hard safety lock)."
  exit 4
fi

# --- (d) flock -n + stale-lock cleanup + nice/ionice + timeout ---
LOCK_FILE="/tmp/autocuan-$JOB_NAME.lock"
# Bersihkan lockfile basi bila PID pemegang sudah mati.
if [ -f "$LOCK_FILE" ]; then
  _holder_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  case "$_holder_pid" in
    ''|*[!0-9]*) _holder_pid="" ;;
  esac
  if [ -n "$_holder_pid" ]; then
    if ! kill -0 "$_holder_pid" 2>/dev/null; then
      rm -f "$LOCK_FILE" 2>/dev/null || true
      printf '[%s] %s stale lock cleaned (pid %s mati).\n' "$NOW_ISO" "$JOB_NAME" "$_holder_pid" >> "$LOG_FILE" 2>/dev/null || true
    fi
  else
    # Lockfile tanpa PID valid (mis. lock flock lama 0-byte): biarkan flock yang menilai;
    # flock -n tetap single-flight, jadi tidak perlu dihapus agresif.
    :
  fi
fi

# Tulis PID sendiri sebagai penanda (flock tetap yang mengunci; file ini hanya info).
echo "$$" > "$LOCK_FILE.pid.$$" 2>/dev/null || true

# Jalankan perintah di bawah flock + nice + ionice + timeout.
# flock -n: tick berikutnya -> LOCK_BUSY (BLOCKED, exit 4), BUKAN exit 0.
# timeout -k 15: SIGTERM lalu SIGKILL 15 detik kemudian.
set +u
/usr/bin/flock -n "$LOCK_FILE" /usr/bin/nice -n 10 /usr/bin/ionice -c2 -n7 /usr/bin/timeout -k 15 "$TIMEOUT_SEC" "$@" >> "$LOG_FILE" 2>&1 &
CMD_PID=$!
wait "$CMD_PID"
CMD_EXIT=$?
set -u

END_MS="$(date +%s%3N 2>/dev/null || date +%s000)"
case "$END_MS" in
  ''|*[!0-9]*) END_MS="$START_MS" ;;
esac
case "$START_MS" in
  ''|*[!0-9]*) START_MS="$END_MS" ;;
esac
DURATION_MS=$((END_MS - START_MS))
if [ "$DURATION_MS" -lt 0 ]; then DURATION_MS=0; fi

# --- klasifikasi outcome (BUG-V5-P0-007): kode exit asli DIPERTAHANKAN ---
# Tri-state: 0=SUCCESS, 3=SKIPPED (job skip terjadwal), 4=BLOCKED (LOCK_BUSY),
# 124=TIMEOUT, lainnya=FAILED. DILARANG memetakan skip/blok ke 0.
OUTCOME="FAILED"
STATUS_LABEL="ERROR"
REASON=""
case "$CMD_EXIT" in
  0)
    OUTCOME="SUCCESS"
    STATUS_LABEL="OK"
    ;;
  3)
    OUTCOME="SKIPPED"
    STATUS_LABEL="SCHEDULED_SKIP"
    REASON="job self-reported scheduled skip (exit 3 preserved)"
    ;;
  124)
    OUTCOME="TIMEOUT"
    STATUS_LABEL="TIMEOUT"
    REASON="timeout -k 15 reached"
    ;;
  1)
    # Heuristik LOCK_BUSY: flock -n gagal akuisisi -> exit 1 tanpa menjalankan
    # perintah (durasi < 2000ms). Konfirmasi dengan akuisisi non-blokir sesaat.
    if [ "$DURATION_MS" -lt 2000 ] && ! /usr/bin/flock -n "$LOCK_FILE" true 2>/dev/null; then
      OUTCOME="BLOCKED"
      STATUS_LABEL="LOCK_BUSY"
      REASON="single-flight lock held by another run"
      CMD_EXIT=4
    else
      OUTCOME="FAILED"
      STATUS_LABEL="ERROR"
    fi
    ;;
  *)
    OUTCOME="FAILED"
    STATUS_LABEL="ERROR"
    ;;
esac

END_ISO="$(wib_iso)"
# requestsUsed: hitung dari state kuota bila tersedia (delta usedToday), tanpa print secret.
REQUESTS_USED=0
if command -v node >/dev/null 2>&1 && [ -f "$REPO_DIR/lib/quota-state.js" ]; then
  REQUESTS_USED="$(node -e "try{const qs=require('$REPO_DIR/lib/quota-state.js');const s=qs.getQuotaSnapshot();process.stdout.write(String(s.used||0))}catch(e){process.stdout.write('0')}" 2>/dev/null || echo "0")"
  case "$REQUESTS_USED" in
    ''|*[!0-9]*) REQUESTS_USED=0 ;;
  esac
fi
# lastErrorSnippet: 300 char terakhir log (tanpa secret; log tidak pernah berisi secret).
LAST_ERR=""
if [ -f "$LOG_FILE" ]; then
  LAST_ERR="$(tail -c 300 "$LOG_FILE" 2>/dev/null | tr '\n' ' ' | sed 's/"/_/g' | cut -c1-300 || true)"
fi

# --- (e) Heartbeat Nyata (exit code asli, tanpa rewrites) ---
write_heartbeat "$OUTCOME" "$STATUS_LABEL" "$CMD_EXIT" "$DURATION_MS" "$REQUESTS_USED" "$LAST_ERR" "$NOW_ISO" "$END_ISO"
printf '[%s] %s END exit=%s outcome=%s label=%s durMs=%s %s\n' "$END_ISO" "$JOB_NAME" "$CMD_EXIT" "$OUTCOME" "$STATUS_LABEL" "$DURATION_MS" "$REASON" >> "$LOG_FILE" 2>/dev/null || true
rm -f "$LOCK_FILE.pid.$$" 2>/dev/null || true

exit "$CMD_EXIT"
