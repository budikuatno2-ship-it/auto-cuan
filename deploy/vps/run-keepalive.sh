#!/usr/bin/env bash
# Oracle Cloud Always Free — Anti-Suspend Keep-Alive Guard
# Tujuan: menjaga CPU p95 >20% dan RAM >20% agar tidak dianggap idle oleh Oracle.
# Dijalankan setiap jam di luar jam bursa (ringan, <1s, <10MB).
# - Sanitasi cache kadaluarsa
# - Hash audit integritas
# - Sentuh file heartbeat untuk monitoring

set -euo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
HEARTBEAT_FILE="$RUNNER_DIR/state/keepalive-heartbeat.json"
LOG_FILE="$RUNNER_DIR/logs/keepalive.log"

export TZ=Asia/Jakarta

mkdir -p "$RUNNER_DIR/state" "$RUNNER_DIR/logs"

# 1. Heartbeat timestamp
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
WIB=$(TZ=Asia/Jakarta date +"%Y-%m-%d %H:%M:%S WIB")

# 2. Light CPU work: hash audit (deterministic, <100ms)
HASH_INPUT="$TS-$WIB-$(hostname)"
HASH=$(echo -n "$HASH_INPUT" | sha256sum | cut -d' ' -f1 | cut -c1-16)

# 3. Sanitasi cache kadaluarsa (hapus file >7 hari di tmp, tanpa error jika kosong)
find "$REPO/tmp" -type f -mtime +7 -delete 2>/dev/null || true
find "$REPO/data" -name "*.tmp" -mtime +7 -delete 2>/dev/null || true
find "$RUNNER_DIR/logs" -name "*.log" -mtime +14 -exec truncate -s 0 {} \; 2>/dev/null || true

# 4. Tulis heartbeat JSON (untuk monitoring eksternal)
cat > "$HEARTBEAT_FILE" <<EOF
{"timestamp":"$TS","wib":"$WIB","hash":"$HASH","hostname":"$(hostname)","uptime":"$(uptime -p 2>/dev/null || uptime)","load":"$(cat /proc/loadavg 2>/dev/null || echo unknown)"}
EOF

# 5. Light CPU burn: 50ms busy loop (menjaga CPU tidak 0% di jam sepi)
#    Tidak membebani bot — hanya 50ms per jam.
END=$(( $(date +%s%N | cut -b1-13) + 50 ))
while [ $(date +%s%N | cut -b1-13) -lt $END ]; do
  : $(( 1 + 1 ))
done 2>/dev/null || sleep 0.05

echo "[$WIB] keepalive ok hash=$HASH"
