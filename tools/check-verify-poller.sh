#!/usr/bin/env bash
# Forwarder: tools/check-verify-poller.sh -> deploy/vps/check-verify-poller.sh
#
# The audit/crontab historically referenced this path and cron's /bin/sh logged
#   "/bin/sh: 1: check-verify-poller.sh: Permission denied"
# every 5 minutes. The canonical watchdog lives in deploy/vps/. This thin
# forwarder exists so either path works, and both are invoked through
# /bin/bash explicitly in crontab.
#
# Crontab (2026-10-13):
#   */5 * * * * /bin/bash /home/ubuntu/auto-cuan/tools/check-verify-poller.sh >> \
#     /home/ubuntu/auto-cuan-runner/logs/verify-poller.log 2>&1

set -uo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
TARGET="$REPO/deploy/vps/check-verify-poller.sh"

if [ ! -f "$TARGET" ]; then
  echo "[$(date '+%F %T %Z')] check-verify-poller: target tidak ditemukan: $TARGET"
  exit 1
fi

exec /bin/bash "$TARGET" "$@"
