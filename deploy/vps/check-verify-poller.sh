#!/usr/bin/env bash
# =============================================================================
# Watchdog long-polling @AutoCuanVerificationBot (autocuan-verify-bot).
#
# Tujuan: bot TIDAK PERNAH hening. Dijalankan via cron setiap 5 menit.
#
# Tindakan:
#   1. Jika proses tidak online  -> restart (atau start bila hilang).
#   2. Jika log terakhir lebih tua dari 6 menit -> restart (proses macet).
#   3. Simpan state PM2 agar tetap hidup setelah reboot.
#   4. Kembalikan exit code non-nol (exit 1) jika pemulihan/restart gagal.
#
# Crontab (2026-10-13 fix):
#   */5 * * * * /bin/bash /home/ubuntu/auto-cuan/deploy/vps/check-verify-poller.sh >> \
#     /home/ubuntu/auto-cuan-runner/logs/verify-poller-watchdog.log 2>&1
#
# BUG-VERIFY-POLLER-PERMS (2026-10-13): the previous crontab entry invoked the
# script directly and cron's /bin/sh logged
#   "/bin/sh: 1: check-verify-poller.sh: Permission denied"
# every 5 minutes. The watchdog never ran. Fix: invoke explicitly through
# /bin/bash with the absolute script path (permissions are also set by the
# deployment step: chmod +x on this file and tools/check-verify-poller.sh).
# =============================================================================
set -uo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
LOG="$RUNNER/logs/verify-poller-watchdog.log"
OUT_LOG="/home/ubuntu/.pm2/logs/autocuan-verify-bot-out.log"
STALE_SECONDS="${VERIFY_WATCHDOG_STALE_SECONDS:-360}"

mkdir -p "$RUNNER/logs"
export TZ=Asia/Jakarta

[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || echo "")"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "NODE_NOT_EXECUTABLE=$NODE_BIN" >> "$LOG"; exit 1; }

restart_poller() {
  local reason="$1"
  echo "[$(date '+%F %T %Z')] $reason -> restart" >> "$LOG"
  pm2 restart autocuan-verify-bot --update-env >/dev/null 2>&1 \
    || pm2 start "$REPO/tools/telegram-verify-bot.js" --name autocuan-verify-bot --cwd "$REPO" >/dev/null 2>&1
  local cmd_code=$?
  pm2 save >/dev/null 2>&1

  # BUG-17: Verifikasi status proses setelah tindakan restart
  sleep 2
  local verify_state
  verify_state=$("$NODE_BIN" -e '
let d="";
process.stdin.on("data",(c)=>{d+=c;}).on("end",()=>{
  try{
    const p=JSON.parse(d).find((x)=>x.name==="autocuan-verify-bot");
    if(!p){console.log("missing");return;}
    console.log(p.pm2_env.status);
  }catch(e){console.log("unknown");}
});
' <<< "$(pm2 jlist 2>/dev/null)")

  if [ "$verify_state" = "online" ]; then
    echo "[$(date '+%F %T %Z')] restart SUCCEEDED: autocuan-verify-bot is online" >> "$LOG"
    return 0
  else
    echo "[$(date '+%F %T %Z')] [ALERT] restart FAILED: autocuan-verify-bot status=$verify_state" >> "$LOG"
    return 1
  fi
}

STATE=$("$NODE_BIN" -e '
let d="";
process.stdin.on("data",(c)=>{d+=c;}).on("end",()=>{
  try{
    const p=JSON.parse(d).find((x)=>x.name==="autocuan-verify-bot");
    if(!p){console.log("missing 0");return;}
    console.log(p.pm2_env.status+" "+p.pm2_env.restart_time);
  }catch(e){console.log("unknown 0");}
});
' <<< "$(pm2 jlist 2>/dev/null)")

STATUS=$(echo "$STATE" | cut -d' ' -f1)

if [ "$STATUS" != "online" ]; then
  if restart_poller "status=$STATUS"; then
    exit 0
  else
    exit 1
  fi
fi

# Stall check: log terakhir harus lebih baru dari STALE_SECONDS.
if [ -f "$OUT_LOG" ]; then
  LAST_TS=$(grep -o '"ts":"[^"]*"' "$OUT_LOG" 2>/dev/null | tail -1 | sed 's/.*"ts":"//;s/"//')
  if [ -n "$LAST_TS" ]; then
    LAST_EPOCH=$(date -d "$LAST_TS" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    AGE=$(( NOW_EPOCH - LAST_EPOCH ))
    if [ "$LAST_EPOCH" -gt 0 ] && [ "$AGE" -gt "$STALE_SECONDS" ]; then
      if restart_poller "stale_log ${AGE}s"; then
        exit 0
      else
        exit 1
      fi
    fi
  fi
fi

exit 0
