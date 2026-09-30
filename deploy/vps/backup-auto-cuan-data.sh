#!/usr/bin/env bash
set -euo pipefail

ROOT="${AUTO_CUAN_ROOT:-/home/ubuntu/auto-cuan}"
DATA_ROOT="${AUTO_CUAN_DATA_ROOT:-/home/ubuntu/auto-cuan-data}"
BACKUP_ROOT="${AUTO_CUAN_BACKUP_ROOT:-/home/ubuntu/auto-cuan-backups}"
KEEP_SNAPSHOTS="${AUTO_CUAN_BACKUP_KEEP_SNAPSHOTS:-14}"
STAMP="$(TZ=Asia/Jakarta date +%Y-%m-%d_%H%M%S)"
DAILY_ROOT="${BACKUP_ROOT}/daily"
INCOMPLETE="${DAILY_ROOT}/.incomplete-${STAMP}"
FINAL="${DAILY_ROOT}/${STAMP}"

mkdir -p "${DAILY_ROOT}"
exec 9>"${BACKUP_ROOT}/.backup.lock"
if ! flock -n 9; then
  echo "[backup] another backup is already running; skip"
  exit 0
fi

if [[ ! -d "${ROOT}/data" ]]; then
  echo "[backup] ERROR: missing ${ROOT}/data" >&2
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then
  echo "[backup] ERROR: rsync is required" >&2
  exit 1
fi

PREV="$(find "${DAILY_ROOT}" -mindepth 1 -maxdepth 1 -type d -name "20??-??-??_??????" -printf "%T@ %p\n" 2>/dev/null | sort -nr | head -n 1 | cut -d" " -f2-)"
rm -rf "${INCOMPLETE}"
mkdir -p "${INCOMPLETE}/repo-data" "${INCOMPLETE}/vps-data" "${INCOMPLETE}/ops"

RSYNC_REPO=(rsync -aH --delete --numeric-ids)
if [[ -n "${PREV}" && -d "${PREV}/repo-data" ]]; then
  RSYNC_REPO+=(--link-dest="${PREV}/repo-data")
fi
RSYNC_REPO+=("${ROOT}/data/" "${INCOMPLETE}/repo-data/")
"${RSYNC_REPO[@]}"

if [[ -d "${DATA_ROOT}" ]]; then
  RSYNC_VPS=(rsync -aH --delete --numeric-ids)
  if [[ -n "${PREV}" && -d "${PREV}/vps-data" ]]; then
    RSYNC_VPS+=(--link-dest="${PREV}/vps-data")
  fi
  RSYNC_VPS+=("${DATA_ROOT}/" "${INCOMPLETE}/vps-data/")
  "${RSYNC_VPS[@]}"
fi

GIT_SHA="$(git -C "${ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"
CREATED="$(TZ=Asia/Jakarta date --iso-8601=seconds)"
{
  echo "auto_cuan_backup_version=1"
  echo "created_at_wib=${CREATED}"
  echo "hostname=$(hostname)"
  echo "git_sha=${GIT_SHA}"
  echo "repo_data_source=${ROOT}/data"
  echo "vps_data_source=${DATA_ROOT}"
  echo "snapshot=${STAMP}"
  echo "keep_snapshots=${KEEP_SNAPSHOTS}"
  echo "secrets_included=no"
} > "${INCOMPLETE}/ops/manifest.txt"

{
  echo "# Auto-Cuan persistent market-data inventory"
  echo "# ${CREATED}"
  echo
  du -sh "${ROOT}/data" 2>/dev/null || true
  [[ -d "${DATA_ROOT}" ]] && du -sh "${DATA_ROOT}" 2>/dev/null || true
  echo
  for p in \
    "${ROOT}/data/daily-candles" \
    "${ROOT}/data/arjum-data/broker-summary" \
    "${ROOT}/data/market-structure" \
    "${ROOT}/data/insider-network" \
    "${ROOT}/data/reports" \
    "${ROOT}/data/screener-latest.json"; do
    [[ -e "${p}" ]] && du -sh "${p}" 2>/dev/null || true
  done
} > "${INCOMPLETE}/ops/inventory.txt"

find "${INCOMPLETE}/repo-data" -type f -printf "%P\n" | sort > "${INCOMPLETE}/ops/repo-files.txt"
if [[ -d "${DATA_ROOT}" ]]; then
  find "${INCOMPLETE}/vps-data" -type f -printf "%P\n" | sort > "${INCOMPLETE}/ops/vps-data-files.txt"
else
  : > "${INCOMPLETE}/ops/vps-data-files.txt"
fi

# Atomic publish: a snapshot is visible only after rsync + inventory finish.
mv "${INCOMPLETE}" "${FINAL}"
ln -sfn "${FINAL}" "${BACKUP_ROOT}/latest"

# Keep the newest N snapshots. This deletes OLD SNAPSHOT VERSIONS only;
# it never deletes source candles/broker-summary/history from the live data.
mapfile -t OLD < <(find "${DAILY_ROOT}" -mindepth 1 -maxdepth 1 -type d -name "20??-??-??_??????" -printf "%T@ %p\n" | sort -nr | tail -n "+$((KEEP_SNAPSHOTS + 1))" | cut -d" " -f2-)
for dir in "${OLD[@]:-}"; do
  [[ -n "${dir}" ]] && rm -rf -- "${dir}"
done

echo "[backup] OK snapshot=${FINAL}"
echo "[backup] live repo data remains untouched: ${ROOT}/data"
echo "[backup] retained snapshot versions: ${KEEP_SNAPSHOTS}"
echo "[backup] apparent snapshot size: $(du -sh "${FINAL}" | awk '{print $1}')"
echo "[backup] physical backup root size: $(du -sh "${BACKUP_ROOT}" | awk '{print $1}')"
