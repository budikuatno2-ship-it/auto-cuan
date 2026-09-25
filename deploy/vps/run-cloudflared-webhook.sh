#!/usr/bin/env bash
# Cloudflared Quick Tunnel for VPS Webhook Fallback (port 3000)
# Hybrid: Vercel primer + VPS fallback via trycloudflare.com
# - Menjalankan cloudflared tunnel --url http://localhost:3000
# - Menangkap URL publik dan menyimpan ke /home/ubuntu/auto-cuan-runner/cloudflared-webhook-url.txt
# - Dijalankan via PM2 atau nohup, auto-restart jika mati
# - URL bersifat ephemeral (berubah tiap restart), failover checker akan baca file ini

set -euo pipefail

RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
LOG_FILE="$RUNNER_DIR/logs/cloudflared-webhook.log"
URL_FILE="$RUNNER_DIR/cloudflared-webhook-url.txt"
PID_FILE="$RUNNER_DIR/state/cloudflared-webhook.pid"

mkdir -p "$RUNNER_DIR/logs" "$RUNNER_DIR/state"

# Kill existing tunnel if running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Killing old cloudflared pid $OLD_PID"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$PID_FILE"
fi

# Also kill any existing cloudflared for 3000
pkill -f "cloudflared tunnel --url http://localhost:3000" 2>/dev/null || true
sleep 1

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting cloudflared tunnel for http://localhost:3000 ..."
# Run in background, capture log
nohup cloudflared tunnel --url http://localhost:3000 > "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] cloudflared pid $PID, log $LOG_FILE"

# Wait for URL to appear (max 30s)
for i in $(seq 1 30); do
  if grep -q "trycloudflare.com" "$LOG_FILE" 2>/dev/null; then
    URL=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" "$LOG_FILE" | head -n 1)
    if [ -n "$URL" ]; then
      echo "$URL" > "$URL_FILE"
      echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Tunnel URL: $URL"
      echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Full webhook: $URL/api/reset-password?action=telegram-verify-webhook-v3"
      # Also write full webhook URL
      echo "$URL/api/reset-password?action=telegram-verify-webhook-v3" > "$RUNNER_DIR/cloudflared-webhook-full-url.txt"
      exit 0
    fi
  fi
  sleep 1
done

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] WARNING: Tunnel URL not found after 30s, check $LOG_FILE"
cat "$LOG_FILE" | head -n 50
exit 1
