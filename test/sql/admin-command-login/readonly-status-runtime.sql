\set ON_ERROR_STOP on

-- Status polling must not mutate grant rows. An expired pending row is ignored by
-- the watch function but remains unchanged until the next issue/consume operation
-- normalizes it. This protects the high-frequency web watcher from write churn.
DO $$
DECLARE
  r record;
  v_user_id uuid;
  v_grant_id uuid;
BEGIN
  SELECT id INTO v_user_id
    FROM public.app_users
   WHERE lower(username) = 'budi'
   LIMIT 1;

  INSERT INTO public.admin_command_login_grants (
    user_id, telegram_user_id, target, token_hash, device_hash,
    state, expires_at, grant_purpose, code_attempts
  ) VALUES (
    v_user_id, 999999001, 'direct', repeat('9', 64), NULL,
    'pending', now() - interval '1 minute', 'maintenance_code', 0
  ) RETURNING id INTO v_grant_id;

  SELECT * INTO r FROM public.get_admin_maintenance_code_status();
  IF r.active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'expired code advertised as active: %', row_to_json(r);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.admin_command_login_grants
     WHERE id = v_grant_id
       AND state = 'pending'
       AND code_attempts = 0
  ) THEN
    RAISE EXCEPTION 'status polling mutated expired grant state';
  END IF;

  DELETE FROM public.admin_command_login_grants WHERE id = v_grant_id;
END
$$;
