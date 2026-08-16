-- Real-PostgreSQL runtime regression for the admin-access RPCs.
--
-- This exists because the JS test suite (test/admin-telegram-access.test.js)
-- stubs db.rpc() with a JS model of the state machine — it cannot catch a
-- genuine PL/pgSQL runtime error like "column reference ... is ambiguous",
-- which only fires when the real Postgres planner resolves an unqualified
-- column name against both a table column and a same-named RETURNS TABLE
-- output parameter. A production smoke test hit exactly this in
-- create_admin_access_request. Every assertion below runs the real SQL
-- functions against a real PostgreSQL server so a regression here fails CI,
-- not just a mock.
\set ON_ERROR_STOP on

\echo '--- runtime: create_admin_access_request must not raise an ambiguous-column error ---'
DO $$
DECLARE
  v_row record;
BEGIN
  SELECT * INTO v_row FROM public.create_admin_access_request(
    'budi', 'runtime-test-ref-0000000000000001', repeat('a', 64), now() + interval '2 minutes', 'runtime-test', NULL
  );
  IF v_row.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_row.result_code;
  END IF;
  IF v_row.telegram_user_id IS DISTINCT FROM 999999001 THEN
    RAISE EXCEPTION 'telegram_user_id resolved incorrectly (ambiguous-column symptom): got %', v_row.telegram_user_id;
  END IF;
  IF v_row.user_id IS NULL THEN
    RAISE EXCEPTION 'user_id resolved incorrectly (ambiguous-column symptom): got NULL';
  END IF;
END
$$;

\echo '--- runtime: not-eligible and not-bound branches (also unqualified-column sites) still resolve cleanly ---'
INSERT INTO public.app_users (username, is_approved) VALUES ('not-budi', true);
DO $$
DECLARE
  v_row record;
BEGIN
  SELECT * INTO v_row FROM public.create_admin_access_request(
    'not-budi', 'runtime-test-ref-0000000000000002', repeat('b', 64), now() + interval '2 minutes', '', NULL
  );
  IF v_row.result_code IS DISTINCT FROM 'not_eligible' THEN
    RAISE EXCEPTION 'expected not_eligible, got %', v_row.result_code;
  END IF;
END
$$;

INSERT INTO public.app_users (username, is_approved) VALUES ('unbound-admin', true);
DO $$
DECLARE
  v_row record;
BEGIN
  -- Exercises the not_bound branch; username check requires literal 'budi',
  -- so this specific branch is otherwise unreachable for a non-budi account.
  -- Prove the query plan alone (no ambiguity abort) by calling with 'budi'
  -- after temporarily removing its verification row, then restoring it.
  DELETE FROM public.app_user_telegram_verifications
   WHERE user_id = (SELECT id FROM public.app_users WHERE username = 'budi');

  SELECT * INTO v_row FROM public.create_admin_access_request(
    'budi', 'runtime-test-ref-0000000000000003', repeat('c', 64), now() + interval '2 minutes', '', NULL
  );
  IF v_row.result_code IS DISTINCT FROM 'not_bound' THEN
    RAISE EXCEPTION 'expected not_bound, got %', v_row.result_code;
  END IF;

  INSERT INTO public.app_user_telegram_verifications (user_id, telegram_user_id, telegram_private_chat_id, telegram_verified_at)
    SELECT id, 999999001, 999999001, now() FROM public.app_users WHERE username = 'budi';
END
$$;

\echo '--- runtime: a dormant (never Telegram-activated) row must NOT block a second create call for the same admin ---'
DO $$
DECLARE
  v_row record;
BEGIN
  -- runtime-test-ref-0000000000000001 from above is still 'pending' and
  -- unexpired but was never activated (telegram_message_id IS NULL). A
  -- second create call for the same admin must still succeed — this is the
  -- direct regression check for the admin-slot-griefing fix.
  SELECT * INTO v_row FROM public.create_admin_access_request(
    'budi', 'runtime-test-ref-0000000000000004', repeat('d', 64), now() + interval '2 minutes', '', NULL
  );
  IF v_row.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'a dormant, never-activated challenge must never block a new one (griefing regression), got %', v_row.result_code;
  END IF;
