-- =========================================================================
-- Auto-Cuan admin Telegram access approval (additive only).
--
-- Purpose:
--   Replaces the maintenance-page username/password admin entry with a
--   Telegram-approved, browser-bound, one-time challenge. It reuses the
--   existing `budi` admin account and its existing verified Telegram binding
--   (public.app_user_telegram_verifications, set up by the auth-recovery-v1
--   enrollment flow) as the identity check. Authorization is still only ever
--   granted by the existing signed HttpOnly ac_sess cookie issued server-side
--   after this challenge is consumed — this table never grants access itself.
--
-- Security:
--   - New table only. No existing table, column, or constraint is altered.
--   - Every RPC is SECURITY DEFINER, fixed-search-path, and service-role only.
--   - No raw challenge/browser-binding value is stored, only its SHA-256 hash.
--   - At most one active (pending/approved) request per admin user at a time.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.admin_access_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  request_ref           text NOT NULL UNIQUE,
  browser_binding_hash  text NOT NULL,
  state                 text NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending','approved','denied','consumed','expired')),
  telegram_user_id      bigint,
  telegram_chat_id      bigint,
  telegram_message_id   bigint,
  request_context       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  approved_at           timestamptz,
  denied_at             timestamptz,
  consumed_at           timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_access_active_user
  ON public.admin_access_requests (user_id)
  WHERE state IN ('pending','approved');

CREATE INDEX IF NOT EXISTS idx_admin_access_expiry
  ON public.admin_access_requests (expires_at)
  WHERE state IN ('pending','approved');

ALTER TABLE public.admin_access_requests ENABLE ROW LEVEL SECURITY;

