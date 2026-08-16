\set ON_ERROR_STOP on

-- Identity gate: only the Telegram id already verified for admin `budi` works.
DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.get_admin_command_login_context(999999001);
  IF r.result_code <> 'ok' OR r.username <> 'budi' OR r.device_bound IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'expected verified admin context, got %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.get_admin_command_login_context(111111111);
  IF r.result_code <> 'identity_mismatch' THEN
    RAISE EXCEPTION 'wrong Telegram identity unexpectedly accepted: %', row_to_json(r);
  END IF;
END
$$;

-- Direct HP token is one-time and does not bind a trusted laptop.
DO $$
DECLARE
  r record;
  token_hash constant text := repeat('a', 64);
BEGIN
  SELECT * INTO r FROM public.create_admin_command_login_grant(
    999999001, 'direct', token_hash, now() + interval '2 minutes'
  );
  IF r.result_code <> 'ok' THEN
    RAISE EXCEPTION 'direct grant creation failed: %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.consume_admin_command_login_token(token_hash, repeat('1',64), 'Windows · Chrome');
  IF r.result_code <> 'ok' OR r.target <> 'direct' OR r.username <> 'budi' THEN
    RAISE EXCEPTION 'direct consume failed: %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.consume_admin_command_login_token(token_hash, repeat('1',64), 'Windows · Chrome');
  IF r.result_code <> 'already_consumed' THEN
    RAISE EXCEPTION 'direct token replay was not rejected: %', row_to_json(r);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.app_user_telegram_verifications
     WHERE telegram_user_id = 999999001 AND admin_device_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'direct HP login unexpectedly paired a device';
  END IF;
END
$$;

-- Pair token requires a device hash, remains pending if it is opened on a
-- mobile client (API passes NULL), then binds exactly once on the laptop.
DO $$
DECLARE
  r record;
  token_hash constant text := repeat('b', 64);
  device_hash constant text := repeat('d', 64);
BEGIN
  SELECT * INTO r FROM public.create_admin_command_login_grant(
    999999001, 'pair', token_hash, now() + interval '2 minutes'
  );
  IF r.result_code <> 'ok' THEN
    RAISE EXCEPTION 'pair grant creation failed: %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.consume_admin_command_login_token(token_hash, NULL, 'Perangkat mobile');
  IF r.result_code <> 'device_required' THEN
    RAISE EXCEPTION 'pair grant without device was not refused safely: %', row_to_json(r);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_command_login_grants
     WHERE token_hash = repeat('b',64) AND state = 'pending'
  ) THEN
    RAISE EXCEPTION 'pair token was consumed even though no laptop device hash was supplied';
  END IF;

  SELECT * INTO r FROM public.consume_admin_command_login_token(token_hash, device_hash, 'Windows · Chrome');
  IF r.result_code <> 'ok' OR r.target <> 'pair' THEN
    RAISE EXCEPTION 'pair consume failed: %', row_to_json(r);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.app_user_telegram_verifications
     WHERE telegram_user_id = 999999001
       AND admin_device_hash = device_hash
       AND admin_device_bound_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'trusted laptop binding was not recorded';
  END IF;

  SELECT * INTO r FROM public.consume_admin_command_login_token(token_hash, device_hash, 'Windows · Chrome');
  IF r.result_code <> 'already_consumed' THEN
    RAISE EXCEPTION 'pair token replay was not rejected: %', row_to_json(r);
  END IF;
END
$$;

-- Once paired, Telegram can create a device-target grant with no URL token.
-- Only the exact paired device hash can atomically consume it once.
DO $$
DECLARE
  r record;
  device_hash constant text := repeat('d', 64);
BEGIN
  SELECT * INTO r FROM public.create_admin_command_login_grant(
    999999001, 'device', NULL, now() + interval '2 minutes'
  );
  IF r.result_code <> 'ok' OR r.device_bound IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'device grant creation failed: %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.consume_admin_command_device_grant(repeat('e',64));
  IF r.result_code <> 'unpaired' THEN
    RAISE EXCEPTION 'wrong device hash unexpectedly consumed grant: %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.consume_admin_command_device_grant(device_hash);
  IF r.result_code <> 'ok' OR r.username <> 'budi' THEN
    RAISE EXCEPTION 'paired device failed to consume grant: %', row_to_json(r);
  END IF;

  SELECT * INTO r FROM public.consume_admin_command_device_grant(device_hash);
  IF r.result_code <> 'pending' THEN
    RAISE EXCEPTION 'device grant replay was not rejected: %', row_to_json(r);
  END IF;
