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

\echo '--- runtime: activating one dormant request makes it block a NEW dormant create, but a sibling dormant one is refused activation ---'
DO $$
DECLARE
  v_activate record;
BEGIN
  SELECT * INTO v_activate FROM public.activate_admin_access_request(
    'runtime-test-ref-0000000000000004', 999999001, 555000001
  );
  IF v_activate.result_code IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'expected claimed, got %', v_activate.result_code;
  END IF;

  PERFORM public.record_admin_access_message('runtime-test-ref-0000000000000004', 555000001, 777001);
END
$$;

DO $$
DECLARE
  v_create record;
  v_activate_sibling record;
BEGIN
  -- Now that ref ...0004 is truly Telegram-activated, a brand-new create call
  -- for the same admin must be refused (real anti-preemption still works).
  SELECT * INTO v_create FROM public.create_admin_access_request(
    'budi', 'runtime-test-ref-0000000000000005', repeat('e', 64), now() + interval '2 minutes', '', NULL
  );
  IF v_create.result_code IS DISTINCT FROM 'throttled' THEN
    RAISE EXCEPTION 'a truly Telegram-activated live request must still block a new create, got %', v_create.result_code;
  END IF;

  -- ref ...0001 is still dormant (never activated). Trying to activate it now
  -- must be refused with already_active, not send a second approval message.
  SELECT * INTO v_activate_sibling FROM public.activate_admin_access_request(
    'runtime-test-ref-0000000000000001', 999999001, 555000002
  );
  IF v_activate_sibling.result_code IS DISTINCT FROM 'already_active' THEN
    RAISE EXCEPTION 'expected already_active for a second activation attempt while one is already live, got %', v_activate_sibling.result_code;
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

\echo '--- admin-access runtime regression: ALL CHECKS PASSED ---'
