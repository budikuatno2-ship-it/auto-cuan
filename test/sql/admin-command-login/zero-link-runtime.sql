\set ON_ERROR_STOP on

-- Start from an unpaired admin so this file tests the first-pair path itself,
-- independent of the legacy one-time pairing-link regression above it.
UPDATE public.app_user_telegram_verifications AS v
   SET admin_device_hash = NULL,
       admin_device_label = NULL,
       admin_device_bound_at = NULL
 WHERE v.telegram_user_id = 999999001;

-- Browser presence registration creates only a hashed pending request.
DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.poll_admin_command_pair_request(
    repeat('1',64),
    'PairRequestRef_1234567890',
    'K7M4Q2',
    'Windows · Chrome',
    repeat('a',64),
    repeat('d',64),
    now() + interval '2 minutes'
  );

  IF r.result_code <> 'pending' OR r.request_ref <> 'PairRequestRef_1234567890' OR r.display_tag <> 'K7M4Q2' THEN
    RAISE EXCEPTION 'browser pairing request was not registered safely: %', row_to_json(r);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.admin_command_pair_requests AS pr
     WHERE pr.request_ref = 'PairRequestRef_1234567890'
       AND pr.pair_hash <> repeat('1',64)
  ) THEN
    RAISE EXCEPTION 'pair request hash changed unexpectedly';
  END IF;
END
$$;

-- Wrong Telegram identity sees no candidate.
DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.get_admin_command_pair_candidate(111111111);
  IF r.result_code <> 'identity_mismatch' THEN
    RAISE EXCEPTION 'wrong Telegram identity saw pairing candidate: %', row_to_json(r);
  END IF;
END
$$;

-- Verified admin sees exactly the one browser request and its human-check tag.
DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.get_admin_command_pair_candidate(999999001);
  IF r.result_code <> 'ok'
     OR r.request_ref <> 'PairRequestRef_1234567890'
     OR r.display_tag <> 'K7M4Q2'
     OR r.candidate_count <> 1 THEN
    RAISE EXCEPTION 'verified admin candidate lookup failed: %', row_to_json(r);
  END IF;
END
$$;

-- A second live browser makes approval fail closed instead of guessing.
DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.poll_admin_command_pair_request(
    repeat('2',64),
    'PairRequestRef_ABCDEFGHIJ12',
    'Q9W8E7',
    'Linux · Firefox',
    repeat('b',64),
    repeat('e',64),
    now() + interval '2 minutes'
  );
  IF r.result_code <> 'pending' THEN
    RAISE EXCEPTION 'second browser request setup failed: %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.get_admin_command_pair_candidate(999999001);
  IF r.result_code <> 'ambiguous' OR r.candidate_count <> 2 THEN
    RAISE EXCEPTION 'multiple browser requests did not fail closed: %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.approve_admin_command_pair_request(
    999999001, 'PairRequestRef_1234567890'
  );
  IF r.result_code <> 'ambiguous' THEN
    RAISE EXCEPTION 'approval guessed through an ambiguous race: %', row_to_json(r);
  END IF;

  UPDATE public.admin_command_pair_requests AS pr
     SET state = 'expired', updated_at = now()
   WHERE pr.request_ref = 'PairRequestRef_ABCDEFGHIJ12';
END
$$;

-- Exact Telegram callback approves the sole remaining browser request.
DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.approve_admin_command_pair_request(
    999999001, 'PairRequestRef_1234567890'
  );
  IF r.result_code <> 'ok' OR r.display_tag <> 'K7M4Q2' THEN
    RAISE EXCEPTION 'exact browser pairing approval failed: %', row_to_json(r);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_command_pair_requests AS pr
     WHERE pr.request_ref = 'PairRequestRef_1234567890'
       AND pr.state = 'approved'
       AND pr.telegram_user_id = 999999001
       AND pr.user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'approved pairing request did not record verified admin identity';
  END IF;
END
$$;