-- Create a new admin-access challenge for the given (always 'budi') account.
-- Fails closed with a distinct result_code when: the account is not the
-- eligible admin, it has no verified Telegram binding, or a request was
-- created for it within the last 10 seconds (soft anti-spam throttle so a
-- repeatedly-clicked public button cannot flood the admin's Telegram).
CREATE OR REPLACE FUNCTION public.create_admin_access_request(
  p_username text,
  p_request_ref text,
  p_browser_binding_hash text,
  p_expires_at timestamptz,
  p_context text
)
RETURNS TABLE (
  result_code text,
  request_id uuid,
  user_id uuid,
  telegram_user_id bigint,
  telegram_chat_id bigint,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
  v_request public.admin_access_requests%ROWTYPE;
  v_recent public.admin_access_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_user
    FROM public.app_users
   WHERE lower(username) = lower(trim(p_username))
   FOR UPDATE;

  IF NOT FOUND OR lower(v_user.username) <> 'budi'
     OR v_user.is_blocked IS TRUE OR v_user.is_approved IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::uuid, NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO v_ver
    FROM public.app_user_telegram_verifications
   WHERE user_id = v_user.id
     AND telegram_user_id IS NOT NULL
     AND telegram_private_chat_id IS NOT NULL
     AND telegram_verified_at IS NOT NULL;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_bound'::text, NULL::uuid, v_user.id, NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO v_recent
    FROM public.admin_access_requests
   WHERE user_id = v_user.id
     AND state IN ('pending','approved')
     AND created_at > now() - interval '10 seconds'
   ORDER BY created_at DESC
   LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT 'throttled'::text, NULL::uuid, v_user.id, NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE public.admin_access_requests
     SET state = 'expired', updated_at = now()
   WHERE user_id = v_user.id
     AND state IN ('pending','approved');

  INSERT INTO public.admin_access_requests (
    user_id, request_ref, browser_binding_hash, state, expires_at, request_context
  ) VALUES (
    v_user.id, p_request_ref, p_browser_binding_hash, 'pending', p_expires_at, left(coalesce(p_context, ''), 200)
  ) RETURNING * INTO v_request;

  RETURN QUERY SELECT 'ok'::text, v_request.id, v_user.id,
                      v_ver.telegram_user_id, v_ver.telegram_private_chat_id,
                      v_request.expires_at;
END
$$;

-- Records the Telegram message identity right after it is sent, so it can
-- later be edited/deleted without a second round trip through the browser.
CREATE OR REPLACE FUNCTION public.record_admin_access_message(
  p_request_ref text,
  p_telegram_chat_id bigint,
  p_telegram_message_id bigint
)
RETURNS TABLE (result_code text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH updated AS (
    UPDATE public.admin_access_requests
       SET telegram_chat_id = p_telegram_chat_id,
           telegram_message_id = p_telegram_message_id,
           updated_at = now()
     WHERE request_ref = p_request_ref
       AND state = 'pending'
    RETURNING 1
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'ok' ELSE 'not_found' END;
$$;

-- Telegram callback: approve. Verifies the pressing Telegram user is the
-- SAME identity already bound to this admin account (never username alone).
CREATE OR REPLACE FUNCTION public.approve_admin_access_request(
  p_request_ref text,
  p_telegram_user_id bigint
)
RETURNS TABLE (
  result_code text,
  telegram_chat_id bigint,
  telegram_message_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.admin_access_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_request
    FROM public.admin_access_requests
   WHERE request_ref = p_request_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() AND v_request.state IN ('pending','approved') THEN
    UPDATE public.admin_access_requests SET state = 'expired', updated_at = now() WHERE id = v_request.id;
    RETURN QUERY SELECT 'expired'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  IF v_request.state <> 'pending' THEN
    RETURN QUERY SELECT ('already_' || v_request.state)::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.app_user_telegram_verifications v
     WHERE v.user_id = v_request.user_id
       AND v.telegram_user_id = p_telegram_user_id
       AND v.telegram_verified_at IS NOT NULL
  ) THEN
    RETURN QUERY SELECT 'identity_mismatch'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  UPDATE public.admin_access_requests
     SET state = 'approved',
         telegram_user_id = p_telegram_user_id,
         approved_at = now(),
         updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
END
$$;

-- Telegram callback: deny. Same identity check as approve.
CREATE OR REPLACE FUNCTION public.deny_admin_access_request(
  p_request_ref text,
  p_telegram_user_id bigint
)
RETURNS TABLE (
  result_code text,
  telegram_chat_id bigint,
  telegram_message_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.admin_access_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_request
    FROM public.admin_access_requests
   WHERE request_ref = p_request_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() AND v_request.state IN ('pending','approved') THEN
    UPDATE public.admin_access_requests SET state = 'expired', updated_at = now() WHERE id = v_request.id;
    RETURN QUERY SELECT 'expired'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  IF v_request.state <> 'pending' THEN
    RETURN QUERY SELECT ('already_' || v_request.state)::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.app_user_telegram_verifications v
     WHERE v.user_id = v_request.user_id
       AND v.telegram_user_id = p_telegram_user_id
       AND v.telegram_verified_at IS NOT NULL
  ) THEN
    RETURN QUERY SELECT 'identity_mismatch'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  UPDATE public.admin_access_requests
     SET state = 'denied',
         telegram_user_id = p_telegram_user_id,
         denied_at = now(),
         updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
END
$$;

-- Browser poll/consume. Atomic: only ever transitions 'approved' -> 'consumed'
-- exactly once (FOR UPDATE serializes concurrent pollers), and only for the
-- exact browser that created the request (browser_binding_hash match).
-- A binding mismatch is reported identically to not_found so a wrong browser
-- cannot distinguish "exists but not mine" from "does not exist".
CREATE OR REPLACE FUNCTION public.consume_admin_access_request(
  p_request_ref text,
  p_browser_binding_hash text
)
RETURNS TABLE (
  result_code text,
  user_id uuid,
  username text,
  telegram_chat_id bigint,
  telegram_message_id bigint,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.admin_access_requests%ROWTYPE;
  v_user public.app_users%ROWTYPE;
BEGIN
  SELECT * INTO v_request
    FROM public.admin_access_requests
   WHERE request_ref = p_request_ref
   FOR UPDATE;

  IF NOT FOUND OR v_request.browser_binding_hash <> p_browser_binding_hash THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() THEN
    IF v_request.state IN ('pending','approved') THEN
      UPDATE public.admin_access_requests SET state = 'expired', updated_at = now() WHERE id = v_request.id;
    END IF;
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, v_request.expires_at;
    RETURN;
  END IF;

  IF v_request.state = 'denied' THEN
    RETURN QUERY SELECT 'denied'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, v_request.expires_at;
    RETURN;
  END IF;

  IF v_request.state = 'consumed' THEN
    RETURN QUERY SELECT 'already_consumed'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, v_request.expires_at;
    RETURN;
  END IF;

  IF v_request.state = 'pending' THEN
    RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, v_request.expires_at;
    RETURN;
  END IF;

  -- state = 'approved'
  SELECT * INTO v_user FROM public.app_users WHERE id = v_request.user_id AND is_blocked IS DISTINCT FROM TRUE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE public.admin_access_requests
     SET state = 'consumed', consumed_at = now(), updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_user.id, v_user.username, v_request.telegram_chat_id, v_request.telegram_message_id, v_request.expires_at;
END
$$;

REVOKE ALL ON public.admin_access_requests FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.create_admin_access_request(text,text,text,timestamptz,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_admin_access_message(text,bigint,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_admin_access_request(text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deny_admin_access_request(text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_admin_access_request(text,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_admin_access_request(text,text,text,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_admin_access_message(text,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_admin_access_request(text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.deny_admin_access_request(text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_admin_access_request(text,text) TO service_role;