END
$$;

\echo '--- runtime: THE REPORTED RACE — a claimed-but-not-yet-delivered request must block a sibling activation BEFORE telegram_message_id is ever set ---'
-- This is the exact gap a prior review found: activate_admin_access_request
-- sets activation_claimed_at and COMMITS (each RPC call is its own
-- single-statement transaction) *before* Node ever calls bot.sendMessage().
-- telegram_message_id is only recorded by a LATER, separate RPC call
-- (record_admin_access_message) after that external send succeeds. A slot
-- invariant that only looked at telegram_message_id would let a second
-- dormant sibling ref also get "claimed" during that gap — reproduced here
-- deterministically by calling activate() on ref ...0004, DELIBERATELY NOT
-- calling record_admin_access_message yet, and then attempting to activate
-- a sibling ref for the same admin.
DO $$
DECLARE
  v_activate record;
  v_activate_sibling record;
BEGIN
  SELECT * INTO v_activate FROM public.activate_admin_access_request(
    'runtime-test-ref-0000000000000004', 999999001, 555000001
  );
  IF v_activate.result_code IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'expected claimed, got %', v_activate.result_code;
  END IF;

  -- telegram_message_id is still NULL here — record_admin_access_message has
  -- NOT been called yet. If the slot invariant only looked at
  -- telegram_message_id, this next call would incorrectly also succeed.
  IF EXISTS (SELECT 1 FROM public.admin_access_requests WHERE request_ref = 'runtime-test-ref-0000000000000004' AND telegram_message_id IS NOT NULL) THEN
    RAISE EXCEPTION 'test setup invariant broken: telegram_message_id must still be NULL at this point';
  END IF;

  SELECT * INTO v_activate_sibling FROM public.activate_admin_access_request(
    'runtime-test-ref-0000000000000001', 999999001, 555000002
  );
  IF v_activate_sibling.result_code IS DISTINCT FROM 'already_active' THEN
    RAISE EXCEPTION 'THE REPORTED RACE REGRESSED: a sibling ref was activated (got %) while another was claimed but not yet delivered — two Telegram approval messages could be sent', v_activate_sibling.result_code;
  END IF;

  -- Now complete delivery for ref ...0004 (simulates Node's bot.sendMessage
  -- succeeding after the gap above).
  PERFORM public.record_admin_access_message('runtime-test-ref-0000000000000004', 555000001, 777001);
END
$$;

DO $$
DECLARE
  v_create record;
BEGIN
  -- ref ...0004 is now fully Telegram-activated — a brand-new create call
  -- for the same admin must still be refused (real anti-preemption works).
  SELECT * INTO v_create FROM public.create_admin_access_request(
    'budi', 'runtime-test-ref-0000000000000005', repeat('e', 64), now() + interval '2 minutes', '', NULL
  );
  IF v_create.result_code IS DISTINCT FROM 'throttled' THEN
    RAISE EXCEPTION 'a truly Telegram-activated live request must still block a new create, got %', v_create.result_code;
  END IF;
END
$$;

\echo '--- runtime: the DB-level unique index still rejects two activated rows for the same admin, even bypassing the RPC layer ---'
DO $$
DECLARE
  v_failed boolean := false;
BEGIN
  BEGIN
    UPDATE public.admin_access_requests
       SET telegram_message_id = 999888
     WHERE request_ref = 'runtime-test-ref-0000000000000001';
  EXCEPTION WHEN unique_violation THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'expected unique_violation: the partial index must forbid two activated live rows for the same admin';
  END IF;
END
$$;

\echo '--- runtime: full approve + consume lifecycle succeeds end-to-end ---'
DO $$
DECLARE
  v_approve record;
  v_consume record;
BEGIN
  SELECT * INTO v_approve FROM public.approve_admin_access_request('runtime-test-ref-0000000000000004', 999999001);
  IF v_approve.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_approve.result_code;
  END IF;

  SELECT * INTO v_consume FROM public.consume_admin_access_request('runtime-test-ref-0000000000000004', repeat('d', 64));
  IF v_consume.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_consume.result_code;
  END IF;
  IF v_consume.username IS DISTINCT FROM 'budi' THEN
    RAISE EXCEPTION 'expected username budi, got %', v_consume.username;
  END IF;
