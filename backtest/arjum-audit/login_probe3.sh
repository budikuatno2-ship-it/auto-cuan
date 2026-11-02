#!/usr/bin/env bash
# B2 post-deploy evidence: confirm the throttle now engages on the origin.
# Uses a THROWAWAY username so no real account is affected. Prints status codes only.
set -uo pipefail
URL="http://127.0.0.1:3000/api/login-user"
HDR=(-H "Content-Type: application/json" -H "Origin: https://autocuan.web.id" -H "Host: autocuan.web.id")
JUNK="0000000000000000000000000000000000000000000000000000000000000000"
U="secprobe_$(date +%s)"
echo "probe_username=$U"
echo -n "codes: "
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "%{http_code} " -X POST "$URL" "${HDR[@]}" \
    -d "{\"username\":\"$U\",\"passwordHash\":\"$JUNK\",\"deviceId\":\"probe_dev\"}"
done
echo
echo "--- throttle store (metadata only) ---"
ls -la /tmp/autocuan-login-throttle.sqlite 2>/dev/null || echo "no_tmp_db"
if [ -n "${LOGIN_THROTTLE_DB:-}" ]; then echo "LOGIN_THROTTLE_DB is set"; else echo "LOGIN_THROTTLE_DB unset (default /tmp/autocuan-login-throttle.sqlite)"; fi