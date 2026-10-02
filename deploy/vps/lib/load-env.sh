#!/usr/bin/env bash
# =============================================================================
# Canonical environment loader for production wrappers (BUG-RT-02).
#
# Precedence — LAST file sourced wins, because sourcing reassigns the variable:
#   1. $REPO/.env                   repository defaults
#   2. $REPO/.env.intraday-runtime  repository production-specific values
#   3. $REPO/.env.local             repository local overrides
#   4. $RUNNER_DIR/.env             runner-owned runtime env (CANONICAL, wins)
#
# The runner-owned file is sourced LAST so it deterministically overrides
# repository/local-development values. A stale CRON_SECRET in repo .env.local
# used to be sourced after the runner .env, overwriting the valid secret and
# producing HTTP 401 from the local origin (BUG-RT-02).
#
# Missing files are skipped silently. Secret values are never printed. A blank
# value in a higher-priority file intentionally clears lower-priority values;
# callers that require a key MUST use require_nonempty_env() to fail closed
# instead of silently falling back to a stale repository value.
# =============================================================================

load_auto_cuan_env() {
  local repo="${1:-}"
  local runner="${2:-}"
  local env_file
  for env_file in "$repo/.env" "$repo/.env.intraday-runtime" "$repo/.env.local" "$runner/.env"; do
    if [ -n "$env_file" ] && [ -f "$env_file" ]; then
      set -a
      # shellcheck disable=SC1090
      source "$env_file" 2>/dev/null || true
      set +a
    fi
  done
}

# require_nonempty_env NAME VALUE — fail closed when a required key resolves to
# an empty or whitespace-only value. Never echoes the value itself.
require_nonempty_env() {
  local name="$1"
  local value="${2:-}"
  local compact="${value//[[:space:]]/}"
  if [ -z "$compact" ]; then
    echo "ENV_ERROR: $name kosong setelah memuat env repo+runner; menolak berjalan (fail-closed)." >&2
    return 1
  fi
  return 0
}
