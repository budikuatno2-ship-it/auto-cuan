#!/usr/bin/env bash
# =============================================================================
# Auto-Cuan VPS Deploy — tab keep-alive + spreadsheet-grade UI
# =============================================================================
#
# Runs the exact deploy sequence for the keep-alive / UI refinement / 502
# hardening change set, with a verification step after each stage so a failure
# stops the rollout instead of leaving a half-deployed origin.
#
# Usage (on the VPS):
#   cd /home/ubuntu/auto-cuan
#   bash tools/vps-deploy-keepalive-ui.sh
#
# Usage (from a workstation, one shot):
#   ssh ubuntu@168.110.221.197 'cd /home/ubuntu/auto-cuan && bash tools/vps-deploy-keepalive-ui.sh'
#
# The script is idempotent: re-running it after a failure is safe.
# =============================================================================

set -euo pipefail

BRANCH="${DEPLOY_BRANCH:-feat/tab-keepalive-ui-refined}"
APP_DIR="${APP_DIR:-/home/ubuntu/auto-cuan}"
PM2_APP="${PM2_APP:-autocuan-web}"
ORIGIN="http://127.0.0.1:3000"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://autocuan.web.id}"
NGINX_SITE="/etc/nginx/sites-available/autocuan"

step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  [ok] %s\n' "$1"; }
die()  { printf '\n[FAIL] %s\n' "$1" >&2; exit 1; }

cd "$APP_DIR" || die "app dir not found: $APP_DIR"

# -----------------------------------------------------------------------------
step "1/7  Working tree check"
# -----------------------------------------------------------------------------
# A dirty tree means someone edited on the box. Abort rather than clobber it.
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "working tree is dirty — commit or stash the changes above, then re-run"
fi
ok "clean tree at $(git rev-parse --short HEAD)"

# -----------------------------------------------------------------------------
step "2/7  Fetch + pull"
# -----------------------------------------------------------------------------
git fetch origin "$BRANCH"
BEFORE="$(git rev-parse HEAD)"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
AFTER="$(git rev-parse HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  ok "already at $AFTER (no new commits)"
else
  ok "advanced $(git rev-parse --short "$BEFORE") -> $(git rev-parse --short "$AFTER")"
fi

# -----------------------------------------------------------------------------
step "3/7  Sync 2026-09-25 broker cache"
# -----------------------------------------------------------------------------
# Backfills the pinned day the Broker Summary date dropdown resolves against.
# Skipped when the script is not present on this revision.
if [ -f tools/sync-sept25-broker-cache.js ]; then
  node tools/sync-sept25-broker-cache.js
  ok "broker cache synced"
else
  ok "sync script not present on this revision — skipped"
fi

# -----------------------------------------------------------------------------
step "4/7  Nginx config + reload"
# -----------------------------------------------------------------------------
# The ONLY thing this step needs is the exact-match /api/track-record alias.
# The installed file must NOT be replaced wholesale: certbot rewrites
# sites-available/autocuan to add the TLS server block, so copying the repo
# template over it would delete the certificate config and take HTTPS down.
#
# So: inspect, and only insert the alias block when it is genuinely missing.
if [ ! -f "$NGINX_SITE" ]; then
  printf '  [warn] %s not found — skipping the alias check.\n' "$NGINX_SITE"
elif sudo grep -q 'location = /api/track-record' "$NGINX_SITE" 2>/dev/null; then
  ok "the /api/track-record alias is already present"
else
  printf '  [warn] %s has no /api/track-record alias block.\n' "$NGINX_SITE"
  printf '         Add this INSIDE the server { } block that proxies to the origin,\n'
  printf '         ABOVE the generic "location /api/" block, then reload nginx:\n\n'
  cat <<'NGINX_SNIPPET'
    location = /api/track-record {
        limit_req zone=autocuan_api burst=20 nodelay;
        proxy_pass http://autocuan_web/api/sector-hot?action=track-record;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_intercept_errors off;
        add_header Cache-Control "private, no-store, no-cache, must-revalidate, max-age=0" always;
        proxy_no_cache 1;
        proxy_cache_bypass 1;
    }
NGINX_SNIPPET
  printf '\n'
fi

sudo nginx -t || die "nginx config test failed — NOT reloading"
sudo systemctl reload nginx
ok "nginx reloaded"

# -----------------------------------------------------------------------------
step "5/7  Build gate (test suite)"
# -----------------------------------------------------------------------------
# `npm run build` in this repo runs tools/run-build-test-suite.js, which parses
# every .js file, runs the pre-build patchers, and executes the smoke suite. It
# is the real gate; a red suite must stop the rollout.
npm run build
ok "build gate passed"

# -----------------------------------------------------------------------------
step "6/7  Restart PM2"
# -----------------------------------------------------------------------------
pm2 restart "$PM2_APP" --update-env
sleep 3
pm2 status "$PM2_APP" || pm2 status
ok "pm2 restarted"

# -----------------------------------------------------------------------------
step "7/7  Verify"
# -----------------------------------------------------------------------------
FAILED=0
check() { # label, url, expected-status
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$2" || echo 000)"
  if [ "$code" = "$3" ]; then
    ok "$1 -> HTTP $code"
  else
    printf '  [FAIL] %s -> HTTP %s (expected %s)\n' "$1" "$code" "$3"
    FAILED=1
  fi
}

check "origin root"            "$ORIGIN/"                      200
check "origin track-record"    "$ORIGIN/api/track-record"      200
check "origin sector-hot"      "$ORIGIN/api/sector-hot"        401
check "public root"            "$PUBLIC_ORIGIN/"               200
check "public track-record"    "$PUBLIC_ORIGIN/api/track-record" 200
check "public theme css"       "$PUBLIC_ORIGIN/ui-theme.css"   200
check "public keep-alive js"   "$PUBLIC_ORIGIN/tab-keepalive-runtime.js" 200
check "public spreadsheet css" "$PUBLIC_ORIGIN/spreadsheet-grade.css"   200

printf '\n  deployed revision: %s\n' "$(git rev-parse --short HEAD)"

if [ "$FAILED" -ne 0 ]; then
  printf '\n[WARN] at least one check failed. Inspect the nginx and pm2 logs:\n'
  printf '  sudo tail -50 /var/log/nginx/autocuan_error.log\n'
  printf '  pm2 logs %s --lines 80\n' "$PM2_APP"
  exit 1
fi

printf '\n[OK] deploy complete and verified.\n'