-- Only the browser holding the exact pair hash can consume the approval and
-- bind its generated device hash. No URL token participates in this path.
DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.poll_admin_command_pair_request(
    repeat('1',64),
    'PairRequestRef_unused99999',
    'Z9Z9Z9',
    'Windows · Chrome',
    repeat('a',64),
    repeat('d',64),
    now() + interval '2 minutes'
  );

  IF r.result_code <> 'ok' OR r.username <> 'budi' THEN
    RAISE EXCEPTION 'approved browser failed to consume pairing request: %', row_to_json(r);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.app_user_telegram_verifications AS v
     WHERE v.telegram_user_id = 999999001
       AND v.admin_device_hash = repeat('d',64)
       AND v.admin_device_label = 'Windows · Chrome'
       AND v.admin_device_bound_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'zero-link pairing did not bind the trusted laptop';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_command_pair_requests AS pr
     WHERE pr.request_ref = 'PairRequestRef_1234567890'
       AND pr.state = 'consumed'
       AND pr.consumed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'pairing request was not consumed exactly once';
  END IF;
END
$$;

-- Revoking Telegram verification before consume invalidates an approval.
DO $$
DECLARE
  r record;
BEGIN
  UPDATE public.app_user_telegram_verifications AS v
     SET admin_device_hash = NULL,
         admin_device_label = NULL,
         admin_device_bound_at = NULL
   WHERE v.telegram_user_id = 999999001;

  SELECT * INTO r FROM public.poll_admin_command_pair_request(
    repeat('3',64),
    'PairRequestRef_REVOKE12345',
    'R3V0K3',
    'Windows · Chrome',
    repeat('c',64),
    repeat('f',64),
    now() + interval '2 minutes'
  );
  IF r.result_code <> 'pending' THEN RAISE EXCEPTION 'revoke setup registration failed'; END IF;

  SELECT * INTO r FROM public.approve_admin_command_pair_request(999999001, 'PairRequestRef_REVOKE12345');
  IF r.result_code <> 'ok' THEN RAISE EXCEPTION 'revoke setup approval failed'; END IF;

  UPDATE public.app_user_telegram_verifications AS v
     SET telegram_verified_at = NULL
   WHERE v.telegram_user_id = 999999001;

  SELECT * INTO r FROM public.poll_admin_command_pair_request(
    repeat('3',64),
    'PairRequestRef_unused88888',
    'T8T8T8',
    'Windows · Chrome',
    repeat('c',64),
    repeat('f',64),
    now() + interval '2 minutes'
  );
  IF r.result_code <> 'identity_revoked' THEN
    RAISE EXCEPTION 'revoked Telegram identity still consumed pairing approval: %', row_to_json(r);
  END IF;

  UPDATE public.app_user_telegram_verifications AS v
     SET telegram_verified_at = now()
   WHERE v.telegram_user_id = 999999001;
END
$$;

-- RLS / grants: browser roles cannot read the table or execute any pairing RPC.
DO $$
DECLARE
  fn text;
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class AS c WHERE c.oid='public.admin_command_pair_requests'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on admin_command_pair_requests';
  END IF;

  IF has_table_privilege('anon', 'public.admin_command_pair_requests', 'SELECT')
     OR has_table_privilege('authenticated', 'public.admin_command_pair_requests', 'SELECT') THEN
    RAISE EXCEPTION 'browser role unexpectedly has zero-link pairing table access';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.routine_privileges AS rp
     WHERE rp.routine_schema = 'public'
       AND rp.routine_name IN (
         'poll_admin_command_pair_request',
         'get_admin_command_pair_candidate',
         'approve_admin_command_pair_request'
       )
       AND lower(rp.grantee) IN ('public','anon','authenticated')
       AND rp.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC/anon/authenticated execute privilege remains on zero-link pairing RPC';
  END IF;

  FOREACH fn IN ARRAY ARRAY[
    'public.poll_admin_command_pair_request(text,text,text,text,text,text,timestamptz)',
    'public.get_admin_command_pair_candidate(bigint)',
    'public.approve_admin_command_pair_request(bigint,text)'
  ] LOOP
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role lacks execute on %', fn;
    END IF;
  END LOOP;
END
$$;
