#!/usr/bin/env bash
# Oracle Cloud Always Free — Anti-Suspend Keep-Alive Guard
# Menjaga CPU p95 >20% dan RAM >20% agar tidak dianggap idle oleh Oracle Cloud.
# Menjalankan komputasi duty cycle terkontrol (20-25% CPU selama 90s) jika sistem idle >4 jam.

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
HEARTBEAT_FILE="$RUNNER_DIR/state/keepalive-heartbeat.json"
LOG_FILE="$RUNNER_DIR/logs/keepalive.log"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

# Use Node.js keepalive watchdog when available
NODE_BIN="/home/ubuntu/.local/node-v22/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || echo "")
fi

if [ -n "$NODE_BIN" ] && [ -f "$REPO/tools/vps-keepalive.js" ]; then
  exec "$NODE_BIN" "$REPO/tools/vps-keepalive.js" "$@"
fi

# Fallback bash implementation if node is not found
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
WIB=$(TZ=Asia/Jakarta date +"%Y-%m-%d %H:%M:%S WIB")
HASH_INPUT="$TS-$WIB-$(hostname)"
HASH=$(echo -n "$HASH_INPUT" | sha256sum | cut -d' ' -f1 | cut -c1-16)

find "$REPO/tmp" -type f -mtime +7 -delete 2>/dev/null || true
find "$REPO/data" -name "*.tmp" -mtime +7 -delete 2>/dev/null || true
find "$RUNNER_DIR/logs" -name "*.log" -mtime +14 -exec truncate -s 0 {} \; 2>/dev/null || true

cat > "$HEARTBEAT_FILE" <<EOF
{"timestamp":"$TS","wib":"$WIB","hash":"$HASH","hostname":"$(hostname)","uptime":"$(uptime -p 2>/dev/null || uptime)","load":"$(cat /proc/loadavg 2>/dev/null || echo unknown)"}
EOF

END=$(( $(date +%s%N | cut -b1-13) + 1000 ))
while [ $(date +%s%N | cut -b1-13) -lt $END ]; do
  : $(( 1 + 1 ))
done 2>/dev/null || sleep 0.1

echo "[$WIB] keepalive fallback ok hash=$HASH"
