-- =========================================================================
-- Auto-Cuan authentication recovery v1 (additive only)
--
-- Purpose:
--   1. One-time Telegram enrollment for the existing `budi` administrator.
--   2. Telegram-confirmed password reset for any unblocked account that already
--      has a verified private Telegram binding.
--
-- Security:
--   - No raw enrollment code or reset token is stored.
--   - RLS is enabled with no browser policies.
--   - Every RPC is SECURITY DEFINER, fixed-search-path, and service-role only.
--   - Existing app_users, registration approval, and Telegram channel flows are
--     not dropped or rewritten.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.auth_recovery_requests (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  purpose                    text NOT NULL CHECK (purpose IN ('telegram_enroll','password_reset')),
  request_ref                text NOT NULL UNIQUE,
  state                      text NOT NULL DEFAULT 'pending'
                               CHECK (state IN ('pending','approved','denied','consumed','expired','delivery_failed')),
  enrollment_code_hash       text,
  reset_token_hash           text,
  requested_telegram_user_id bigint,
  expires_at                 timestamptz NOT NULL,
  approved_at                timestamptz,
  denied_at                  timestamptz,
  consumed_at                timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (purpose = 'telegram_enroll' AND enrollment_code_hash IS NOT NULL)
    OR
    (purpose = 'password_reset')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_recovery_active_user_purpose
  ON public.auth_recovery_requests (user_id, purpose)
  WHERE state IN ('pending','approved');

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_recovery_active_enrollment_hash
  ON public.auth_recovery_requests (enrollment_code_hash)
  WHERE purpose = 'telegram_enroll'
    AND state = 'pending'
    AND enrollment_code_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_recovery_active_reset_hash
  ON public.auth_recovery_requests (reset_token_hash)
  WHERE purpose = 'password_reset'
    AND state = 'approved'
    AND reset_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auth_recovery_expiry
  ON public.auth_recovery_requests (expires_at)
  WHERE state IN ('pending','approved');

CREATE TABLE IF NOT EXISTS public.auth_recovery_webhook_updates (
  update_id    bigint PRIMARY KEY,
  outcome_code text,
  processed_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.auth_recovery_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_recovery_webhook_updates ENABLE ROW LEVEL SECURITY;

-- Create/rotate the one-time Telegram enrollment request for the existing admin.
CREATE OR REPLACE FUNCTION public.create_auth_telegram_enrollment_request(
  p_username text,
  p_request_ref text,
  p_code_hash text,
  p_expires_at timestamptz
)
RETURNS TABLE (
  result_code text,
  request_id uuid,
  user_id uuid,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_request public.auth_recovery_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_user
    FROM public.app_users
   WHERE lower(username) = lower(trim(p_username))
   FOR UPDATE;

  IF NOT FOUND OR lower(v_user.username) <> 'budi'
     OR v_user.is_blocked IS TRUE OR v_user.is_approved IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.app_user_telegram_verifications v
     WHERE v.user_id = v_user.id
       AND v.telegram_user_id IS NOT NULL
       AND v.telegram_verified_at IS NOT NULL
  ) THEN
    RETURN QUERY SELECT 'already_bound'::text, NULL::uuid, v_user.id, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE public.auth_recovery_requests
     SET state = 'expired', updated_at = now()
   WHERE user_id = v_user.id
     AND purpose = 'telegram_enroll'
     AND state IN ('pending','approved');

  INSERT INTO public.auth_recovery_requests (
    user_id, purpose, request_ref, state, enrollment_code_hash, expires_at
  ) VALUES (
    v_user.id, 'telegram_enroll', p_request_ref, 'pending', p_code_hash, p_expires_at
  ) RETURNING * INTO v_request;

  RETURN QUERY SELECT 'ok'::text, v_request.id, v_user.id, v_request.expires_at;
END
$$;

-- Atomically consume an enrollment code and bind the sender's private Telegram
-- identity to the existing budi account.
CREATE OR REPLACE FUNCTION public.consume_auth_telegram_enrollment(
  p_code_hash text,
  p_telegram_user_id bigint,
  p_private_chat_id bigint
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
  v_rows integer;
BEGIN
  SELECT * INTO v_request
    FROM public.auth_recovery_requests
   WHERE purpose = 'telegram_enroll'
     AND state = 'pending'
     AND enrollment_code_hash = p_code_hash
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

  IF NOT FOUND OR lower(v_user.username) <> 'budi'
     OR v_user.is_blocked IS TRUE OR v_user.is_approved IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.app_user_telegram_verifications v
     WHERE v.telegram_user_id = p_telegram_user_id
       AND v.user_id <> v_user.id
  ) THEN
    RETURN QUERY SELECT 'telegram_used_elsewhere'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.app_user_telegram_verifications (
      user_id,
      telegram_user_id,
      telegram_private_chat_id,
      telegram_verified_at,
      created_at,
      updated_at
    ) VALUES (
      v_user.id,
      p_telegram_user_id,
      p_private_chat_id,
      now(),
      now(),
      now()
    )
    ON CONFLICT (user_id) DO UPDATE
      SET telegram_user_id = EXCLUDED.telegram_user_id,
          telegram_private_chat_id = EXCLUDED.telegram_private_chat_id,
          telegram_verified_at = COALESCE(
            public.app_user_telegram_verifications.telegram_verified_at,
            EXCLUDED.telegram_verified_at
          ),
          updated_at = now()
      WHERE public.app_user_telegram_verifications.telegram_user_id IS NULL
         OR public.app_user_telegram_verifications.telegram_user_id = EXCLUDED.telegram_user_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'telegram_used_elsewhere'::text, NULL::uuid, NULL::text;
    RETURN;
  END;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN QUERY SELECT 'bound_other_telegram'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  UPDATE public.auth_recovery_requests
     SET state = 'consumed',
         requested_telegram_user_id = p_telegram_user_id,
         consumed_at = now(),
         updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_user.id, v_user.username;
END
$$;

-- Create a reset request only when the account exists, is not blocked, and has a
-- verified private Telegram binding. Callers intentionally return a generic public
-- response regardless of this function's result.
CREATE OR REPLACE FUNCTION public.create_auth_password_reset_request(
  p_username text,
  p_request_ref text,
  p_expires_at timestamptz
)
RETURNS TABLE (
  result_code text,
  request_id uuid,
  user_id uuid,
  username text,
  telegram_user_id bigint,
  telegram_private_chat_id bigint,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
  v_request public.auth_recovery_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_user
    FROM public.app_users
   WHERE lower(username) = lower(trim(p_username))
   FOR UPDATE;

  IF NOT FOUND OR v_user.is_blocked IS TRUE THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO v_ver
    FROM public.app_user_telegram_verifications
   WHERE user_id = v_user.id
     AND telegram_user_id IS NOT NULL
     AND telegram_private_chat_id IS NOT NULL
     AND telegram_verified_at IS NOT NULL;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_bound'::text, NULL::uuid, v_user.id, NULL::text,
                        NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE public.auth_recovery_requests
     SET state = 'expired', updated_at = now()
   WHERE user_id = v_user.id
     AND purpose = 'password_reset'
     AND state IN ('pending','approved');

  INSERT INTO public.auth_recovery_requests (
    user_id, purpose, request_ref, state, requested_telegram_user_id, expires_at
  ) VALUES (
    v_user.id, 'password_reset', p_request_ref, 'pending', v_ver.telegram_user_id, p_expires_at
  ) RETURNING * INTO v_request;

  RETURN QUERY SELECT 'ok'::text, v_request.id, v_user.id, v_user.username,
                      v_ver.telegram_user_id, v_ver.telegram_private_chat_id,
                      v_request.expires_at;
END
$$;

CREATE OR REPLACE FUNCTION public.approve_auth_password_reset_request(
  p_request_ref text,
  p_telegram_user_id bigint,
  p_reset_token_hash text,
  p_reset_expires_at timestamptz
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
  SELECT * INTO v_request
    FROM public.auth_recovery_requests
   WHERE request_ref = p_request_ref
     AND purpose = 'password_reset'
     AND state = 'pending'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() THEN
    UPDATE public.auth_recovery_requests
       SET state = 'expired', updated_at = now()
     WHERE id = v_request.id;
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  SELECT * INTO v_ver
    FROM public.app_user_telegram_verifications
   WHERE user_id = v_request.user_id
     AND telegram_user_id = p_telegram_user_id
     AND telegram_verified_at IS NOT NULL;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'identity_mismatch'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  SELECT * INTO v_user
    FROM public.app_users
   WHERE id = v_request.user_id
     AND is_blocked IS DISTINCT FROM TRUE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.auth_recovery_requests
     SET state = 'approved',
         reset_token_hash = p_reset_token_hash,
         expires_at = LEAST(p_reset_expires_at, now() + interval '15 minutes'),
         approved_at = now(),
         updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_user.id, v_user.username, v_ver.telegram_private_chat_id;
END
$$;

CREATE OR REPLACE FUNCTION public.deny_auth_password_reset_request(
  p_request_ref text,
  p_telegram_user_id bigint
)
RETURNS TABLE (result_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.auth_recovery_requests%ROWTYPE;
BEGIN
  SELECT r.* INTO v_request
    FROM public.auth_recovery_requests r
    JOIN public.app_user_telegram_verifications v ON v.user_id = r.user_id
   WHERE r.request_ref = p_request_ref
     AND r.purpose = 'password_reset'
     AND r.state = 'pending'
     AND v.telegram_user_id = p_telegram_user_id
   FOR UPDATE OF r;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text;
    RETURN;
  END IF;

  UPDATE public.auth_recovery_requests
     SET state = 'denied', denied_at = now(), updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'ok'::text;
END
$$;

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

  UPDATE public.app_users
     SET password_hash = p_new_password_hash,
         last_login_at = now()
   WHERE id = v_user.id;

  UPDATE public.auth_recovery_requests
     SET state = 'consumed', consumed_at = now(), updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_user.id, v_user.username;
END
$$;

-- Idempotent coarse webhook dedupe for recovery-specific updates.
CREATE OR REPLACE FUNCTION public.claim_auth_recovery_webhook_update(
  p_update_id bigint
)
RETURNS TABLE (claimed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.auth_recovery_webhook_updates (update_id)
  VALUES (p_update_id)
  ON CONFLICT (update_id) DO NOTHING;

  RETURN QUERY SELECT FOUND;
END
$$;

CREATE OR REPLACE FUNCTION public.complete_auth_recovery_webhook_update(
  p_update_id bigint,
  p_outcome_code text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.auth_recovery_webhook_updates
     SET outcome_code = left(coalesce(p_outcome_code, 'unknown'), 80),
         processed_at = now()
   WHERE update_id = p_update_id;
$$;

REVOKE ALL ON public.auth_recovery_requests FROM anon, authenticated;
REVOKE ALL ON public.auth_recovery_webhook_updates FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.create_auth_telegram_enrollment_request(text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_auth_telegram_enrollment(text,bigint,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_auth_password_reset_request(text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_auth_password_reset_request(text,bigint,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deny_auth_password_reset_request(text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_auth_password_reset(text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_auth_recovery_webhook_update(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_auth_recovery_webhook_update(bigint,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_auth_telegram_enrollment_request(text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_auth_telegram_enrollment(text,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_auth_password_reset_request(text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_auth_password_reset_request(text,bigint,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.deny_auth_password_reset_request(text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_auth_password_reset(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_auth_recovery_webhook_update(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_auth_recovery_webhook_update(bigint,text) TO service_role;
