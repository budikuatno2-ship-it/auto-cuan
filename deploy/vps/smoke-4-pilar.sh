#!/usr/bin/env bash
# Smoke test the 4 screener pillars in dry-run mode on the VPS.
# Exits non-zero if any mode throws (no candidate is acceptable: the snapshot
# only exists after the nightly producer runs).
set -uo pipefail

REPO="${AUTO_CUAN_REPO:-/home/ubuntu/auto-cuan}"
NODE_BIN="${AUTO_CUAN_NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
cd "$REPO"

[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"

FAIL=0
for MODE in daytrade fastwatcher swing-konglo swing-non-konglo; do
  echo "=== mode=$MODE ==="
  OUT="$("$NODE_BIN" tools/run-screener.js --mode="$MODE" --dry-run 2>&1)"
  STATUS=$?
  echo "$OUT" | head -6
  if [ "$STATUS" -ne 0 ] && [ "$STATUS" -ne 2 ]; then
    # exit 2 is the documented "no candidates / gate blocked" code, not a crash
    echo "FAIL mode=$MODE exit=$STATUS"
    FAIL=1
  fi
  if echo "$OUT" | grep -qE "Cannot find module|MODULE_NOT_FOUND|SyntaxError"; then
    echo "FAIL mode=$MODE module/syntax error"
    FAIL=1
  fi
  echo "---"
done

if [ "$FAIL" -ne 0 ]; then
  echo "SMOKE_4_PILAR=FAIL"
  exit 1
fi
echo "SMOKE_4_PILAR=PASS"
