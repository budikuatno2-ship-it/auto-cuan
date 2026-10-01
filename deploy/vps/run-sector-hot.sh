#!/usr/bin/env bash
# Sector-hot runner.
#
# Production cron uses --force-local and refreshes sector-hot directly on the
# VPS via scripts/refresh-sector-hot.js. A legacy Vercel-first mode remains
# available only for manual compatibility when --force-local is omitted.
#
# Usage:
#   deploy/vps/run-sector-hot.sh [--dry-run] [--force-local] [--json]
#
# Flags:
#   --dry-run     Do not call Vercel or mutate sector-hot data; print intended local action.
#   --force-local Skip the Vercel attempt and run the real local sector-hot refresher.
#   --json        Emit a machine-readable summary line.
#
# Environment:
#   SECTOR_HOT_VERCEL_URL   (default https://autocuan.web.id/api/sector-hot?action=refresh)
#   SECTOR_HOT_CURL_TIMEOUT (default 15 seconds)
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

# Load environment files (runner-level first, then repo-level overrides like .env.local)
for env_file in "$RUNNER_DIR/.env" "$REPO/.env" "$REPO/.env.intraday-runtime" "$REPO/.env.local"; do
  if [ -f "$env_file" ]; then
    set -a
    source "$env_file" 2>/dev/null || true
    set +a
  fi
done

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
  log "Vercel OK — local refresh not needed."
else
  if [ "$FORCE_LOCAL" -eq 0 ]; then
    log "Vercel unavailable (HTTP $VERCEL_CODE) — running real local sector-hot refresh."
  else
    log "Forced local sector-hot refresh."
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    LOCAL_RESULT="dry_run"
    log "DRY_RUN: would execute scripts/refresh-sector-hot.js"
  elif "$NODE_BIN" scripts/refresh-sector-hot.js; then
    LOCAL_RESULT="ok"
  else
    LOCAL_RESULT="failed"
    log "Local sector-hot refresher exited non-zero."
  fi
fi

if [ "$JSON_OUT" -eq 1 ]; then
  echo "{\"ts\":\"$(stamp)\",\"vercel_http\":\"$VERCEL_CODE\",\"local\":\"$LOCAL_RESULT\",\"dry_run\":$DRY_RUN}"
fi

# Production monitoring must see a failed local refresh as a failed cron run.
if [ "$LOCAL_RESULT" = "failed" ]; then
  exit 1
fi
exit 0
