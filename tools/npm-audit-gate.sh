#!/usr/bin/env bash
# Production dependency vulnerability gate.
#
# Runs `npm audit --omit=dev --audit-level=high` and fails on real high or
# critical vulnerabilities, exactly as before. The only thing added is a retry
# for the case where the audit could not run at all.
#
# Why: registry.npmjs.org intermittently answers the audit endpoint with 503
# Service Unavailable or 400 Bad Request ("Invalid package tree"), sometimes
# after hanging for minutes. npm exits 1 for that, indistinguishably from
# "vulnerabilities found", so a transient registry outage read as a failed
# security gate and blocked every pull request at random.
#
# This deliberately does NOT change what the gate accepts:
#   - a real vulnerability fails immediately, with no retry;
#   - if the audit still cannot run after every attempt, the gate FAILS.
#     "Could not be checked" must never be silently read as "safe".

set -uo pipefail

ATTEMPTS="${NPM_AUDIT_ATTEMPTS:-3}"
ATTEMPT_TIMEOUT="${NPM_AUDIT_TIMEOUT_SECONDS:-180}"
BACKOFF_SECONDS="${NPM_AUDIT_BACKOFF_SECONDS:-15}"
NPM_BIN="${NPM_BIN:-npm}"

# Text npm prints when it reached the registry but the registry refused to
# answer, as opposed to a genuine vulnerability report.
is_registry_failure() {
  grep -qiE 'audit endpoint returned an error|Service Unavailable|Bad Request|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|network' <<<"$1"
}

attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  echo "::group::npm audit attempt ${attempt}/${ATTEMPTS}"
  set +e
  output="$(timeout "${ATTEMPT_TIMEOUT}" "${NPM_BIN}" audit --omit=dev --audit-level=high 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"
  echo "::endgroup::"

  if [ "$status" -eq 0 ]; then
    echo "Dependency vulnerability gate passed."
    exit 0
  fi

  # A timeout (124) means the registry never answered either.
  if [ "$status" -ne 124 ] && ! is_registry_failure "$output"; then
    echo "::error::npm audit reported high or critical vulnerabilities in production dependencies."
    exit "$status"
  fi

  echo "::warning::npm audit could not reach the registry (exit ${status}) on attempt ${attempt}/${ATTEMPTS}."
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep $(( BACKOFF_SECONDS * attempt ))
  fi
  attempt=$(( attempt + 1 ))
done

# Fail closed. The dependency tree was never actually checked, and saying
# nothing here would turn "unknown" into "safe".
echo "::error::npm audit could not be completed after ${ATTEMPTS} attempts, so production dependencies were NOT verified. Failing the gate rather than assuming they are safe."
exit 1