END
$$;

-- A blocked account cannot consume an otherwise-valid direct grant.
DO $$
DECLARE
  r record;
  token_hash constant text := repeat('c', 64);
BEGIN
  SELECT * INTO r FROM public.create_admin_command_login_grant(
    999999001, 'direct', token_hash, now() + interval '2 minutes'
  );
  IF r.result_code <> 'ok' THEN RAISE EXCEPTION 'pre-block grant creation failed'; END IF;

  UPDATE public.app_users SET is_blocked = true WHERE username = 'budi';
  SELECT * INTO r FROM public.consume_admin_command_login_token(token_hash, NULL, NULL);
  IF r.result_code <> 'not_found' THEN
    RAISE EXCEPTION 'blocked admin unexpectedly consumed a login grant: %', row_to_json(r);
  END IF;
  UPDATE public.app_users SET is_blocked = false WHERE username = 'budi';
END
$$;

-- A revoked Telegram binding cannot consume a grant created before revocation.
DO $$
DECLARE
  r record;
  token_hash constant text := repeat('f', 64);
BEGIN
  SELECT * INTO r FROM public.create_admin_command_login_grant(
    999999001, 'direct', token_hash, now() + interval '2 minutes'
  );
  IF r.result_code <> 'ok' THEN RAISE EXCEPTION 'pre-revoke grant creation failed'; END IF;

  UPDATE public.app_user_telegram_verifications
     SET telegram_verified_at = NULL
   WHERE telegram_user_id = 999999001;

  SELECT * INTO r FROM public.consume_admin_command_login_token(token_hash, NULL, NULL);
  IF r.result_code <> 'not_found' THEN
    RAISE EXCEPTION 'revoked Telegram binding unexpectedly consumed a grant: %', row_to_json(r);
  END IF;

  UPDATE public.app_user_telegram_verifications
     SET telegram_verified_at = now()
   WHERE telegram_user_id = 999999001;
END
$$;

-- Expiry is enforced at consume time.
DO $$
DECLARE
  r record;
  token_hash constant text := repeat('9', 64);
BEGIN
  SELECT * INTO r FROM public.create_admin_command_login_grant(
    999999001, 'direct', token_hash, now() + interval '1 minute'
  );
  IF r.result_code <> 'ok' THEN RAISE EXCEPTION 'expiry test grant creation failed'; END IF;

  UPDATE public.admin_command_login_grants
     SET expires_at = now() - interval '1 second'
   WHERE token_hash = token_hash;

  SELECT * INTO r FROM public.consume_admin_command_login_token(token_hash, NULL, NULL);
  IF r.result_code <> 'expired' THEN
    RAISE EXCEPTION 'expired token unexpectedly remained usable: %', row_to_json(r);
  END IF;
END
$$;

-- RLS / grants: browser roles must have neither table access nor RPC execute.
DO $$
DECLARE
  fn text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.admin_command_login_grants'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on admin_command_login_grants';
  END IF;

  IF has_table_privilege('anon', 'public.admin_command_login_grants', 'SELECT')
     OR has_table_privilege('authenticated', 'public.admin_command_login_grants', 'SELECT') THEN
    RAISE EXCEPTION 'browser role unexpectedly has table access';
  END IF;

  FOREACH fn IN ARRAY ARRAY[
    'public.get_admin_command_login_context(bigint)',
    'public.create_admin_command_login_grant(bigint,text,text,timestamptz)',
    'public.consume_admin_command_login_token(text,text,text)',
    'public.consume_admin_command_device_grant(text)'
  ] LOOP
    IF has_function_privilege('anon', fn, 'EXECUTE')
       OR has_function_privilege('authenticated', fn, 'EXECUTE')
       OR has_function_privilege('public', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'browser/PUBLIC execute privilege remains on %', fn;
    END IF;
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role lacks execute on %', fn;
    END IF;
  END LOOP;
END
$$;