END
$$;

\echo '--- runtime: the global creation-rate bound denies NEW creates, but never blocks activating an ALREADY-CREATED dormant request ---'
-- Honest property (not "100 anonymous requests never deny anything" — the
-- global 100/5min bound is a real, intentional, bounded DB-hygiene limit and
-- WILL legitimately return rate_limited once exhausted). What must hold:
--   - exhausting the global creation budget can cause a bounded temporary
--     denial of NEW create calls;
--   - it can NEVER cause a Telegram message to anyone;
--   - it can NEVER block activating a request that was already created
--     before the budget was exhausted.
-- Run only now that ref ...0004 has been consumed above, so the one-active
-- slot is free and ref ...0001 (still dormant/unexpired, untouched since the
-- earlier already_active check) can be legitimately activated here.
DO $$
DECLARE
  v_filler_user uuid;
  v_create record;
  v_activate record;
BEGIN
  SELECT id INTO v_filler_user FROM public.app_users WHERE username = 'not-budi';

  INSERT INTO public.admin_access_requests (user_id, request_ref, browser_binding_hash, state, expires_at)
  SELECT v_filler_user, 'runtime-test-ref-filler-' || gs::text, repeat('f', 64), 'pending', now() + interval '2 minutes'
    FROM generate_series(1, 100) AS gs;

  SELECT * INTO v_create FROM public.create_admin_access_request(
    'budi', 'runtime-test-ref-0000000000000006', repeat('g', 64), now() + interval '2 minutes', '', NULL
  );
  IF v_create.result_code IS DISTINCT FROM 'rate_limited' THEN
    RAISE EXCEPTION 'expected rate_limited once the global creation budget is exhausted, got %', v_create.result_code;
  END IF;

  SELECT * INTO v_activate FROM public.activate_admin_access_request(
    'runtime-test-ref-0000000000000001', 999999001, 555000003
  );
  IF v_activate.result_code IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'the global creation-rate bound must never block activating an already-created dormant request, got %', v_activate.result_code;
  END IF;

  DELETE FROM public.admin_access_requests WHERE request_ref LIKE 'runtime-test-ref-filler-%';
END
$$;

-- Resolve ref ...0001 to a terminal state before this script ends. It was
-- left mid-activation (claimed, not yet delivered/approved) by the block
-- above, which would otherwise occupy the one-active-admin slot for any
-- later script/CI step run against this same database (e.g. the
-- concurrent-activation-race.sh regression), even though this migration's
-- own real invariants are already fully exercised by this point.
DO $$
DECLARE
  v_approve record;
  v_consume record;
BEGIN
  PERFORM public.record_admin_access_message('runtime-test-ref-0000000000000001', 555000003, 777002);

  SELECT * INTO v_approve FROM public.approve_admin_access_request('runtime-test-ref-0000000000000001', 999999001);
  IF v_approve.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_approve.result_code;
  END IF;

  SELECT * INTO v_consume FROM public.consume_admin_access_request('runtime-test-ref-0000000000000001', repeat('a', 64));
  IF v_consume.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_consume.result_code;
  END IF;
END
$$;

\echo '--- runtime: an APPROVED row with telegram_message_id still NULL (record_admin_access_message failed after a successful send) must NEVER have its stale claim reaped ---'
-- A prior code review found this gap: the reap UPDATEs originally filtered
-- only on telegram_message_id IS NULL AND activation_claimed_at being old,
-- with no state check. record_admin_access_message runs as a separate RPC
-- call strictly AFTER the Telegram send already succeeded, and its own
-- failure is silently swallowed by lib/admin-access.js — so an 'approved'
-- row can legitimately still have telegram_message_id NULL. If the reap
-- were to clear such a row's activation_claimed_at, a sibling request could
-- steal the active slot and get its own approval message sent while the
-- first (already-approved, real) row's Telegram buttons are still live —
-- reopening the exact race this migration closes. The fix scopes every reap
-- to state = 'pending'. This proves it holds against the real index/RPCs,
-- not just the SQL source text.
DO $$
DECLARE
  v_create record;
  v_activate record;
  v_approve record;
  v_create_sibling record;
