-- =========================================================================
-- Auto-Cuan maintenance admin login by short Telegram code.
--
-- Flow:
--   verified admin sends /akses -> bot issues one 6-digit code -> maintenance
--   page detects an active code -> admin types it -> server consumes it once and
--   issues the existing signed ac_sess cookie.
--
-- Security:
--   - only the Telegram identity already bound to admin `budi` may issue a code;
--   - the raw 6-digit code is never stored, only a 64-char server-HMAC digest;
--   - one active code at a time, 2-minute TTL, maximum 5 wrong attempts;
--   - account approval/block state and Telegram binding are rechecked at consume;
--   - Telegram message ids are retained only for best-effort UI cleanup;
--   - server audit/grant state remains even when Telegram messages are deleted.
-- =========================================================================

ALTER TABLE public.admin_command_login_grants
  ADD COLUMN IF NOT EXISTS grant_purpose text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS code_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS telegram_code_chat_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_code_message_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_success_message_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_messages_cleaned_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_admin_command_login_maintenance_code_pending
  ON public.admin_command_login_grants (user_id, created_at DESC)
  WHERE target = 'direct' AND grant_purpose = 'maintenance_code' AND state = 'pending';

CREATE OR REPLACE FUNCTION public.issue_admin_maintenance_code(
  p_telegram_user_id bigint,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS TABLE (
  result_code text,
  grant_id uuid,
  user_id uuid,
  username text,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
  v_grant public.admin_command_login_grants%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'invalid_token'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF p_expires_at <= now() OR p_expires_at > now() + interval '5 minutes' THEN
    RETURN QUERY SELECT 'invalid_expiry'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT au.* INTO v_user
    FROM public.app_users AS au
   WHERE lower(au.username) = 'budi'
   FOR UPDATE;

  IF NOT FOUND OR v_user.is_blocked IS TRUE OR v_user.is_approved IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT v.* INTO v_ver
    FROM public.app_user_telegram_verifications AS v
   WHERE v.user_id = v_user.id
     AND v.telegram_user_id = p_telegram_user_id
     AND v.telegram_verified_at IS NOT NULL
     AND v.telegram_private_chat_id IS NOT NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'identity_mismatch'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE public.admin_command_login_grants AS g
     SET state = 'expired', updated_at = now()
   WHERE g.user_id = v_user.id
     AND g.target = 'direct'
     AND g.grant_purpose = 'maintenance_code'
     AND g.state = 'pending';

  INSERT INTO public.admin_command_login_grants (
    user_id,
    telegram_user_id,
    target,
    token_hash,
    device_hash,
    state,
    expires_at,
    grant_purpose,
    code_attempts
  ) VALUES (
    v_user.id,
    p_telegram_user_id,
    'direct',
    p_token_hash,
    NULL,
    'pending',
    p_expires_at,
    'maintenance_code',
    0
  ) RETURNING * INTO v_grant;

  DELETE FROM public.admin_command_login_grants AS g
   WHERE g.user_id = v_user.id
     AND g.state IN ('consumed','expired')
     AND g.updated_at < now() - interval '1 day';

  RETURN QUERY SELECT 'ok'::text, v_grant.id, v_user.id, v_user.username, v_grant.expires_at;
END
$$;

CREATE OR REPLACE FUNCTION public.record_admin_maintenance_code_message(
  p_grant_id uuid,
  p_telegram_user_id bigint,
  p_telegram_chat_id bigint,
  p_telegram_message_id bigint
)
RETURNS TABLE (result_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.admin_command_login_grants AS g
     SET telegram_code_chat_id = p_telegram_chat_id,
         telegram_code_message_id = p_telegram_message_id,
         updated_at = now()
   WHERE g.id = p_grant_id
     AND g.telegram_user_id = p_telegram_user_id
     AND g.target = 'direct'
     AND g.grant_purpose = 'maintenance_code'
     AND g.state = 'pending';

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::text;
END
$$;

CREATE OR REPLACE FUNCTION public.get_admin_maintenance_code_status()
RETURNS TABLE (
  result_code text,
  active boolean,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id uuid;
  v_expires_at timestamptz;
BEGIN
  SELECT au.id INTO v_user_id
    FROM public.app_users AS au
   WHERE lower(au.username) = 'budi'
     AND au.is_blocked IS DISTINCT FROM TRUE
     AND au.is_approved IS TRUE
   LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT 'not_eligible'::text, false, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE public.admin_command_login_grants AS g
     SET state = 'expired', updated_at = now()
   WHERE g.user_id = v_user_id
     AND g.target = 'direct'
     AND g.grant_purpose = 'maintenance_code'
     AND g.state = 'pending'
     AND (g.expires_at <= now() OR g.code_attempts >= 5);

  SELECT g.expires_at INTO v_expires_at
    FROM public.admin_command_login_grants AS g
   WHERE g.user_id = v_user_id
     AND g.target = 'direct'
     AND g.grant_purpose = 'maintenance_code'
     AND g.state = 'pending'
     AND g.expires_at > now()
     AND g.code_attempts < 5
   ORDER BY g.created_at DESC
   LIMIT 1;

  IF v_expires_at IS NULL THEN
    RETURN QUERY SELECT 'idle'::text, false, NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'active'::text, true, v_expires_at;
END
$$;

CREATE OR REPLACE FUNCTION public.consume_admin_maintenance_code(
  p_token_hash text
)
RETURNS TABLE (
  result_code text,
  grant_id uuid,
  user_id uuid,
  username text,
  attempts_remaining integer,
  telegram_chat_id bigint,
  telegram_code_message_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
  v_grant public.admin_command_login_grants%ROWTYPE;
  v_attempts integer;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'invalid_code'::text, NULL::uuid, NULL::uuid, NULL::text, 0, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  SELECT au.* INTO v_user
    FROM public.app_users AS au
   WHERE lower(au.username) = 'budi'
     AND au.is_blocked IS DISTINCT FROM TRUE
     AND au.is_approved IS TRUE
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text, 0, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  SELECT g.* INTO v_grant
    FROM public.admin_command_login_grants AS g
   WHERE g.user_id = v_user.id
     AND g.target = 'direct'
     AND g.grant_purpose = 'maintenance_code'
     AND g.state = 'pending'
   ORDER BY g.created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text, 0, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  IF v_grant.expires_at <= now() THEN
    UPDATE public.admin_command_login_grants AS g
       SET state = 'expired', updated_at = now()
     WHERE g.id = v_grant.id;
    RETURN QUERY SELECT 'expired'::text, v_grant.id, NULL::uuid, NULL::text, 0, v_grant.telegram_code_chat_id, v_grant.telegram_code_message_id;
    RETURN;
  END IF;

  IF v_grant.code_attempts >= 5 THEN
    UPDATE public.admin_command_login_grants AS g
       SET state = 'expired', updated_at = now()
     WHERE g.id = v_grant.id;
    RETURN QUERY SELECT 'locked'::text, v_grant.id, NULL::uuid, NULL::text, 0, v_grant.telegram_code_chat_id, v_grant.telegram_code_message_id;
    RETURN;
  END IF;

  IF v_grant.token_hash IS DISTINCT FROM p_token_hash THEN
    v_attempts := v_grant.code_attempts + 1;
    UPDATE public.admin_command_login_grants AS g
       SET code_attempts = v_attempts,
           state = CASE WHEN v_attempts >= 5 THEN 'expired' ELSE g.state END,
           updated_at = now()
     WHERE g.id = v_grant.id;

    RETURN QUERY SELECT
      CASE WHEN v_attempts >= 5 THEN 'locked' ELSE 'invalid_code' END::text,
      v_grant.id,
      NULL::uuid,
      NULL::text,
      greatest(0, 5 - v_attempts),
      v_grant.telegram_code_chat_id,
      v_grant.telegram_code_message_id;
    RETURN;
  END IF;

  SELECT v.* INTO v_ver
    FROM public.app_user_telegram_verifications AS v
   WHERE v.user_id = v_user.id
     AND v.telegram_user_id = v_grant.telegram_user_id
     AND v.telegram_verified_at IS NOT NULL
     AND v.telegram_private_chat_id IS NOT NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.admin_command_login_grants AS g
       SET state = 'expired', updated_at = now()
     WHERE g.id = v_grant.id;
    RETURN QUERY SELECT 'not_found'::text, v_grant.id, NULL::uuid, NULL::text, 0, v_grant.telegram_code_chat_id, v_grant.telegram_code_message_id;
    RETURN;
  END IF;

  UPDATE public.admin_command_login_grants AS g
     SET state = 'consumed', consumed_at = now(), updated_at = now()
   WHERE g.id = v_grant.id;

  RETURN QUERY SELECT
    'ok'::text,
    v_grant.id,
    v_user.id,
    v_user.username,
    greatest(0, 5 - v_grant.code_attempts),
    v_grant.telegram_code_chat_id,
    v_grant.telegram_code_message_id;
END
$$;

REVOKE ALL ON FUNCTION public.issue_admin_maintenance_code(bigint, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_admin_maintenance_code_message(uuid, bigint, bigint, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_admin_maintenance_code_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_admin_maintenance_code(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.issue_admin_maintenance_code(bigint, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_admin_maintenance_code_message(uuid, bigint, bigint, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_maintenance_code_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_admin_maintenance_code(text) TO service_role;
