#!/usr/bin/env bash
set -euo pipefail

ROOT="${AUTO_CUAN_ROOT:-/home/ubuntu/auto-cuan}"
CMD="${ROOT}/deploy/vps/backup-auto-cuan-data.sh"
LOG_DIR="/home/ubuntu/auto-cuan-backups"
CRON="30 1 * * * ${CMD} >> ${LOG_DIR}/backup.log 2>&1"

mkdir -p "${LOG_DIR}"
chmod +x "${CMD}"
TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT
crontab -l 2>/dev/null | grep -v "backup-auto-cuan-data.sh" > "${TMP}" || true
{
  cat "${TMP}"
  echo "CRON_TZ=Asia/Jakarta"
  echo "${CRON}"
} | awk '!seen[$0]++' | crontab -

echo "[backup-install] nightly backup installed at 01:30 WIB"
echo "[backup-install] snapshots kept on VPS: ${AUTO_CUAN_BACKUP_KEEP_SNAPSHOTS:-14}"
echo "[backup-install] backup root: ${LOG_DIR}"
