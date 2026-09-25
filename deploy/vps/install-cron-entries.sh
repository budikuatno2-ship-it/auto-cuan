#!/usr/bin/env bash
# Idempotently install the hybrid cron entries that are not yet present in the
# ubuntu crontab. The canonical schedule lives in deploy/vps/final-schedule.cron;
# this helper only ADDS the missing lines and never rewrites existing ones.
#
# Usage: deploy/vps/install-cron-entries.sh [--dry-run]

set -uo pipefail

RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
BACKUP_DIR="$RUNNER_DIR/backup"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

export TZ=Asia/Jakarta
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
CURRENT="$(mktemp)"
WORK="$(mktemp)"
trap 'rm -f "$CURRENT" "$WORK"' EXIT

crontab -l > "$CURRENT" 2>/dev/null || true
cp "$CURRENT" "$BACKUP_DIR/crontab-$STAMP.bak"
echo "Backup: $BACKUP_DIR/crontab-$STAMP.bak"

# --- Entry definitions ------------------------------------------------------
# Each entry is "<marker-regex>|<comment-block>|<cron-line>".
SECTOR_HOT_MARKER='run-sector-hot\.sh'
SECTOR_HOT_BLOCK='# ── HYBRID SECTOR HOT (Vercel primer → runner lokal VPS) ────────────────
# Pemicu endpoint Vercel dulu; jika response bukan HTTP 200, runner lokal
# (tools/run-screener.js) dieksekusi mandiri agar snapshot sektor tetap segar.
*/30 9-15 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-sector-hot.sh >> /home/ubuntu/auto-cuan-runner/logs/sector-hot.log 2>&1'

WEBHOOK_MARKER='run-webhook-failover\.sh'
WEBHOOK_BLOCK='# ── HYBRID WEBHOOK FAILOVER (Vercel primer ⇄ VPS fallback) ──────────────
# Menjaga webhook verifikasi bot: tetap di Vercel saat sehat, otomatis pindah
# ke tunnel VPS saat Vercel paused/402, dan kembali ke Vercel saat pulih.
*/10 * * * * /home/ubuntu/auto-cuan/deploy/vps/run-webhook-failover.sh >> /home/ubuntu/auto-cuan-runner/logs/webhook-failover.log 2>&1'

cp "$CURRENT" "$WORK"

add_block() {
  local marker="$1"
  local block="$2"
  local label="$3"
  if grep -qE "$marker" "$WORK"; then
    echo "PRESENT  $label"
    return 0
  fi
  # Insert before the keep-alive section when present, otherwise append.
  if grep -q 'ORACLE ANTI-SUSPEND KEEP-ALIVE' "$WORK"; then
    local line
    line="$(grep -n 'ORACLE ANTI-SUSPEND KEEP-ALIVE' "$WORK" | head -1 | cut -d: -f1)"
    # Back up over the preceding comment banner line so the block lands cleanly.
    local insert_at=$((line - 1))
    [ "$insert_at" -lt 1 ] && insert_at=1
    {
      head -n $((insert_at - 1)) "$WORK"
      printf '%s\n\n' "$block"
      tail -n +"$insert_at" "$WORK"
    } > "$WORK.new"
  else
    {
      cat "$WORK"
      printf '\n%s\n' "$block"
    } > "$WORK.new"
  fi
  mv "$WORK.new" "$WORK"
  echo "ADDED    $label"
}

add_block "$WEBHOOK_MARKER" "$WEBHOOK_BLOCK" "webhook failover (ten-minute cron)"
add_block "$SECTOR_HOT_MARKER" "$SECTOR_HOT_BLOCK" "sector hot hybrid runner"

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "--- DRY RUN result ---"
  diff -u "$CURRENT" "$WORK" || true
  echo "Dry run: crontab NOT modified."
  exit 0
fi

crontab "$WORK"
echo
echo "Installed. Active hybrid entries:"
crontab -l | grep -E 'run-webhook-failover\.sh|run-sector-hot\.sh' || echo "NONE_FOUND"
