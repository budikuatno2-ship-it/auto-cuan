#!/usr/bin/env bash
# One-shot deploy helper for the command-isolation + deep-link UX release.
#
# The VPS checkout previously sat on `feat/daytrade-screener-v1` with a few
# uncommitted edits that are now superseded by commits on
# `feat/daytrade-screener-v1-gatekeeper-20250925`. This script:
#   1. backs up the current working tree diff (never loses local work),
#   2. switches to the release branch,
#   3. fast-forwards to origin,
#   4. verifies the new files landed and are executable,
#   5. restarts PM2 and saves the process list.
#
# It never touches .env files and never force-resets the checkout.
#
# Usage: deploy/vps/apply-pr-command-isolation.sh

set -uo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
RUNNER_DIR="${AUTO_CUAN_RUNNER_DIR:-/home/ubuntu/auto-cuan-runner}"
BRANCH="feat/daytrade-screener-v1-gatekeeper-20250925"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$RUNNER_DIR/backup"

export TZ=Asia/Jakarta

mkdir -p "$BACKUP_DIR"
cd "$REPO" || exit 1

echo "[$STAMP] === 1. Backing up the current working tree ==="
git diff > "$BACKUP_DIR/pre-switch-$STAMP.patch"
echo "Backup: $BACKUP_DIR/pre-switch-$STAMP.patch ($(wc -l < "$BACKUP_DIR/pre-switch-$STAMP.patch") lines)"
git status --short | tee "$BACKUP_DIR/pre-switch-$STAMP.status.txt"

echo
echo "=== 2. Switching to $BRANCH ==="
git fetch origin --prune
git checkout "$BRANCH" || {
  echo "CHECKOUT_FAILED — the backup patch is at $BACKUP_DIR/pre-switch-$STAMP.patch"
  exit 1
}

echo
echo "=== 3. Fast-forward to origin ==="
git pull --ff-only origin "$BRANCH" || {
  echo "PULL_FAILED (not a fast-forward) — resolve manually. Backup: $BACKUP_DIR/pre-switch-$STAMP.patch"
  exit 1
}
git log --oneline -1

echo
echo "=== 4. Verifying the release artefacts ==="
FAILED=0
for f in \
  lib/ai-evaluator.js \
  tools/switch-verify-webhook.js \
  deploy/vps/run-sector-hot.sh \
  deploy/vps/run-webhook-failover.sh \
  test/command-isolation-deeplink.test.js \
  public/register.html \
  api/bot-register.js
do
  if [ -f "$f" ]; then
    echo "OK       $f"
  else
    echo "MISSING  $f"
    FAILED=1
  fi
done

for f in deploy/vps/run-sector-hot.sh deploy/vps/run-webhook-failover.sh; do
  if [ -x "$f" ]; then
    echo "EXEC     $f"
  else
    echo "CHMOD    $f"
    chmod +x "$f"
  fi
done

# .env files must never be tracked by this branch.
if git ls-files | grep -E '(^|/)\.env$' >/dev/null 2>&1; then
  echo "WARNING: a tracked .env exists — investigate before continuing"
  FAILED=1
else
  echo "OK       no .env tracked"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "VERIFY_FAILED — not restarting PM2"
  exit 1
fi

echo
echo "=== 5. Restarting PM2 ==="
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart all --update-env
  pm2 save
else
  echo "PM2_NOT_FOUND"
  exit 1
fi

echo
echo "=== 6. PM2 status ==="
pm2 list

echo
echo "DEPLOY_OK branch=$BRANCH commit=$(git rev-parse --short HEAD) backup=$BACKUP_DIR/pre-switch-$STAMP.patch"
