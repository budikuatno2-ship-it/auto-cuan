#!/usr/bin/env bash
# A4 evidence: report ONLY the presence/absence of relevant env keys for the
# autocuan-web process. Never prints any secret value (guard mode / fail-closed
# flag are configuration, not secrets).
set -uo pipefail
PID=$(pgrep -f 'local-dev-server.js' | head -1)
if [ -z "$PID" ]; then echo "web_pid_found=no"; exit 0; fi
echo "web_pid_found=yes"
tr '\0' '\n' < "/proc/$PID/environ" > /tmp/_wcenv 2>/dev/null || { echo "environ_unreadable"; exit 0; }
echo "guard_mode=$(grep -E '^SECURITY_GUARD_MODE=' /tmp/_wcenv | cut -d= -f2)"
echo "fail_closed_admin=$(grep -E '^SECURITY_GUARD_FAIL_CLOSED_ADMIN=' /tmp/_wcenv | cut -d= -f2)"
if grep -qE '^SECURITY_EVENT_PEPPER=' /tmp/_wcenv; then echo "pepper=set"; else echo "pepper=unset"; fi
if grep -qE '^RECAPTCHA_SECRET_KEY=' /tmp/_wcenv; then echo "recaptcha_secret=set"; else echo "recaptcha_secret=unset"; fi
if grep -qE '^SESSION_SECRET=' /tmp/_wcenv; then echo "session_secret=set"; else echo "session_secret=unset"; fi
echo "node_env=$(grep -E '^NODE_ENV=' /tmp/_wcenv | cut -d= -f2)"
rm -f /tmp/_wcenv