BEGIN
  -- The one-active-admin slot is free at this point (ref ...0004 and ref
  -- ...0001 were both consumed to a terminal state above), so this create
  -- must succeed.
  SELECT * INTO v_create FROM public.create_admin_access_request(
    'budi', 'runtime-test-ref-0000000000000008', repeat('h', 64), now() + interval '2 minutes', '', NULL
  );
  IF v_create.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_create.result_code;
  END IF;

  SELECT * INTO v_activate FROM public.activate_admin_access_request(
    'runtime-test-ref-0000000000000008', 999999001, 555000004
  );
  IF v_activate.result_code IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'expected claimed, got %', v_activate.result_code;
  END IF;

  -- Deliberately do NOT call record_admin_access_message — simulates the
  -- Telegram send having succeeded (in reality) while the DB write to
  -- record telegram_message_id failed.
  SELECT * INTO v_approve FROM public.approve_admin_access_request('runtime-test-ref-0000000000000008', 999999001);
  IF v_approve.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_approve.result_code;
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_access_requests WHERE request_ref = 'runtime-test-ref-0000000000000008' AND telegram_message_id IS NOT NULL) THEN
    RAISE EXCEPTION 'test setup invariant broken: telegram_message_id must still be NULL on the approved row';
  END IF;

  -- Backdate activation_claimed_at well past the 20s reap window, exactly
  -- as if a real send-then-record-failure had happened a while ago.
  UPDATE public.admin_access_requests
     SET activation_claimed_at = now() - interval '5 minutes'
   WHERE request_ref = 'runtime-test-ref-0000000000000008';

  -- Any call that runs the reap for this admin (here: a fresh create call)
  -- must NOT clear this approved row's activation_claimed_at, and must
  -- still correctly refuse the new create because the approved row is
  -- still occupying the one-active-admin slot.
  SELECT * INTO v_create_sibling FROM public.create_admin_access_request(
    'budi', 'runtime-test-ref-0000000000000009', repeat('i', 64), now() + interval '2 minutes', '', NULL
  );
  IF v_create_sibling.result_code IS DISTINCT FROM 'throttled' THEN
    RAISE EXCEPTION 'REGRESSION: an approved-but-undelivered-message row must still occupy the active slot, got %', v_create_sibling.result_code;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_access_requests
     WHERE request_ref = 'runtime-test-ref-0000000000000008' AND activation_claimed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'REGRESSION: the reap incorrectly cleared activation_claimed_at on an approved row';
  END IF;
END
$$;

