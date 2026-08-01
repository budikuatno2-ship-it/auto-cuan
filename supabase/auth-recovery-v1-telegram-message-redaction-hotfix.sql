-- =========================================================================
-- Authentication recovery v1 — Telegram reset-link redaction hotfix
--
-- Apply AFTER:
--   1. auth-telegram-recovery-v1-migration.sql
--   2. auth-telegram-recovery-v1-device-retirement-hotfix.sql
--
-- Stores the exact private Telegram message that contains the one-time reset
-- link. After the website consumes the reset token, the API edits that message
-- into a password-changed confirmation so the token is no longer displayed.
-- Existing v1 RPCs remain available for rollback compatibility.
-- =========================================================================

BEGIN;

ALTER TABLE public.auth_recovery_requests
  ADD COLUMN IF NOT EXISTS reset_message_chat_id bigint,
  ADD COLUMN IF NOT EXISTS reset_message_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_completion_notified_at timestamptz;

CREATE OR REPLACE FUNCTION public.approve_auth_password_reset_request_v2(
  p_request_ref text,
  p_telegram_user_id bigint,
  p_reset_token_hash text,
  p_reset_expires_at timestamptz,
  p_message_chat_id bigint,
  p_message_id bigint
)
RETURNS TABLE (
  result_code text,
  user_id uuid,
  username text,
  telegram_private_chat_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.auth_recovery_requests%ROWTYPE;
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
BEGIN
  SELECT r.* INTO v_request
    FROM public.auth_recovery_requests AS r
   WHERE r.request_ref = p_request_ref
     AND r.purpose = 'password_reset'
     AND r.state = 'pending'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() THEN
    UPDATE public.auth_recovery_requests AS r
       SET state = 'expired', updated_at = now()
     WHERE r.id = v_request.id;
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  SELECT v.* INTO v_ver
    FROM public.app_user_telegram_verifications AS v
   WHERE v.user_id = v_request.user_id
     AND v.telegram_user_id = p_telegram_user_id
     AND v.telegram_private_chat_id = p_message_chat_id
     AND v.telegram_verified_at IS NOT NULL;

  IF NOT FOUND OR p_message_id IS NULL OR p_message_id <= 0 THEN
    RETURN QUERY SELECT 'identity_mismatch'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  SELECT u.* INTO v_user
    FROM public.app_users AS u
   WHERE u.id = v_request.user_id
     AND u.is_blocked IS DISTINCT FROM TRUE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.auth_recovery_requests AS r
     SET state = 'approved',
         reset_token_hash = p_reset_token_hash,
         reset_message_chat_id = p_message_chat_id,
         reset_message_id = p_message_id,
         expires_at = LEAST(p_reset_expires_at, now() + interval '15 minutes'),
         approved_at = now(),
         updated_at = now()
   WHERE r.id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_user.id, v_user.username, v_ver.telegram_private_chat_id;
END
$$;

CREATE OR REPLACE FUNCTION public.consume_auth_password_reset_v2(
  p_reset_token_hash text,
  p_new_password_hash text
)
RETURNS TABLE (
  result_code text,
  request_id uuid,
  user_id uuid,
  username text,
  reset_message_chat_id bigint,
  reset_message_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.auth_recovery_requests%ROWTYPE;
  v_user public.app_users%ROWTYPE;
BEGIN
  SELECT r.* INTO v_request
    FROM public.auth_recovery_requests AS r
   WHERE r.purpose = 'password_reset'
     AND r.state = 'approved'
     AND r.reset_token_hash = p_reset_token_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() THEN
    UPDATE public.auth_recovery_requests AS r
       SET state = 'expired', updated_at = now()
     WHERE r.id = v_request.id;
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  SELECT u.* INTO v_user
    FROM public.app_users AS u
   WHERE u.id = v_request.user_id
   FOR UPDATE;

  IF NOT FOUND OR v_user.is_blocked IS TRUE THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.app_users AS u
     SET password_hash = p_new_password_hash,
         device_id = 'retired_' || pg_catalog.gen_random_uuid()::text,
         devices = '[]'::jsonb,
         last_login_at = now()
   WHERE u.id = v_user.id;

  UPDATE public.auth_recovery_requests AS r
     SET state = 'consumed',
         consumed_at = now(),
         updated_at = now()
   WHERE r.id = v_request.id;

  RETURN QUERY SELECT 'ok'::text,
                      v_request.id,
                      v_user.id,
                      v_user.username,
                      v_request.reset_message_chat_id,
                      v_request.reset_message_id;
END
$$;

REVOKE ALL ON FUNCTION public.approve_auth_password_reset_request_v2(
  text,bigint,text,timestamptz,bigint,bigint
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_auth_password_reset_request_v2(
  text,bigint,text,timestamptz,bigint,bigint
) TO service_role;

REVOKE ALL ON FUNCTION public.consume_auth_password_reset_v2(text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_auth_password_reset_v2(text,text)
  TO service_role;

COMMIT;
