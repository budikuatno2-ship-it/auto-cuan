#!/usr/bin/env bash
# Hybrid webhook failover guard (Vercel primer ⇄ VPS fallback).
#
# Runs tools/check-webhook-health.js --execute on a short cadence. The checker:
#   * keeps the Telegram webhook on the Vercel domain while Vercel answers 2xx;
#   * flips it to the cloudflared-backed VPS origin when Vercel is paused/402;
#   * flips it back to Vercel as soon as Vercel recovers.
#
# Non-blocking flock so overlapping runs cannot fight each other.
#
# Suggested crontab (WIB):
#   */10 * * * * /home/ubuntu/auto-cuan/deploy/vps/run-webhook-failover.sh >> /home/ubuntu/auto-cuan-runner/logs/webhook-failover.log 2>&1

set -uo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
LOCK_FILE="$RUNNER_DIR/state/webhook-failover.lock"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || echo "")"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  echo "NODE_NOT_EXECUTABLE=$NODE_BIN"
  exit 1
}

cd "$REPO"

# Secrets live in owner-only runner files; the checker loads them itself, but we
# also export them here so the process has them even when run from a bare cron.
for f in "$RUNNER_DIR/telegram-webhook-v3-secret.env" "$RUNNER_DIR/telegram-lifecycle.env"; do
  if [ -f "$f" ]; then
    # shellcheck disable=SC1090
    set -a
    . "$f"
    set +a
  fi
done

echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] webhook failover check"

# --- Tunnel liveness guard -------------------------------------------------
# A quick tunnel is an unmanaged process: if it dies the VPS fallback silently
# disappears and the checker would have no public origin to fail over to. When
# Vercel is already down that means the verification bot goes deaf. Revive the
# tunnel first, then let the checker do its job.
TUNNEL_PATTERN='cloudflared tunnel --url http://localhost:3000'
URL_FILE="$RUNNER_DIR/cloudflared-webhook-full-url.txt"
tunnel_alive=0
if pgrep -f "$TUNNEL_PATTERN" >/dev/null 2>&1; then
  if [ -f "$URL_FILE" ]; then
    TUNNEL_URL="$(head -n 1 "$URL_FILE" | tr -d '\r\n')"
    if [ -n "$TUNNEL_URL" ]; then
      code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$TUNNEL_URL" 2>/dev/null || echo 000)"
      [ "$code" = "200" ] && tunnel_alive=1
    fi
  fi
fi

if [ "$tunnel_alive" -ne 1 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] tunnel unhealthy -> restarting"
  bash "$REPO/deploy/vps/run-cloudflared-webhook.sh" 2>&1 | tail -5 || true
fi

# --- Webhook placement ------------------------------------------------------
/usr/bin/flock -n "$LOCK_FILE" \
  "$NODE_BIN" tools/check-webhook-health.js --execute
exit $?
