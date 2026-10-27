#!/usr/bin/env bash
# A4 evidence (part 2): confirm no throttle appears on repeated failures, and
# inspect the DEPLOYED guard admin fail-closed logic + admin-username config
# presence (never prints secret values).
set -uo pipefail
URL="http://127.0.0.1:3000/api/login-user"
HDR=(-H "Content-Type: application/json" -H "Origin: https://autocuan.web.id" -H "Host: autocuan.web.id")
JUNK="0000000000000000000000000000000000000000000000000000000000000000"
echo "repeated_failures_status_codes:"
for i in $(seq 1 8); do
  curl -s -o /dev/null -w "%{http_code} " -X POST "$URL" "${HDR[@]}" \
    -d "{\"username\":\"zzz_probe_user\",\"passwordHash\":\"$JUNK\",\"deviceId\":\"probe_dev\"}"
done
echo
echo "--- deployed shouldFailClosedAdmin ---"
cd /home/ubuntu/auto-cuan 2>/dev/null && grep -n -A8 'function shouldFailClosedAdmin' lib/security-guard.js | head -12
echo "--- admin username config presence (web process) ---"
PID=$(pgrep -f 'local-dev-server.js' | head -1)
tr '\0' '\n' < "/proc/$PID/environ" > /tmp/_wcenv 2>/dev/null
if grep -qE '^PRIMARY_ADMIN_USERNAME=' /tmp/_wcenv; then echo "primary_admin_username=set"; else echo "primary_admin_username=unset"; fi
if grep -qE '^ADMIN_USERNAME=' /tmp/_wcenv; then echo "admin_username=set"; else echo "admin_username=unset"; fi
if grep -qE '^SECURITY_ALERTS_ENABLED=' /tmp/_wcenv; then echo "alerts_enabled=set"; else echo "alerts_enabled=unset"; fi
rm -f /tmp/_wcenv