-- Resolve ref ...0008 to a terminal state before this script ends (same
-- reasoning as ref ...0001's cleanup above).
DO $$
DECLARE
  v_consume record;
BEGIN
  SELECT * INTO v_consume FROM public.consume_admin_access_request('runtime-test-ref-0000000000000008', repeat('h', 64));
  IF v_consume.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_consume.result_code;
  END IF;
END
$$;

\echo '--- runtime: a lazily time-expired ACTIVE sibling (state still pending, TTL already passed) must not cause a unique_violation when activating a different ref ---'
-- A follow-up review found this: the sibling-EXISTS check in
-- activate_admin_access_request correctly ignores an expired sibling
-- (expires_at > now()), but the UNIQUE INDEX cannot check expires_at at all
-- (index predicates must be immutable) — so a sibling that is time-expired
-- but still sitting in state='pending'/'approved' with telegram_message_id
-- or activation_claimed_at set would still satisfy the index and could
-- collide with the row being activated. The fix expires such siblings
-- BEFORE relying on the invariant. Proven here for a 'pending' sibling.
DO $$
DECLARE
  v_activate_a record;
  v_activate_b record;
  v_active_count integer;
BEGIN
  PERFORM public.create_admin_access_request('budi', 'runtime-test-ref-0000000000000010', repeat('j', 64), now() + interval '2 minutes', '', NULL);
  PERFORM public.create_admin_access_request('budi', 'runtime-test-ref-0000000000000011', repeat('k', 64), now() + interval '2 minutes', '', NULL);

  SELECT * INTO v_activate_a FROM public.activate_admin_access_request('runtime-test-ref-0000000000000010', 999999001, 555000005);
  IF v_activate_a.result_code IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'expected claimed, got %', v_activate_a.result_code;
  END IF;
  PERFORM public.record_admin_access_message('runtime-test-ref-0000000000000010', 555000005, 777003);

  -- Simulate lazy expiration not yet processed: TTL passed, state still
  -- 'pending', but this row is still Telegram-activated
  -- (telegram_message_id set) and therefore still satisfies the unique
  -- index's predicate.
  UPDATE public.admin_access_requests SET expires_at = now() - interval '1 second' WHERE request_ref = 'runtime-test-ref-0000000000000010';

  SELECT * INTO v_activate_b FROM public.activate_admin_access_request('runtime-test-ref-0000000000000011', 999999001, 555000006);
  IF v_activate_b.result_code IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'REGRESSION: activating a sibling while an EXPIRED (but not-yet-reclassified) active row exists must still succeed, got %', v_activate_b.result_code;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.admin_access_requests WHERE request_ref = 'runtime-test-ref-0000000000000010' AND state = 'expired') THEN
    RAISE EXCEPTION 'REGRESSION: the expired sibling must be transitioned to state=''expired'' by activate()';
  END IF;

  SELECT count(*) INTO v_active_count
    FROM public.admin_access_requests aar
   WHERE aar.user_id = (SELECT id FROM public.app_users WHERE username = 'budi')
     AND aar.state IN ('pending','approved')
     AND (aar.telegram_message_id IS NOT NULL OR aar.activation_claimed_at IS NOT NULL)
     AND aar.expires_at > now();
  IF v_active_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 active-slot row for budi after the expired sibling is reclassified, got %', v_active_count;
  END IF;

  PERFORM public.record_admin_access_message('runtime-test-ref-0000000000000011', 555000006, 777004);
  PERFORM public.approve_admin_access_request('runtime-test-ref-0000000000000011', 999999001);
  PERFORM public.consume_admin_access_request('runtime-test-ref-0000000000000011', repeat('k', 64));
END
$$;

\echo '--- runtime: same expired-sibling scenario, but the sibling is already state=''approved'' when it expires ---'
DO $$
DECLARE
  v_activate_c record;
  v_activate_d record;
BEGIN
  PERFORM public.create_admin_access_request('budi', 'runtime-test-ref-0000000000000012', repeat('l', 64), now() + interval '2 minutes', '', NULL);
  PERFORM public.create_admin_access_request('budi', 'runtime-test-ref-0000000000000013', repeat('m', 64), now() + interval '2 minutes', '', NULL);

  SELECT * INTO v_activate_c FROM public.activate_admin_access_request('runtime-test-ref-0000000000000012', 999999001, 555000007);
  IF v_activate_c.result_code IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'expected claimed, got %', v_activate_c.result_code;
  END IF;
  PERFORM public.record_admin_access_message('runtime-test-ref-0000000000000012', 555000007, 777005);
  PERFORM public.approve_admin_access_request('runtime-test-ref-0000000000000012', 999999001);

  UPDATE public.admin_access_requests SET expires_at = now() - interval '1 second' WHERE request_ref = 'runtime-test-ref-0000000000000012';

  SELECT * INTO v_activate_d FROM public.activate_admin_access_request('runtime-test-ref-0000000000000013', 999999001, 555000008);
  IF v_activate_d.result_code IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'REGRESSION: activating a sibling while an EXPIRED but state=''approved'' row exists must still succeed, got %', v_activate_d.result_code;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.admin_access_requests WHERE request_ref = 'runtime-test-ref-0000000000000012' AND state = 'expired') THEN
    RAISE EXCEPTION 'REGRESSION: the expired-but-approved sibling must also be transitioned to state=''expired'' by activate()';
  END IF;

  PERFORM public.record_admin_access_message('runtime-test-ref-0000000000000013', 555000008, 777006);
  PERFORM public.approve_admin_access_request('runtime-test-ref-0000000000000013', 999999001);
  PERFORM public.consume_admin_access_request('runtime-test-ref-0000000000000013', repeat('m', 64));
