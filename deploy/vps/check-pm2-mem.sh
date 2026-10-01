#!/usr/bin/env bash
# Print PM2 per-process memory + enforce the <100MB budget.
set -uo pipefail
pm2 jlist | python3 -c '
import json, sys
procs = json.load(sys.stdin)
ok = True
for p in procs:
    mb = p["monit"]["memory"] / 1024 / 1024
    status = p["pm2_env"]["status"]
    flag = "OK" if mb < 100 else "OVER_BUDGET"
    if mb >= 100:
        ok = False
    print("%-32s %7.1fMB  %-10s %s" % (p["name"], mb, status, flag))
total = sum(p["monit"]["memory"] for p in procs) / 1024 / 1024
print("TOTAL_PM2_MB=%.1f" % total)
print("ALL_UNDER_100MB=" + ("true" if ok else "false"))
sys.exit(0 if ok else 1)
'
