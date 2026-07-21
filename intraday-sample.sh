#!/usr/bin/env bash
#
# Intraday Sample Collector — VPS runner wrapper (one-day research: 2026-07-21 WIB)
#
# Deployed path on the VPS:
#   /home/ubuntu/auto-cuan-runner/intraday-sample.sh
#
# Purpose:
#   Thin, safety-hardened wrapper around tools/intraday-sample-collector.js so
#   that every cron invocation runs with the SAME guaranteed-safe environment,
#   regardless of the caller's shell/cron environment.
#
# This wrapper is COLLECTION-ONLY. It hard-sets the safety flags below and
# never enables scoring, mutation, recommendations, or Telegram delivery.
#
# Usage:
#   ./intraday-sample.sh <HH:MM>
# Example:
#   ./intraday-sample.sh 09:15
#
set -euo pipefail

# --- Hard-set safety flags (cannot be overridden by the cron environment) ---
export DAYTRADE_INTRADAY_SCORE_ENABLED=false
export DAYTRADE_WORKER_ALLOW_MUTATION=false
# Extra defense-in-depth: never allow Telegram from a sample run.
export SAMPLE_SEND_TELEGRAM=false

# --- Resolve the repository directory (directory this script lives in) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

# --- Scheduled time argument (must be one of the 21 approved WIB slots) ---
SCHEDULED_TIME="${1:-}"
if [ -z "$SCHEDULED_TIME" ]; then
  echo "[intraday-sample] ERROR: missing scheduled time argument (expected HH:MM)" >&2
  exit 2
fi

# --- Ensure the local sample log directory exists ---
mkdir -p logs/intraday-samples

# --- Resolve node binary (prefer an absolute path if available) ---
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[intraday-sample] ERROR: node not found on PATH" >&2
  exit 3
fi

echo "[intraday-sample] $(date '+%Y-%m-%d %H:%M:%S %Z %z') running scheduled-time=$SCHEDULED_TIME (score_enabled=$DAYTRADE_INTRADAY_SCORE_ENABLED, allow_mutation=$DAYTRADE_WORKER_ALLOW_MUTATION)"

exec "$NODE_BIN" tools/intraday-sample-collector.js --scheduled-time "$SCHEDULED_TIME"
