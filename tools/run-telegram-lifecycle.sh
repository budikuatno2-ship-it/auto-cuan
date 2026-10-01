#!/usr/bin/env bash
# ===========================================================================
# Secure VPS wrapper for the Telegram member-lifecycle runner.
#
# Responsibilities:
#   * resolve the repository directory safely (independent of the caller's CWD);
#   * load secrets from an EXTERNAL env file (never hard-coded, never in crontab);
#   * require that env file to exist and to have owner-only permissions
#     (reject any group/world access);
#   * never print secret values;
#   * hold an exclusive lock so overlapping daily runs cannot stack;
#   * invoke `node tools/run-telegram-lifecycle.js --execute`;
#   * exit non-zero on any failure.
#
# The default env-file / lock-file locations match the documented VPS layout but
# can be overridden (e.g. for testing) via TELEGRAM_LIFECYCLE_ENV_FILE /
# TELEGRAM_LIFECYCLE_LOCK_FILE.
#
# Proposed cron (env stays OUT of crontab; the runner loads it from the env file):
#   15 2 * * * /home/ubuntu/auto-cuan/tools/run-telegram-lifecycle.sh >> /home/ubuntu/auto-cuan/logs/telegram-lifecycle.log 2>&1
# ===========================================================================
set -euo pipefail

# --- Resolve repo dir safely (this script lives in <repo>/tools) -----------
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

ENV_FILE="${TELEGRAM_LIFECYCLE_ENV_FILE:-/home/ubuntu/auto-cuan-runner/telegram-lifecycle.env}"
LOCK_FILE="${TELEGRAM_LIFECYCLE_LOCK_FILE:-/tmp/auto-cuan-telegram-lifecycle.lock}"
NODE_BIN="${NODE_BIN:-node}"

log()  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { printf '%s ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

# --- 1. Require the env file to exist --------------------------------------
[ -f "$ENV_FILE" ] || fail "env file not found: $ENV_FILE"

# --- 2. Reject insecure permissions (any group/world access) ---------------
# Accept only owner-readable/writable modes (e.g. 600/400); reject 6xx with any
# group/other bits set, 640, 644, 660, 664, etc.
perms="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo '')"
[ -n "$perms" ] || fail "cannot determine permissions of $ENV_FILE"
if [ "$(( 0${perms} & 077 ))" -ne 0 ]; then
  fail "insecure permissions on $ENV_FILE ($perms); require owner-only (e.g. chmod 600)"
fi

# --- 3. Load secrets WITHOUT printing them ---------------------------------
# `set -a` exports every variable defined by the env file so the child node
# process inherits them. Values are never echoed.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# --- 4. Serialize with an exclusive lock (no overlapping daily runs) --------
exec 9>"$LOCK_FILE" || fail "cannot open lock file: $LOCK_FILE"
if ! flock -n 9; then
  fail "another telegram-lifecycle run is already in progress (lock: $LOCK_FILE)"
fi

# --- 5. Run the Node runner in execute mode --------------------------------
cd "$REPO_DIR" || fail "cannot enter repo dir: $REPO_DIR"
log "starting telegram-lifecycle runner (execute)"
"$NODE_BIN" tools/run-telegram-lifecycle.js --execute
status=$?
log "telegram-lifecycle runner finished (exit $status)"
exit "$status"
