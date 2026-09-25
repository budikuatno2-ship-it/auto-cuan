#!/usr/bin/env bash
# Sector-hot hybrid runner (Vercel primer → VPS local fallback).
#
# The cron runner triggers the Vercel sector-hot endpoint first. When Vercel does
# NOT answer HTTP 200 (paused / 402 DEPLOYMENT_DISABLED / 5xx / timeout) the
# runner executes the local screener itself, so the sector snapshot keeps
# refreshing even while the primary deployment is unavailable.
#
# Usage:
#   deploy/vps/run-sector-hot.sh [--dry-run] [--force-local] [--json]
#
# Flags:
#   --dry-run     Never call Vercel; always run the local screener (dry-run mode).
#   --force-local Skip the Vercel attempt and run the local screener directly.
#   --json        Emit a machine-readable summary line.
#
# Environment:
#   SECTOR_HOT_VERCEL_URL   (default https://autocuan.web.id/api/sector-hot?action=refresh)
#   SECTOR_HOT_CURL_TIMEOUT (default 15 seconds)
#   SECTOR_HOT_LOCAL_MODE   (default daytrade)
#   AUTO_CUAN_REPO / AUTO_CUAN_NODE_BIN / AUTO_CUAN_RUNNER_DIR — as elsewhere.
#
# Suggested crontab (WIB, every 30 minutes during market hours):
#   */30 9-15 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-sector-hot.sh >> /home/ubuntu/auto-cuan-runner/logs/sector-hot.log 2>&1

set -uo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
VERCEL_URL="${SECTOR_HOT_VERCEL_URL:-https://autocuan.web.id/api/sector-hot?action=refresh}"
CURL_TIMEOUT="${SECTOR_HOT_CURL_TIMEOUT:-15}"
LOCAL_MODE="${SECTOR_HOT_LOCAL_MODE:-daytrade}"

DRY_RUN=0
FORCE_LOCAL=0
JSON_OUT=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1; FORCE_LOCAL=1 ;;
    --force-local) FORCE_LOCAL=1 ;;
    --json) JSON_OUT=1 ;;
  esac
done

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || echo "")"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "NODE_NOT_EXECUTABLE=$NODE_BIN"
  exit 1
fi

cd "$REPO" || exit 1

stamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }
log() { [ "$JSON_OUT" -eq 1 ] || echo "[$(stamp)] $*"; }

VERCEL_CODE="skipped"
LOCAL_RESULT="not_run"

if [ "$FORCE_LOCAL" -eq 0 ]; then
  log "Vercel primer: $VERCEL_URL"
  VERCEL_CODE="$(curl -s -o /dev/null -m "$CURL_TIMEOUT" -w '%{http_code}' "$VERCEL_URL" 2>/dev/null || echo 000)"
  log "Vercel HTTP $VERCEL_CODE"
fi

if [ "$VERCEL_CODE" = "200" ]; then
  log "Vercel OK — local screener not needed."
else
  if [ "$FORCE_LOCAL" -eq 0 ]; then
    log "Vercel unavailable (HTTP $VERCEL_CODE) — running the local screener."
  else
    log "Forced local run (mode=$LOCAL_MODE)."
  fi

  LOCAL_ARGS=("--mode=$LOCAL_MODE")
  if [ "$DRY_RUN" -eq 1 ]; then
    LOCAL_ARGS+=("--dry-run")
  fi

  # The local screener writes the snapshot consumed by api/sector-hot.js and the
  # dashboard. A non-zero exit is reported but never aborts the cron run.
  if "$NODE_BIN" tools/run-screener.js "${LOCAL_ARGS[@]}"; then
    LOCAL_RESULT="ok"
  else
    LOCAL_RESULT="failed"
    log "Local screener exited non-zero."
  fi
fi

if [ "$JSON_OUT" -eq 1 ]; then
  echo "{\"ts\":\"$(stamp)\",\"vercel_http\":\"$VERCEL_CODE\",\"local\":\"$LOCAL_RESULT\",\"mode\":\"$LOCAL_MODE\",\"dry_run\":$DRY_RUN}"
fi

# Never fail the cron run because the primary was down and the fallback ran.
exit 0
