-- =========================================================================
-- Auto-Cuan admin login initiated from Telegram command /akses.
--
-- UX goal:
--   Telegram /akses -> choose HP or Laptop.
--   HP: one-time URL opens Auto-Cuan and issues the existing signed ac_sess.
--   Laptop: a previously paired laptop tab consumes a short-lived device-bound
--           grant automatically. First use requires one one-time pairing link
--           opened on that laptop; no numeric code is ever typed.
--
-- Security model:
--   - Telegram identity must already be verified for the existing admin user budi.
--   - Raw login/device tokens are never stored; only SHA-256 hashes are stored.
--   - Grants are short-lived and one-time (pending -> consumed/expired).
--   - Device polling is bound to a random HttpOnly ac_admin_dev cookie.
--   - Account approval/block state and Telegram binding are rechecked at consume.
--   - RPCs are SECURITY DEFINER, fixed-search-path and service_role only.
--   - The existing signed HttpOnly ac_sess remains the only authorization token.
-- =========================================================================

ALTER TABLE public.app_user_telegram_verifications
  ADD COLUMN IF NOT EXISTS admin_device_hash text,
  ADD COLUMN IF NOT EXISTS admin_device_label text,
  ADD COLUMN IF NOT EXISTS admin_device_bound_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_user_telegram_admin_device_hash
  ON public.app_user_telegram_verifications (admin_device_hash)
  WHERE admin_device_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.admin_command_login_grants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  telegram_user_id  bigint NOT NULL,
  target            text NOT NULL CHECK (target IN ('direct','pair','device')),
  token_hash        text,
  device_hash       text,
  state             text NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending','consumed','expired')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_command_login_grant_shape CHECK (
    (target IN ('direct','pair') AND token_hash IS NOT NULL AND device_hash IS NULL)
    OR
    (target = 'device' AND token_hash IS NULL AND device_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_command_login_token_hash
  ON public.admin_command_login_grants (token_hash)
  WHERE token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_command_login_device_pending
  ON public.admin_command_login_grants (device_hash, created_at DESC)
  WHERE target = 'device' AND state = 'pending';

CREATE INDEX IF NOT EXISTS idx_admin_command_login_expiry
  ON public.admin_command_login_grants (expires_at)
  WHERE state = 'pending';

ALTER TABLE public.admin_command_login_grants ENABLE ROW LEVEL SECURITY;

-- Verify that a Telegram sender is the currently-bound, approved, unblocked
-- administrator. Used only by the verification-bot webhook.
CREATE OR REPLACE FUNCTION public.get_admin_command_login_context(
  p_telegram_user_id bigint
)
RETURNS TABLE (
  result_code text,
  user_id uuid,
  username text,
  device_bound boolean,
  device_label text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
BEGIN
  SELECT au.* INTO v_user
    FROM public.app_users AS au
   WHERE lower(au.username) = 'budi'
   LIMIT 1;

  IF NOT FOUND OR v_user.is_blocked IS TRUE OR v_user.is_approved IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::text, false, NULL::text;
    RETURN;
  END IF;

  SELECT v.* INTO v_ver
    FROM public.app_user_telegram_verifications AS v
   WHERE v.user_id = v_user.id
     AND v.telegram_user_id = p_telegram_user_id
     AND v.telegram_verified_at IS NOT NULL
     AND v.telegram_private_chat_id IS NOT NULL
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'identity_mismatch'::text, NULL::uuid, NULL::text, false, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    'ok'::text,
    v_user.id,
    v_user.username,
    (v_ver.admin_device_hash IS NOT NULL),
    v_ver.admin_device_label;
END
$$;

-- Create exactly one short-lived grant for an already-verified Telegram admin.
-- The app holds the raw token/device secret; Postgres stores only its hash.
CREATE OR REPLACE FUNCTION public.create_admin_command_login_grant(
  p_telegram_user_id bigint,
  p_target text,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS TABLE (
  result_code text,
  grant_id uuid,
  user_id uuid,
  username text,
  device_bound boolean,
  device_label text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
  v_grant public.admin_command_login_grants%ROWTYPE;
  v_device_hash text;
BEGIN
  IF p_target NOT IN ('direct','pair','device') THEN
    RETURN QUERY SELECT 'invalid_target'::text, NULL::uuid, NULL::uuid, NULL::text, false, NULL::text;
    RETURN;
  END IF;

  IF p_expires_at <= now() OR p_expires_at > now() + interval '5 minutes' THEN
    RETURN QUERY SELECT 'invalid_expiry'::text, NULL::uuid, NULL::uuid, NULL::text, false, NULL::text;
    RETURN;
  END IF;

  SELECT au.* INTO v_user
    FROM public.app_users AS au
   WHERE lower(au.username) = 'budi'
   FOR UPDATE;

  IF NOT FOUND OR v_user.is_blocked IS TRUE OR v_user.is_approved IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::uuid, NULL::text, false, NULL::text;
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
    RETURN QUERY SELECT 'identity_mismatch'::text, NULL::uuid, NULL::uuid, NULL::text, false, NULL::text;
    RETURN;
  END IF;

  UPDATE public.admin_command_login_grants AS g
     SET state = 'expired', updated_at = now()
   WHERE g.user_id = v_user.id
     AND g.state = 'pending'
     AND g.expires_at <= now();

  -- Keep the state tiny and deterministic: a new command replaces older
  -- unconsumed grants of the same target for this admin.
  UPDATE public.admin_command_login_grants AS g
     SET state = 'expired', updated_at = now()
   WHERE g.user_id = v_user.id
     AND g.state = 'pending'
     AND g.target = p_target;

  IF p_target = 'device' THEN
    IF v_ver.admin_device_hash IS NULL THEN
      RETURN QUERY SELECT 'device_unbound'::text, NULL::uuid, v_user.id, v_user.username, false, v_ver.admin_device_label;
      RETURN;
    END IF;
    v_device_hash := v_ver.admin_device_hash;
  ELSE
    IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
      RETURN QUERY SELECT 'invalid_token'::text, NULL::uuid, v_user.id, v_user.username, (v_ver.admin_device_hash IS NOT NULL), v_ver.admin_device_label;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.admin_command_login_grants (
    user_id, telegram_user_id, target, token_hash, device_hash, state, expires_at
  ) VALUES (
    v_user.id,
    p_telegram_user_id,
    p_target,
    CASE WHEN p_target = 'device' THEN NULL ELSE p_token_hash END,
    CASE WHEN p_target = 'device' THEN v_device_hash ELSE NULL END,
    'pending',
    p_expires_at
  ) RETURNING * INTO v_grant;

  DELETE FROM public.admin_command_login_grants AS g
   WHERE g.user_id = v_user.id
     AND g.state IN ('consumed','expired')
     AND g.updated_at < now() - interval '1 day';

  RETURN QUERY SELECT
    'ok'::text,
    v_grant.id,
    v_user.id,
    v_user.username,
    (v_ver.admin_device_hash IS NOT NULL),
    v_ver.admin_device_label;
END
$$;

-- Consume a one-time direct/pair URL. Pair mode additionally binds the browser
-- as the single trusted "Laptop utama" by storing only the device-secret hash.
CREATE OR REPLACE FUNCTION public.consume_admin_command_login_token(
  p_token_hash text,
  p_new_device_hash text DEFAULT NULL,
  p_device_label text DEFAULT NULL
)
RETURNS TABLE (
  result_code text,
  user_id uuid,
  username text,
  target text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_grant public.admin_command_login_grants%ROWTYPE;
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT g.* INTO v_grant
    FROM public.admin_command_login_grants AS g
   WHERE g.token_hash = p_token_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_grant.state <> 'pending' THEN
    RETURN QUERY SELECT ('already_' || v_grant.state)::text, NULL::uuid, NULL::text, v_grant.target;
    RETURN;
  END IF;

  IF v_grant.expires_at <= now() THEN
    UPDATE public.admin_command_login_grants AS g
       SET state = 'expired', updated_at = now()
     WHERE g.id = v_grant.id;
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::text, v_grant.target;
    RETURN;
  END IF;

  IF v_grant.target NOT IN ('direct','pair') THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT au.* INTO v_user
    FROM public.app_users AS au
   WHERE au.id = v_grant.user_id
     AND lower(au.username) = 'budi'
     AND au.is_blocked IS DISTINCT FROM TRUE
     AND au.is_approved IS TRUE
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text;
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
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_grant.target = 'pair' THEN
    IF p_new_device_hash IS NULL OR p_new_device_hash !~ '^[0-9a-f]{64}$' THEN
      RETURN QUERY SELECT 'device_required'::text, NULL::uuid, NULL::text, v_grant.target;
      RETURN;
    END IF;

    UPDATE public.app_user_telegram_verifications AS v
       SET admin_device_hash = p_new_device_hash,
           admin_device_label = left(coalesce(nullif(trim(p_device_label), ''), 'Laptop utama'), 80),
           admin_device_bound_at = now()
     WHERE v.user_id = v_user.id
       AND v.telegram_user_id = v_grant.telegram_user_id;

    -- A newly paired laptop invalidates any old device-target grant created for
    -- the previous device hash.
    UPDATE public.admin_command_login_grants AS g
       SET state = 'expired', updated_at = now()
     WHERE g.user_id = v_user.id
       AND g.state = 'pending'
       AND g.target = 'device';
  END IF;

  UPDATE public.admin_command_login_grants AS g
     SET state = 'consumed', consumed_at = now(), updated_at = now()
   WHERE g.id = v_grant.id;

  RETURN QUERY SELECT 'ok'::text, v_user.id, v_user.username, v_grant.target;
END
$$;

-- Called by a maintenance tab carrying the HttpOnly trusted-device cookie.
-- It atomically consumes a Telegram-created device grant and returns only the
-- inputs needed to issue the existing ac_sess cookie.
CREATE OR REPLACE FUNCTION public.consume_admin_command_device_grant(
  p_device_hash text
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
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
  v_grant public.admin_command_login_grants%ROWTYPE;
BEGIN
  IF p_device_hash IS NULL OR p_device_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'unpaired'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT v.* INTO v_ver
    FROM public.app_user_telegram_verifications AS v
   WHERE v.admin_device_hash = p_device_hash
     AND v.telegram_verified_at IS NOT NULL
     AND v.telegram_user_id IS NOT NULL
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unpaired'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT au.* INTO v_user
    FROM public.app_users AS au
   WHERE au.id = v_ver.user_id
     AND lower(au.username) = 'budi'
     AND au.is_blocked IS DISTINCT FROM TRUE
     AND au.is_approved IS TRUE
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  UPDATE public.admin_command_login_grants AS g
     SET state = 'expired', updated_at = now()
   WHERE g.user_id = v_user.id
     AND g.state = 'pending'
     AND g.expires_at <= now();

  SELECT g.* INTO v_grant
    FROM public.admin_command_login_grants AS g
   WHERE g.user_id = v_user.id
     AND g.telegram_user_id = v_ver.telegram_user_id
     AND g.target = 'device'
     AND g.device_hash = p_device_hash
     AND g.state = 'pending'
     AND g.expires_at > now()
   ORDER BY g.created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Recheck the exact device binding after the grant row lock. If the admin
  -- paired a new laptop in the meantime, the old device cannot consume.
  IF NOT EXISTS (
    SELECT 1
      FROM public.app_user_telegram_verifications AS v
     WHERE v.user_id = v_user.id
       AND v.telegram_user_id = v_grant.telegram_user_id
       AND v.telegram_verified_at IS NOT NULL
       AND v.admin_device_hash = p_device_hash
  ) THEN
    RETURN QUERY SELECT 'unpaired'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  UPDATE public.admin_command_login_grants AS g
     SET state = 'consumed', consumed_at = now(), updated_at = now()
   WHERE g.id = v_grant.id;

  RETURN QUERY SELECT 'ok'::text, v_user.id, v_user.username;
END
$$;

REVOKE ALL ON public.admin_command_login_grants FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.get_admin_command_login_context(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_admin_command_login_grant(bigint,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_admin_command_login_token(text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_admin_command_device_grant(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_admin_command_login_context(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_admin_command_login_grant(bigint,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_admin_command_login_token(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_admin_command_device_grant(text) TO service_role;