END
$$;

\echo '--- runtime: production migration re-application safety — a FRESH claim survives, a STALE one is cleared, an APPROVED-but-undelivered row is never touched ---'
DO $$
DECLARE
  v_create record;
  v_activate record;
BEGIN
  SELECT * INTO v_create FROM public.create_admin_access_request(
    'budi', 'runtime-test-ref-0000000000000014', repeat('n', 64), now() + interval '2 minutes', '', NULL
  );
  IF v_create.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_create.result_code;
  END IF;

  SELECT * INTO v_activate FROM public.activate_admin_access_request(
    'runtime-test-ref-0000000000000014', 999999001, 555000009
  );
  IF v_activate.result_code IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'expected claimed, got %', v_activate.result_code;
  END IF;
  -- Deliberately do NOT record_admin_access_message yet — this is the FRESH,
  -- still-in-flight claim the migration cleanup must never destroy.
END
$$;

-- 3A: reapplying the migration while the claim above is FRESH (<20s old)
-- must succeed and must NOT clear it.
\i supabase/admin-telegram-access-migration.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_access_requests
     WHERE request_ref = 'runtime-test-ref-0000000000000014' AND activation_claimed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'REGRESSION: re-applying the migration destroyed a FRESH, genuinely in-flight delivery claim';
  END IF;

  -- 3B setup: age the claim well past the 20s window, simulating a genuinely
  -- abandoned/dead claim.
  UPDATE public.admin_access_requests
     SET activation_claimed_at = now() - interval '5 minutes'
   WHERE request_ref = 'runtime-test-ref-0000000000000014';
END
$$;

-- 3B: reapplying the migration now that the claim is STALE must clear it.
\i supabase/admin-telegram-access-migration.sql

DO $$
DECLARE
  v_create record;
  v_activate record;
  v_approve record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.admin_access_requests
     WHERE request_ref = 'runtime-test-ref-0000000000000014' AND activation_claimed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'REGRESSION: re-applying the migration failed to clear a genuinely STALE (>20s) claim';
  END IF;

  -- 3C: an APPROVED row with telegram_message_id still NULL must survive a
  -- migration re-application untouched, exactly like it must survive the
  -- runtime reap (tested earlier in this script).
  SELECT * INTO v_create FROM public.create_admin_access_request(
    'budi', 'runtime-test-ref-0000000000000015', repeat('o', 64), now() + interval '2 minutes', '', NULL
  );
  IF v_create.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_create.result_code;
  END IF;

  SELECT * INTO v_activate FROM public.activate_admin_access_request(
    'runtime-test-ref-0000000000000015', 999999001, 555000010
  );
  IF v_activate.result_code IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'expected claimed, got %', v_activate.result_code;
  END IF;

  SELECT * INTO v_approve FROM public.approve_admin_access_request('runtime-test-ref-0000000000000015', 999999001);
  IF v_approve.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_approve.result_code;
  END IF;

  UPDATE public.admin_access_requests
     SET activation_claimed_at = now() - interval '5 minutes'
   WHERE request_ref = 'runtime-test-ref-0000000000000015';
END
$$;

\i supabase/admin-telegram-access-migration.sql

DO $$
DECLARE
  v_consume record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_access_requests
     WHERE request_ref = 'runtime-test-ref-0000000000000015' AND activation_claimed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'REGRESSION: re-applying the migration destroyed an APPROVED-but-undelivered-message row''s claim';
  END IF;

  SELECT * INTO v_consume FROM public.consume_admin_access_request('runtime-test-ref-0000000000000015', repeat('o', 64));
  IF v_consume.result_code IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'expected ok, got %', v_consume.result_code;
  END IF;
END
$$;

\echo '--- admin-access runtime regression: ALL CHECKS PASSED ---'
