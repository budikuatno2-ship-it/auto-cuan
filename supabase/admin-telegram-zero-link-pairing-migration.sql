-- =========================================================================
-- Auto-Cuan zero-link first pairing for Telegram /akses -> Laptop.
--
-- The already-open /dashboard maintenance tab creates a short-lived pairing
-- request using a random HttpOnly browser secret. PostgreSQL stores only the
-- SHA-256 hash. The verified admin's Telegram approves the exact request_ref;
-- the same browser then consumes the approval through polling, binds its random
-- device secret, receives the existing signed ac_sess, and logs in automatically.
--
-- No public browser can send Telegram messages or approve itself. If more than
-- one live browser pairing request exists, Telegram approval fails closed.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.admin_command_pair_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_ref           text NOT NULL UNIQUE,
  pair_hash             text NOT NULL UNIQUE,
  display_tag           text NOT NULL,
  device_label          text NOT NULL,
  requester_ip_hash     text,
  user_id               uuid REFERENCES public.app_users(id) ON DELETE CASCADE,
  telegram_user_id      bigint,
  state                  text NOT NULL DEFAULT 'pending'
                           CHECK (state IN ('pending','approved','consumed','expired')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  approved_at            timestamptz,
  consumed_at            timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_command_pair_request_ref_shape
    CHECK (request_ref ~ '^[A-Za-z0-9_-]{20,60}$'),
  CONSTRAINT admin_command_pair_hash_shape
    CHECK (pair_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT admin_command_pair_display_tag_shape
    CHECK (display_tag ~ '^[A-Z0-9]{6}$'),
  CONSTRAINT admin_command_pair_ip_hash_shape
    CHECK (requester_ip_hash IS NULL OR requester_ip_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_admin_command_pair_live
  ON public.admin_command_pair_requests (created_at DESC)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_admin_command_pair_expiry
  ON public.admin_command_pair_requests (expires_at)
  WHERE state IN ('pending','approved');

CREATE INDEX IF NOT EXISTS idx_admin_command_pair_ip_rate
  ON public.admin_command_pair_requests (requester_ip_hash, created_at DESC)
  WHERE requester_ip_hash IS NOT NULL;

ALTER TABLE public.admin_command_pair_requests ENABLE ROW LEVEL SECURITY;

-- Browser-side register/poll/consume RPC. This is called only by the server-side
-- reset-password Vercel function; anon/authenticated never receive EXECUTE.
CREATE OR REPLACE FUNCTION public.poll_admin_command_pair_request(
  p_pair_hash text,
  p_request_ref text,
  p_display_tag text,
  p_device_label text,
  p_requester_ip_hash text,
  p_new_device_hash text,
  p_expires_at timestamptz
)
RETURNS TABLE (
  result_code text,
  user_id uuid,
  username text,
  request_ref text,
  display_tag text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pair public.admin_command_pair_requests%ROWTYPE;
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
  v_label text;
BEGIN
  IF p_pair_hash IS NULL OR p_pair_hash !~ '^[0-9a-f]{64}$'
     OR p_request_ref IS NULL OR p_request_ref !~ '^[A-Za-z0-9_-]{20,60}$'
     OR p_display_tag IS NULL OR p_display_tag !~ '^[A-Z0-9]{6}$'
     OR p_new_device_hash IS NULL OR p_new_device_hash !~ '^[0-9a-f]{64}$'
     OR (p_requester_ip_hash IS NOT NULL AND p_requester_ip_hash !~ '^[0-9a-f]{64}$') THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF p_expires_at <= now() OR p_expires_at > now() + interval '3 minutes' THEN
    RETURN QUERY SELECT 'invalid_expiry'::text, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  v_label := left(coalesce(nullif(trim(p_device_label), ''), 'Laptop utama'), 80);

  UPDATE public.admin_command_pair_requests AS pr
     SET state = 'expired', updated_at = now()
   WHERE pr.state IN ('pending','approved')
     AND pr.expires_at <= now();

  SELECT pr.* INTO v_pair
    FROM public.admin_command_pair_requests AS pr
   WHERE pr.pair_hash = p_pair_hash
   FOR UPDATE;

  IF FOUND THEN
    IF v_pair.state = 'approved' AND v_pair.expires_at > now() THEN
      SELECT au.* INTO v_user
        FROM public.app_users AS au
       WHERE au.id = v_pair.user_id
         AND lower(au.username) = 'budi'
         AND au.is_blocked IS DISTINCT FROM TRUE
         AND au.is_approved IS TRUE
       FOR UPDATE;

      IF NOT FOUND THEN
        UPDATE public.admin_command_pair_requests AS pr
           SET state = 'expired', updated_at = now()
         WHERE pr.id = v_pair.id;
        RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::text, v_pair.request_ref, v_pair.display_tag;
        RETURN;
      END IF;

      SELECT v.* INTO v_ver
        FROM public.app_user_telegram_verifications AS v
       WHERE v.user_id = v_user.id
         AND v.telegram_user_id = v_pair.telegram_user_id
         AND v.telegram_verified_at IS NOT NULL
         AND v.telegram_private_chat_id IS NOT NULL
       FOR UPDATE;

      IF NOT FOUND THEN
        UPDATE public.admin_command_pair_requests AS pr
           SET state = 'expired', updated_at = now()
         WHERE pr.id = v_pair.id;
        RETURN QUERY SELECT 'identity_revoked'::text, NULL::uuid, NULL::text, v_pair.request_ref, v_pair.display_tag;
        RETURN;
      END IF;

      UPDATE public.app_user_telegram_verifications AS v
         SET admin_device_hash = p_new_device_hash,
             admin_device_label = v_label,
             admin_device_bound_at = now()
       WHERE v.user_id = v_user.id
         AND v.telegram_user_id = v_pair.telegram_user_id;

      UPDATE public.admin_command_login_grants AS g
         SET state = 'expired', updated_at = now()
       WHERE g.user_id = v_user.id
         AND g.state = 'pending'
         AND g.target = 'device';

      UPDATE public.admin_command_pair_requests AS pr
         SET state = 'consumed', consumed_at = now(), updated_at = now()
       WHERE pr.id = v_pair.id;

      RETURN QUERY SELECT 'ok'::text, v_user.id, v_user.username, v_pair.request_ref, v_pair.display_tag;
      RETURN;
    END IF;

    IF v_pair.state = 'pending' AND v_pair.expires_at > now() THEN
      RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::text, v_pair.request_ref, v_pair.display_tag;
      RETURN;
    END IF;

    -- Recycle the same short-lived browser secret after an expired/consumed row
    -- rather than creating unbounded rows for one browser cookie.
    UPDATE public.admin_command_pair_requests AS pr
       SET request_ref = p_request_ref,
           display_tag = p_display_tag,
           device_label = v_label,
           requester_ip_hash = p_requester_ip_hash,
           user_id = NULL,
           telegram_user_id = NULL,
           state = 'pending',
           created_at = now(),
           expires_at = p_expires_at,
           approved_at = NULL,
           consumed_at = NULL,
           updated_at = now()
     WHERE pr.id = v_pair.id
     RETURNING * INTO v_pair;

    RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::text, v_pair.request_ref, v_pair.display_tag;
    RETURN;
  END IF;

  IF p_requester_ip_hash IS NOT NULL AND (
    SELECT count(*)
      FROM public.admin_command_pair_requests AS pr
     WHERE pr.requester_ip_hash = p_requester_ip_hash
       AND pr.created_at > now() - interval '5 minutes'
  ) >= 5 THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF (
    SELECT count(*)
      FROM public.admin_command_pair_requests AS pr
     WHERE pr.created_at > now() - interval '5 minutes'
  ) >= 100 THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  INSERT INTO public.admin_command_pair_requests (
    request_ref, pair_hash, display_tag, device_label, requester_ip_hash,
    state, created_at, expires_at, updated_at
  ) VALUES (
    p_request_ref, p_pair_hash, p_display_tag, v_label, p_requester_ip_hash,
    'pending', now(), p_expires_at, now()
  ) RETURNING * INTO v_pair;

  DELETE FROM public.admin_command_pair_requests AS pr
   WHERE pr.state IN ('consumed','expired')
     AND pr.updated_at < now() - interval '1 day';

  RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::text, v_pair.request_ref, v_pair.display_tag;
END
$$;

-- Telegram-side candidate lookup. Exactly one live browser request is required;
-- multiple requests fail closed instead of guessing which browser is the admin's.
CREATE OR REPLACE FUNCTION public.get_admin_command_pair_candidate(
  p_telegram_user_id bigint
)
RETURNS TABLE (
  result_code text,
  request_ref text,
  display_tag text,
  device_label text,
  candidate_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
  v_pair public.admin_command_pair_requests%ROWTYPE;
  v_count integer;
BEGIN
  SELECT au.* INTO v_user
    FROM public.app_users AS au
   WHERE lower(au.username) = 'budi'
     AND au.is_blocked IS DISTINCT FROM TRUE
     AND au.is_approved IS TRUE
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::text, NULL::text, NULL::text, 0;
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
    RETURN QUERY SELECT 'identity_mismatch'::text, NULL::text, NULL::text, NULL::text, 0;
    RETURN;
  END IF;

  UPDATE public.admin_command_pair_requests AS pr
     SET state = 'expired', updated_at = now()
   WHERE pr.state IN ('pending','approved')
     AND pr.expires_at <= now();

  SELECT count(*)::integer INTO v_count
    FROM public.admin_command_pair_requests AS pr
   WHERE pr.state = 'pending'
     AND pr.expires_at > now();

  IF v_count = 0 THEN
    RETURN QUERY SELECT 'none'::text, NULL::text, NULL::text, NULL::text, 0;
    RETURN;
  END IF;

  IF v_count <> 1 THEN
    RETURN QUERY SELECT 'ambiguous'::text, NULL::text, NULL::text, NULL::text, v_count;
    RETURN;
  END IF;

  SELECT pr.* INTO v_pair
    FROM public.admin_command_pair_requests AS pr
   WHERE pr.state = 'pending'
     AND pr.expires_at > now()
   ORDER BY pr.created_at DESC
   LIMIT 1;

  RETURN QUERY SELECT 'ok'::text, v_pair.request_ref, v_pair.display_tag, v_pair.device_label, 1;
END
$$;

-- Telegram callback approves the exact browser request shown in the /akses menu.
-- The candidate-count recheck closes the race where another browser registers
-- after the menu was rendered but before the admin taps the button.
CREATE OR REPLACE FUNCTION public.approve_admin_command_pair_request(
  p_telegram_user_id bigint,
  p_request_ref text
)
RETURNS TABLE (
  result_code text,
  request_ref text,
  display_tag text,
  device_label text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
  v_pair public.admin_command_pair_requests%ROWTYPE;
  v_count integer;
BEGIN
  IF p_request_ref IS NULL OR p_request_ref !~ '^[A-Za-z0-9_-]{20,60}$' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT au.* INTO v_user
    FROM public.app_users AS au
   WHERE lower(au.username) = 'budi'
     AND au.is_blocked IS DISTINCT FROM TRUE
     AND au.is_approved IS TRUE
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::text, NULL::text, NULL::text;
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
    RETURN QUERY SELECT 'identity_mismatch'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.admin_command_pair_requests AS pr
     SET state = 'expired', updated_at = now()
   WHERE pr.state IN ('pending','approved')
     AND pr.expires_at <= now();

  SELECT count(*)::integer INTO v_count
    FROM public.admin_command_pair_requests AS pr
   WHERE pr.state = 'pending'
     AND pr.expires_at > now();

  IF v_count = 0 THEN
    RETURN QUERY SELECT 'none'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_count <> 1 THEN
    RETURN QUERY SELECT 'ambiguous'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT pr.* INTO v_pair
    FROM public.admin_command_pair_requests AS pr
   WHERE pr.request_ref = p_request_ref
     AND pr.state = 'pending'
     AND pr.expires_at > now()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'stale'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.admin_command_pair_requests AS pr
     SET user_id = v_user.id,
         telegram_user_id = p_telegram_user_id,
         state = 'approved',
         approved_at = now(),
         updated_at = now()
   WHERE pr.id = v_pair.id
   RETURNING * INTO v_pair;

  RETURN QUERY SELECT 'ok'::text, v_pair.request_ref, v_pair.display_tag, v_pair.device_label;
END
$$;

REVOKE ALL ON public.admin_command_pair_requests FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.poll_admin_command_pair_request(text,text,text,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_admin_command_pair_candidate(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_admin_command_pair_request(bigint,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.poll_admin_command_pair_request(text,text,text,text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_command_pair_candidate(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_admin_command_pair_request(bigint,text) TO service_role;
