\set ON_ERROR_STOP on

-- Verified Telegram admin can issue one active maintenance code and its bot
-- message metadata is stored without storing the raw six-digit code.
DO $$
DECLARE
  r record;
  v_grant uuid;
  v_hash constant text := repeat('1', 64);
BEGIN
  SELECT * INTO r FROM public.issue_admin_maintenance_code(
    999999001, v_hash, now() + interval '2 minutes'
  );
  IF r.result_code <> 'ok' OR r.username <> 'budi' OR r.grant_id IS NULL THEN
    RAISE EXCEPTION 'maintenance code issue failed: %', row_to_json(r);
  END IF;
  v_grant := r.grant_id;

  SELECT * INTO r FROM public.record_admin_maintenance_code_message(
    v_grant, 999999001, 555001, 777001
  );
  IF r.result_code <> 'ok' THEN
    RAISE EXCEPTION 'maintenance code message record failed: %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.get_admin_maintenance_code_status();
  IF r.result_code <> 'active' OR r.active IS DISTINCT FROM true OR r.expires_at IS NULL THEN
    RAISE EXCEPTION 'maintenance code status did not become active: %', row_to_json(r);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_command_login_grants AS g
     WHERE g.id = v_grant
       AND g.target = 'direct'
       AND g.grant_purpose = 'maintenance_code'
       AND g.token_hash = v_hash
       AND g.telegram_code_chat_id = 555001
       AND g.telegram_code_message_id = 777001
       AND g.code_attempts = 0
  ) THEN
    RAISE EXCEPTION 'maintenance grant metadata was not persisted correctly';
  END IF;
END
$$;

-- Wrong codes are bounded to five attempts. The fifth wrong attempt disables
-- that code and status returns idle until the verified admin issues a new one.
DO $$
DECLARE
  r record;
  i integer;
BEGIN
  FOR i IN 1..4 LOOP
    SELECT * INTO r FROM public.consume_admin_maintenance_code(repeat('2', 64));
    IF r.result_code <> 'invalid_code' OR r.attempts_remaining <> (5 - i) THEN
      RAISE EXCEPTION 'wrong attempt % was not bounded correctly: %', i, row_to_json(r);
    END IF;
  END LOOP;

  SELECT * INTO r FROM public.consume_admin_maintenance_code(repeat('2', 64));
  IF r.result_code <> 'locked' OR r.attempts_remaining <> 0 THEN
    RAISE EXCEPTION 'fifth wrong code did not lock grant: %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.get_admin_maintenance_code_status();
  IF r.active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'locked code still advertised as active: %', row_to_json(r);
  END IF;
END
$$;

-- A fresh correct code is consumed exactly once and returns only the inputs
-- needed by the server to issue signed ac_sess and clean up Telegram messages.
DO $$
DECLARE
  r record;
  v_grant uuid;
  v_hash constant text := repeat('3', 64);
BEGIN
  SELECT * INTO r FROM public.issue_admin_maintenance_code(
    999999001, v_hash, now() + interval '2 minutes'
  );
  IF r.result_code <> 'ok' THEN
    RAISE EXCEPTION 'fresh maintenance code issue failed: %', row_to_json(r);
  END IF;
  v_grant := r.grant_id;

  PERFORM * FROM public.record_admin_maintenance_code_message(v_grant, 999999001, 555001, 777002);

  SELECT * INTO r FROM public.consume_admin_maintenance_code(v_hash);
  IF r.result_code <> 'ok' OR r.username <> 'budi' OR r.user_id IS NULL OR r.grant_id <> v_grant THEN
    RAISE EXCEPTION 'correct maintenance code consume failed: %', row_to_json(r);
  END IF;
  IF r.telegram_chat_id <> 555001 OR r.telegram_code_message_id <> 777002 THEN
    RAISE EXCEPTION 'Telegram cleanup metadata missing at consume: %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.consume_admin_maintenance_code(v_hash);
  IF r.result_code <> 'not_found' THEN
    RAISE EXCEPTION 'consumed maintenance code replay unexpectedly accepted: %', row_to_json(r);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_command_login_grants AS g
     WHERE g.id = v_grant AND g.state = 'consumed' AND g.consumed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'consumed maintenance code audit state was not retained';
  END IF;
END
$$;

-- Telegram binding is rechecked at consume, so revocation between issue and use
-- invalidates the code even when its digest and TTL are otherwise valid.
DO $$
DECLARE
  r record;
  v_hash constant text := repeat('4', 64);
BEGIN
  SELECT * INTO r FROM public.issue_admin_maintenance_code(
    999999001, v_hash, now() + interval '2 minutes'
  );
  IF r.result_code <> 'ok' THEN RAISE EXCEPTION 'pre-revoke issue failed'; END IF;

  UPDATE public.app_user_telegram_verifications AS v
     SET telegram_verified_at = NULL
   WHERE v.telegram_user_id = 999999001;

  SELECT * INTO r FROM public.consume_admin_maintenance_code(v_hash);
  IF r.result_code <> 'not_found' THEN
    RAISE EXCEPTION 'revoked Telegram binding unexpectedly consumed code: %', row_to_json(r);
  END IF;

  UPDATE public.app_user_telegram_verifications AS v
     SET telegram_verified_at = now()
   WHERE v.telegram_user_id = 999999001;
END
$$;

-- Browser roles never receive direct access to code-management RPCs.
DO $$
DECLARE
  fn text;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.routine_privileges AS rp
     WHERE rp.routine_schema = 'public'
       AND rp.routine_name IN (
         'issue_admin_maintenance_code',
         'record_admin_maintenance_code_message',
         'get_admin_maintenance_code_status',
         'consume_admin_maintenance_code'
       )
       AND lower(rp.grantee) IN ('public','anon','authenticated')
       AND rp.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'browser role unexpectedly has maintenance-code RPC execute permission';
  END IF;

  FOREACH fn IN ARRAY ARRAY[
    'public.issue_admin_maintenance_code(bigint,text,timestamptz)',
    'public.record_admin_maintenance_code_message(uuid,bigint,bigint,bigint)',
    'public.get_admin_maintenance_code_status()',
    'public.consume_admin_maintenance_code(text)'
  ] LOOP
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role lacks execute on %', fn;
    END IF;
  END LOOP;
END
$$;
