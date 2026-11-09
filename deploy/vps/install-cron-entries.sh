#!/usr/bin/env bash
# Reconcile owned jobs with the canonical schedule, preserving unrelated jobs.
# V5 (BUG-V5-P0-006): canonical schedule now schedules catchup at 00:15 WIB
# (catchup-0015), OUTSIDE the forbidden window 23:50-00:10. A fresh install of
# this script therefore produces the corrected schedule automatically.
# Pre-flight: the canonical file is validated statically (forbidden window +
# cron/PM2 double-scheduling) before any crontab is touched.
set -euo pipefail
REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node)"; fi
# Debian/Ubuntu cron may ignore CRON_TZ. The daemon timezone must match too.
if [ "$DRY_RUN" -eq 0 ]; then
  SYSTEM_TZ="$(timedatectl show -p Timezone --value)"
  if [ "$SYSTEM_TZ" != "Asia/Jakarta" ]; then
    echo "Schedule not installed: system timezone must be Asia/Jakarta (found $SYSTEM_TZ)." >&2
    exit 1
  fi
fi
mkdir -p "$RUNNER_DIR/backup"
# Pre-flight static validation (BUG-V5-P0-006 + N13 double-scheduling guard).
# The canonical file must pass BEFORE any crontab is modified.
"$NODE_BIN" "$REPO/tools/validate-schedule.js"
CURRENT="$(mktemp)"
WORK="$(mktemp)"
trap 'rm -f "$CURRENT" "$WORK"' EXIT
# Do not turn a permission or daemon error into an empty crontab.
if ! crontab -l > "$CURRENT" 2> "$WORK"; then
  if ! grep -qi 'no crontab for' "$WORK"; then cat "$WORK" >&2; exit 1; fi
  : > "$CURRENT"
fi
cp "$CURRENT" "$RUNNER_DIR/backup/crontab-$(date +%Y%m%d-%H%M%S).bak"
"$NODE_BIN" "$REPO/lib/cron-reconcile.js" "$CURRENT" "$REPO/deploy/vps/final-schedule.cron" > "$WORK"
if [ "$DRY_RUN" -eq 1 ]; then
  diff -u "$CURRENT" "$WORK" || true
  echo "Dry run: crontab unchanged."
  exit 0
fi
if cmp -s "$CURRENT" "$WORK"; then echo "Schedule already synchronized."; exit 0; fi
crontab "$WORK"
echo "Canonical schedule installed. Unrelated jobs preserved; backup saved."
