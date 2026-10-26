#!/usr/bin/env bash
# A4 evidence: observe /api/login-user behaviour with INVALID credentials only.
# No real account, password, token or secret is used. Prints status codes only.
set -uo pipefail
URL="http://127.0.0.1:3000/api/login-user"
HDR=(-H "Content-Type: application/json" -H "Origin: https://autocuan.web.id" -H "Host: autocuan.web.id")
JUNK_HASH="0000000000000000000000000000000000000000000000000000000000000000"

probe() { # $1=username
  curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" "${HDR[@]}" \
    -d "{\"username\":\"$1\",\"passwordHash\":\"$JUNK_HASH\",\"deviceId\":\"probe_dev\"}"
}

echo "normal_user_status=$(probe zzz_no_such_user_probe)"
echo "admin_username_status=$(probe budi)"
echo "review_user_status=$(probe review)"

echo "--- deployed getMode() on origin ---"
cd /home/ubuntu/auto-cuan 2>/dev/null && grep -n -A6 'function getMode' lib/security-guard.js | head -20