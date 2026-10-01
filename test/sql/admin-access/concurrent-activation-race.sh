#!/usr/bin/env bash
# Real two-session PostgreSQL concurrency regression for the cross-ref
# activation race a prior review flagged: activate_admin_access_request sets
# activation_claimed_at and COMMITS (each RPC call is its own
# single-statement transaction) *before* Node ever calls bot.sendMessage();
# telegram_message_id is only recorded later by a separate RPC call. A slot
# invariant keyed only on telegram_message_id would let two DIFFERENT
# requestRefs for the SAME admin both get "claimed" if their
# activate_admin_access_request calls land close together, before either one
# reaches the later record_admin_access_message call — i.e. this is a race
# between two separate RPC calls/sessions, not a race inside a single one.
#
# This script proves the fix holds under GENUINE OS-level concurrency (two
# real, independently-connected psql processes), not just the sequential
# reproduction in runtime.sql. It relies on the app_users FOR UPDATE row
# lock inside activate_admin_access_request to serialize the two sessions:
# whichever session acquires that lock first must fully commit (including
# setting its own activation_claimed_at) before the other is even allowed to
# evaluate the sibling-claim check — so the outcome is deterministic
# (guaranteed by Postgres locking, not by timing luck), not flaky.
#
# Requires this database to already have the bootstrap + migration applied,
# and 'budi' bound to telegram_user_id 999999001 (matches
# test/sql/admin-access/bootstrap.sql).
set -euo pipefail

REF_A="concurrent-race-ref-aaaaaaaaaaaaaaaaaaaaaaaa"
REF_B="concurrent-race-ref-bbbbbbbbbbbbbbbbbbbbbbbb"
OUT_A="$(mktemp)"
OUT_B="$(mktemp)"
trap 'rm -f "$OUT_A" "$OUT_B"' EXIT

psql -v ON_ERROR_STOP=1 -q <<SQL
SELECT public.create_admin_access_request('budi', '${REF_A}', repeat('x', 64), now() + interval '2 minutes', '', NULL);
SELECT public.create_admin_access_request('budi', '${REF_B}', repeat('y', 64), now() + interval '2 minutes', '', NULL);
SQL

# Launch two independent psql client processes, each its own DB session/
# transaction, activating a DIFFERENT ref for the SAME admin, started back
# to back so their activate_admin_access_request calls genuinely contend for
# the same app_users row lock.
psql -v ON_ERROR_STOP=1 -t -A -c \
  "SELECT result_code FROM public.activate_admin_access_request('${REF_A}', 999999001, 700000001);" \
  >"$OUT_A" 2>&1 &
PID_A=$!

psql -v ON_ERROR_STOP=1 -t -A -c \
  "SELECT result_code FROM public.activate_admin_access_request('${REF_B}', 999999001, 700000002);" \
  >"$OUT_B" 2>&1 &
PID_B=$!

wait "$PID_A"
wait "$PID_B"

RESULT_A="$(tr -d '[:space:]' <"$OUT_A")"
RESULT_B="$(tr -d '[:space:]' <"$OUT_B")"

echo "session A (ref A) result: ${RESULT_A}"
echo "session B (ref B) result: ${RESULT_B}"

CLAIMED_COUNT=0
[ "$RESULT_A" = "claimed" ] && CLAIMED_COUNT=$((CLAIMED_COUNT + 1))
[ "$RESULT_B" = "claimed" ] && CLAIMED_COUNT=$((CLAIMED_COUNT + 1))

if [ "$CLAIMED_COUNT" -ne 1 ]; then
  echo "FAIL: expected exactly ONE of the two concurrent cross-ref activations to return 'claimed', got ${CLAIMED_COUNT} (A=${RESULT_A} B=${RESULT_B})"
  exit 1
fi

if [ "$RESULT_A" != "claimed" ] && [ "$RESULT_A" != "already_active" ]; then
  echo "FAIL: unexpected result for session A: ${RESULT_A}"
  exit 1
fi
if [ "$RESULT_B" != "claimed" ] && [ "$RESULT_B" != "already_active" ]; then
  echo "FAIL: unexpected result for session B: ${RESULT_B}"
  exit 1
fi

# Final DB state must show at most one live in-flight-claim/activated row
# for this admin, regardless of which session won.
ACTIVE_COUNT="$(psql -t -A -c "
  SELECT count(*) FROM public.admin_access_requests aar
   WHERE aar.user_id = (SELECT id FROM public.app_users WHERE username = 'budi')
     AND aar.state IN ('pending','approved')
     AND (aar.telegram_message_id IS NOT NULL OR aar.activation_claimed_at IS NOT NULL)
     AND aar.expires_at > now();
")"
ACTIVE_COUNT="$(echo "$ACTIVE_COUNT" | tr -d '[:space:]')"

if [ "$ACTIVE_COUNT" != "1" ]; then
  echo "FAIL: expected exactly 1 active delivery-claim row for the admin after the race, found ${ACTIVE_COUNT}"
  exit 1
fi

echo "--- concurrent cross-ref activation race regression: PASSED (exactly one claimed, DB ends with exactly one active claim) ---"
