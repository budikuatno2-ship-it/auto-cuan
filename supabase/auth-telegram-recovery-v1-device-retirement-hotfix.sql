-- =========================================================================
-- Authentication recovery v1 — legacy-device retirement hotfix
--
-- Apply AFTER auth-telegram-recovery-v1-migration.sql.
-- Replaces only the reset-consume RPC so password recovery atomically:
--   1. changes the password,
--   2. invalidates every legacy device binding used by the historical `budi + .`
--      compatibility path,
--   3. consumes the one-time reset grant.
--
-- The current login gateway does not use device_id/devices as credentials.
-- Existing registration may continue populating those columns for schema
-- compatibility, but they no longer authorize login or password recovery.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.consume_auth_password_reset(
  p_reset_token_hash text,
  p_new_password_hash text
)
RETURNS TABLE (
  result_code text,
  user_id uuid,
  username text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.auth_recovery_requests%ROWTYPE;
  v_user public.app_users%ROWTYPE;
BEGIN
  SELECT * INTO v_request
    FROM public.auth_recovery_requests
   WHERE purpose = 'password_reset'
     AND state = 'approved'
     AND reset_token_hash = p_reset_token_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() THEN
    UPDATE public.auth_recovery_requests
       SET state = 'expired', updated_at = now()
     WHERE id = v_request.id;
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO v_user
    FROM public.app_users
   WHERE id = v_request.user_id
   FOR UPDATE;

  IF NOT FOUND OR v_user.is_blocked IS TRUE THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Atomic credential transition. The random retired marker satisfies the
  -- historical NOT NULL device_id column but cannot match any browser value.
  -- Clearing devices disables every previously registered legacy device.
  UPDATE public.app_users
     SET password_hash = p_new_password_hash,
         device_id = 'retired_' || pg_catalog.gen_random_uuid()::text,
         devices = '[]'::jsonb,
         last_login_at = now()
   WHERE id = v_user.id;

  UPDATE public.auth_recovery_requests
     SET state = 'consumed',
         consumed_at = now(),
         updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_user.id, v_user.username;
END
$$;

REVOKE ALL ON FUNCTION public.consume_auth_password_reset(text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_auth_password_reset(text,text)
  TO service_role;
