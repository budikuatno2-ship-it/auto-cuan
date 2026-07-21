-- =========================================================================
-- Telegram verification v2 — additive migration (UUID-based).
--
-- SAFETY / SCOPE
-- - Additive ONLY. Creates four new tables and their functions. It performs no
--   ALTER/DROP on app_users or any existing table/index.
-- - app_users.id is uuid (PK, gen_random_uuid()). Every FK below is uuid.
-- - All new tables have RLS enabled with NO anon/authenticated policies, so only
--   the service_role (which bypasses RLS) can read/write them.
-- - Every function is SECURITY DEFINER with a fixed, non-hijackable search_path
--   (pg_catalog, public), fully schema-qualified, owned by postgres, and granted
--   EXECUTE to service_role only.
-- - No raw verification code, bot token, or full Telegram payload is ever stored.
--   Only a keyed HMAC of the code, coarse outcome codes, and sanitized errors.
--
-- This file is a migration DRAFT for review. Do NOT rely on it being applied by
-- the application; it must be run intentionally by an operator against the
-- target database.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Table A: permanent binding + dynamic invite bookkeeping + notification outbox
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_user_telegram_verifications (
  user_id                        uuid PRIMARY KEY
                                   REFERENCES public.app_users(id) ON DELETE CASCADE,
  telegram_user_id               bigint,
  telegram_private_chat_id       bigint,
  telegram_verified_at           timestamptz,
  channel_joined_at              timestamptz,

  -- Dynamic per-user invite (only what revocation needs; cleared after revoke)
  dynamic_invite_link            text,
  invite_expires_at              timestamptz,
  invite_revoked_at              timestamptz,

  -- message_id of the private approval ("Ajukan Bergabung") message, so a later
  -- chat_join_request can edit that exact message and remove its used button.
  invite_message_id              bigint,

  -- Member-lifecycle fields (fresh-install parity with
  -- supabase/telegram-member-lifecycle-hotfix.sql). All additive/nullable.
  --  * 30-day rating: one request, one stored score (constrained 1..5).
  --  * legacy verification reminders: at most two, second at least 24h later.
  review_requested_at            timestamptz,
  review_submitted_at            timestamptz,
  review_score                   integer CHECK (review_score IS NULL OR (review_score >= 1 AND review_score <= 5)),
  verification_reminder_count    integer NOT NULL DEFAULT 0,
  verification_reminded_at       timestamptz,

  -- Durable admin-notification outbox (token-owned lease)
  admin_notification_status      text NOT NULL DEFAULT 'pending'
                                   CHECK (admin_notification_status IN ('pending','claimed','sent','failed')),
  admin_notification_claim_token uuid,
  admin_notification_claimed_at  timestamptz,
  admin_notification_attempts    integer NOT NULL DEFAULT 0,
  admin_notification_last_error  text,
  admin_notification_sent_at     timestamptz,

  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

-- One web user <-> at most one Telegram identity (PK gives one row per user;
-- this partial-unique guarantees one web user per Telegram id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_autv_telegram_user_id
  ON public.app_user_telegram_verifications (telegram_user_id)
  WHERE telegram_user_id IS NOT NULL;

-- Notification retry lookup.
CREATE INDEX IF NOT EXISTS idx_autv_notify_retry
  ON public.app_user_telegram_verifications (admin_notification_status)
  WHERE admin_notification_status IN ('pending','failed','claimed');

-- -------------------------------------------------------------------------
-- Table B: ephemeral one-time challenges
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_user_telegram_challenges (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  verification_code_hash text NOT NULL,
  expires_at             timestamptz NOT NULL,
  used_at                timestamptz,
  revoked_at             timestamptz,
  failed_attempts        integer NOT NULL DEFAULT 0,
  locked_until           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- At most one ACTIVE challenge per user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_autc_one_active_per_user
  ON public.app_user_telegram_challenges (user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- A live code hash resolves to AT MOST ONE user (no ambiguous resolution).
CREATE UNIQUE INDEX IF NOT EXISTS uq_autc_active_hash
  ON public.app_user_telegram_challenges (verification_code_hash)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_autc_user_id    ON public.app_user_telegram_challenges (user_id);
CREATE INDEX IF NOT EXISTS idx_autc_expires_at ON public.app_user_telegram_challenges (expires_at);

-- -------------------------------------------------------------------------
-- Table C: webhook dedupe + lease (processing_token ownership)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telegram_verify_webhook_updates (
  update_id              bigint PRIMARY KEY,
  processing_token       uuid,
  processing_started_at  timestamptz,
  processing_lease_until timestamptz,
  processed_at           timestamptz,
  outcome_code           text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tvwu_lease_recovery
  ON public.telegram_verify_webhook_updates (processing_lease_until)
  WHERE processed_at IS NULL;

-- -------------------------------------------------------------------------
-- Table D: per-sender rate limiter (unattributable/invalid code guesses)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telegram_verify_sender_limits (
  telegram_user_id  bigint PRIMARY KEY,
  failed_attempts   integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tvsl_locked_until
  ON public.telegram_verify_sender_limits (locked_until)
  WHERE locked_until IS NOT NULL;

-- -------------------------------------------------------------------------
-- RLS: enable on every new table, add NO policies -> service_role only.
-- -------------------------------------------------------------------------
ALTER TABLE public.app_user_telegram_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_user_telegram_challenges    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_verify_webhook_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_verify_sender_limits   ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- FUNCTIONS / RPCs
-- =========================================================================

-- 1) Atomic pending registration + first challenge.
--    Preserves the EXACT current app_users shape: device_id text (Node-normalized),
--    devices = jsonb array containing the single device_id string, user_agent ''
--    default, is_blocked=false, is_approved=false, created_at left to column default.
CREATE OR REPLACE FUNCTION public.register_pending_user_with_telegram_challenge(
  p_username text, p_password_hash text, p_device_id text,
  p_user_agent text, p_code_hash text, p_expires_at timestamptz)
RETURNS TABLE (id uuid, username text, created_at timestamptz, challenge_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid; v_created timestamptz; v_cid uuid;
BEGIN
  INSERT INTO public.app_users
    (username, password_hash, device_id, devices, user_agent, is_blocked, is_approved)
  VALUES
    (p_username, p_password_hash, p_device_id,
     jsonb_build_array(p_device_id), coalesce(p_user_agent, ''), false, false)
  RETURNING app_users.id, app_users.created_at INTO v_id, v_created;

  INSERT INTO public.app_user_telegram_challenges (user_id, verification_code_hash, expires_at)
  VALUES (v_id, p_code_hash, p_expires_at)
  RETURNING app_user_telegram_challenges.id INTO v_cid;

  RETURN QUERY SELECT v_id, p_username, v_created, v_cid;
END $$;

-- 2) Atomic challenge (re)issuance with per-user advisory lock. Enforces pending
--    eligibility; returns zero rows when the account is not an eligible pending user.
CREATE OR REPLACE FUNCTION public.issue_telegram_challenge(
  p_user_id uuid, p_code_hash text, p_expires_at timestamptz)
RETURNS TABLE (challenge_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_ok boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('tgverify:'||p_user_id::text, 0));

  SELECT (u.is_approved = false AND u.is_blocked = false
          AND lower(u.username) NOT IN ('budi','review'))
    INTO v_ok
    FROM public.app_users u WHERE u.id = p_user_id;

  IF v_ok IS NOT TRUE THEN RETURN; END IF;   -- ineligible -> zero rows

  UPDATE public.app_user_telegram_challenges
     SET revoked_at = now(), updated_at = now()
   WHERE user_id = p_user_id AND used_at IS NULL AND revoked_at IS NULL;

  RETURN QUERY
  INSERT INTO public.app_user_telegram_challenges (user_id, verification_code_hash, expires_at)
  VALUES (p_user_id, p_code_hash, p_expires_at)
  RETURNING app_user_telegram_challenges.id, app_user_telegram_challenges.expires_at;
END $$;

-- 3) Consume one live challenge and bind the Telegram identity (concurrency-safe).
--    Active-only lookup (used_at IS NULL AND revoked_at IS NULL) guarded by
--    uq_autc_active_hash so a code resolves to at most one user. Enforces pending
--    eligibility at consume time. Generic 'not_found' avoids account disclosure.
CREATE OR REPLACE FUNCTION public.consume_challenge_and_bind_telegram(
  p_code_hash text, p_telegram_user_id bigint, p_private_chat_id bigint)
RETURNS TABLE (result_code text, user_id uuid, username text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_ch public.app_user_telegram_challenges%ROWTYPE;
        v_appr boolean; v_blk boolean; v_uname text; v_rc int;
BEGIN
  SELECT c.* INTO v_ch
    FROM public.app_user_telegram_challenges c
   WHERE c.verification_code_hash = p_code_hash
     AND c.used_at IS NULL
     AND c.revoked_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text; RETURN; END IF;

  IF v_ch.locked_until IS NOT NULL AND v_ch.locked_until > now()
     THEN RETURN QUERY SELECT 'locked'::text,  NULL::uuid, NULL::text; RETURN; END IF;
  IF v_ch.expires_at <= now()
     THEN RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::text; RETURN; END IF;

  SELECT u.is_approved, u.is_blocked, u.username
    INTO v_appr, v_blk, v_uname
    FROM public.app_users u WHERE u.id = v_ch.user_id;
  IF v_appr IS DISTINCT FROM false OR v_blk IS DISTINCT FROM false
     OR lower(v_uname) IN ('budi','review') THEN
     RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text; RETURN;  -- generic, no disclosure
  END IF;

  -- One Telegram identity cannot claim a DIFFERENT web account.
  -- NOTE: columns are aliased/qualified (av.*) so they are never ambiguous with
  -- this function's OUT parameters (result_code, user_id, username). An earlier
  -- build raised "column reference \"user_id\" is ambiguous" here; the alias fixes it.
  IF EXISTS (SELECT 1 FROM public.app_user_telegram_verifications av
              WHERE av.telegram_user_id = p_telegram_user_id AND av.user_id <> v_ch.user_id) THEN
    UPDATE public.app_user_telegram_challenges
       SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END,
           updated_at = now()
     WHERE id = v_ch.id;
    RETURN QUERY SELECT 'telegram_used_elsewhere'::text, NULL::uuid, NULL::text; RETURN;
  END IF;

  BEGIN
    INSERT INTO public.app_user_telegram_verifications
      (user_id, telegram_user_id, telegram_private_chat_id, telegram_verified_at, created_at, updated_at)
    VALUES (v_ch.user_id, p_telegram_user_id, p_private_chat_id, now(), now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET telegram_user_id = EXCLUDED.telegram_user_id,
          telegram_private_chat_id = EXCLUDED.telegram_private_chat_id,
          telegram_verified_at = COALESCE(public.app_user_telegram_verifications.telegram_verified_at, EXCLUDED.telegram_verified_at),
          updated_at = now()
      WHERE public.app_user_telegram_verifications.telegram_user_id IS NULL
         OR public.app_user_telegram_verifications.telegram_user_id = EXCLUDED.telegram_user_id;
  EXCEPTION WHEN unique_violation THEN            -- raced on uq_autv_telegram_user_id
    RETURN QUERY SELECT 'telegram_used_elsewhere'::text, NULL::uuid, NULL::text; RETURN;
  END;

  GET DIAGNOSTICS v_rc = ROW_COUNT;
  IF v_rc = 0 THEN                                -- web account already bound to another Telegram id
    UPDATE public.app_user_telegram_challenges
       SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END,
           updated_at = now()
     WHERE id = v_ch.id;
    RETURN QUERY SELECT 'bound_other_telegram'::text, NULL::uuid, NULL::text; RETURN;
  END IF;

  UPDATE public.app_user_telegram_challenges
     SET used_at = now(), updated_at = now() WHERE id = v_ch.id;

  RETURN QUERY SELECT 'ok'::text, v_ch.user_id, v_uname;
END $$;

-- 4) Read the current sender lock (callable BEFORE hashing a submitted code).
CREATE OR REPLACE FUNCTION public.check_telegram_sender_limit(p_telegram_user_id bigint)
RETURNS TABLE (locked boolean, locked_until timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT (s.locked_until IS NOT NULL AND s.locked_until > now()), s.locked_until
    FROM public.telegram_verify_sender_limits s
   WHERE s.telegram_user_id = p_telegram_user_id
  UNION ALL
  SELECT false, NULL::timestamptz
   WHERE NOT EXISTS (SELECT 1 FROM public.telegram_verify_sender_limits
                      WHERE telegram_user_id = p_telegram_user_id)
  LIMIT 1;
$$;

-- 5) Record an invalid attempt for a sender (rolling window + lock at threshold).
CREATE OR REPLACE FUNCTION public.record_invalid_telegram_attempt(
  p_telegram_user_id bigint, p_max_attempts integer,
  p_window_seconds integer, p_lock_seconds integer)
RETURNS TABLE (locked boolean, locked_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.telegram_verify_sender_limits%ROWTYPE;
        v_win int := least(greatest(coalesce(p_window_seconds,900),60),3600);
        v_lock int := least(greatest(coalesce(p_lock_seconds,900),60),3600);
        v_max int := least(greatest(coalesce(p_max_attempts,5),1),20);
BEGIN
  INSERT INTO public.telegram_verify_sender_limits (telegram_user_id, failed_attempts, window_started_at)
  VALUES (p_telegram_user_id, 0, now())
  ON CONFLICT (telegram_user_id) DO NOTHING;

  SELECT * INTO v FROM public.telegram_verify_sender_limits
   WHERE telegram_user_id = p_telegram_user_id FOR UPDATE;

  IF v.window_started_at < now() - make_interval(secs => v_win) THEN
    v.failed_attempts := 0; v.window_started_at := now();
  END IF;
  v.failed_attempts := v.failed_attempts + 1;
  IF v.failed_attempts >= v_max THEN v.locked_until := now() + make_interval(secs => v_lock); END IF;

  UPDATE public.telegram_verify_sender_limits
     SET failed_attempts = v.failed_attempts, window_started_at = v.window_started_at,
         locked_until = v.locked_until, updated_at = now()
   WHERE telegram_user_id = p_telegram_user_id;

  RETURN QUERY SELECT (v.locked_until IS NOT NULL AND v.locked_until > now()), v.locked_until;
END $$;

-- 6) Clear the sender limiter after a successful verification.
CREATE OR REPLACE FUNCTION public.clear_telegram_sender_limit(p_telegram_user_id bigint)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM public.telegram_verify_sender_limits WHERE telegram_user_id = p_telegram_user_id;
$$;

-- 7) Claim/reclaim a webhook update. Rotates processing_token on (re)claim so a
--    stale worker cannot complete a reclaimed update. Lease clamped to [10,60]s.
CREATE OR REPLACE FUNCTION public.claim_telegram_webhook_update(
  p_update_id bigint, p_lease_seconds integer)
RETURNS TABLE (claim_state text, processing_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_lease int := least(greatest(coalesce(p_lease_seconds,30),10),60);
        v_tok uuid := gen_random_uuid();
        v_row public.telegram_verify_webhook_updates%ROWTYPE; v_ins bigint; v_rc int;
BEGIN
  INSERT INTO public.telegram_verify_webhook_updates
    (update_id, processing_token, processing_started_at, processing_lease_until)
  VALUES (p_update_id, v_tok, now(), now() + make_interval(secs => v_lease))
  ON CONFLICT (update_id) DO NOTHING
  RETURNING update_id INTO v_ins;
  IF v_ins IS NOT NULL THEN RETURN QUERY SELECT 'claimed'::text, v_tok; RETURN; END IF;

  SELECT * INTO v_row FROM public.telegram_verify_webhook_updates WHERE update_id = p_update_id;
  IF v_row.processed_at IS NOT NULL THEN RETURN QUERY SELECT 'already_processed'::text, NULL::uuid; RETURN; END IF;
  IF v_row.processing_lease_until > now() THEN RETURN QUERY SELECT 'lease_active'::text, NULL::uuid; RETURN; END IF;

  UPDATE public.telegram_verify_webhook_updates
     SET processing_token = v_tok, processing_started_at = now(),
         processing_lease_until = now() + make_interval(secs => v_lease)
   WHERE update_id = p_update_id AND processed_at IS NULL AND processing_lease_until <= now();
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  IF v_rc = 1 THEN RETURN QUERY SELECT 'reclaimed'::text, v_tok;
  ELSE            RETURN QUERY SELECT 'lease_active'::text, NULL::uuid; END IF;
END $$;

-- 8) Finalize a processed update. Requires the matching processing_token.
CREATE OR REPLACE FUNCTION public.complete_telegram_webhook_update(
  p_update_id bigint, p_processing_token uuid, p_outcome_code text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_rc int;
BEGIN
  UPDATE public.telegram_verify_webhook_updates
     SET processed_at = now(), outcome_code = left(p_outcome_code, 64), processing_lease_until = NULL
   WHERE update_id = p_update_id
     AND processing_token = p_processing_token
     AND processed_at IS NULL;
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  RETURN v_rc = 1;
END $$;

-- 9) Idempotently confirm channel join. Resolves purely by telegram_user_id and
--    enforces verified + pending + not budi/review.
CREATE OR REPLACE FUNCTION public.confirm_channel_join(p_telegram_user_id bigint)
RETURNS TABLE (outcome text, user_id uuid, admin_notification_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.app_user_telegram_verifications%ROWTYPE; v_appr boolean; v_blk boolean; v_uname text;
BEGIN
  SELECT * INTO v FROM public.app_user_telegram_verifications
   WHERE telegram_user_id = p_telegram_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text; RETURN; END IF;
  IF v.telegram_verified_at IS NULL THEN RETURN QUERY SELECT 'not_verified'::text, NULL::uuid, NULL::text; RETURN; END IF;

  SELECT u.is_approved, u.is_blocked, u.username INTO v_appr, v_blk, v_uname
    FROM public.app_users u WHERE u.id = v.user_id;
  IF v_appr IS DISTINCT FROM false OR v_blk IS DISTINCT FROM false
     OR lower(v_uname) IN ('budi','review') THEN
     RETURN QUERY SELECT 'ineligible'::text, NULL::uuid, NULL::text; RETURN;
  END IF;

  IF v.channel_joined_at IS NOT NULL THEN
     RETURN QUERY SELECT 'already_joined'::text, v.user_id, v.admin_notification_status; RETURN;
  END IF;

  UPDATE public.app_user_telegram_verifications
     SET channel_joined_at = now(),
         admin_notification_status = CASE WHEN admin_notification_status='sent'
                                          THEN admin_notification_status ELSE 'pending' END,
         updated_at = now()
   WHERE user_id = v.user_id;
  RETURN QUERY SELECT 'joined_now'::text, v.user_id, 'pending'::text;
END $$;

-- 10) Claim admin-notification work (token-owned lease). Never claims 'sent'.
CREATE OR REPLACE FUNCTION public.claim_admin_notification(
  p_user_id uuid, p_lease_seconds integer)
RETURNS TABLE (claim_token uuid, user_id uuid, event_ref text, telegram_user_id bigint, username text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_lease int := least(greatest(coalesce(p_lease_seconds,120),30),300);
        v_tok uuid := gen_random_uuid(); v_rc int;
BEGIN
  UPDATE public.app_user_telegram_verifications
     SET admin_notification_status = 'claimed',
         admin_notification_claim_token = v_tok,
         admin_notification_claimed_at = now(),
         admin_notification_attempts = admin_notification_attempts + 1,
         updated_at = now()
   WHERE app_user_telegram_verifications.user_id = p_user_id
     AND channel_joined_at IS NOT NULL
     AND ( admin_notification_status IN ('pending','failed')
        OR (admin_notification_status = 'claimed'
            AND admin_notification_claimed_at < now() - make_interval(secs => v_lease)) );
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  IF v_rc <> 1 THEN RETURN; END IF;

  RETURN QUERY
  SELECT v_tok, v.user_id,
         'VF-'||v.user_id::text||'-'||extract(epoch FROM v.channel_joined_at)::bigint::text,
         v.telegram_user_id, u.username
    FROM public.app_user_telegram_verifications v
    JOIN public.app_users u ON u.id = v.user_id
   WHERE v.user_id = p_user_id;
END $$;

-- 11) Mark notification sent (only after Telegram confirms). Requires claim token.
CREATE OR REPLACE FUNCTION public.complete_admin_notification(
  p_user_id uuid, p_claim_token uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_rc int;
BEGIN
  UPDATE public.app_user_telegram_verifications
     SET admin_notification_status = 'sent', admin_notification_sent_at = now(), updated_at = now()
   WHERE user_id = p_user_id
     AND admin_notification_claim_token = p_claim_token
     AND admin_notification_status = 'claimed';
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  RETURN v_rc = 1;
END $$;

-- 12) Mark notification failed (sanitized code only). Requires claim token.
CREATE OR REPLACE FUNCTION public.fail_admin_notification(
  p_user_id uuid, p_claim_token uuid, p_error_code text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_rc int;
BEGIN
  UPDATE public.app_user_telegram_verifications
     SET admin_notification_status = 'failed',
         admin_notification_last_error = left(coalesce(p_error_code,'unknown'),120),
         updated_at = now()
   WHERE user_id = p_user_id
     AND admin_notification_claim_token = p_claim_token
     AND admin_notification_status = 'claimed';
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  RETURN v_rc = 1;
END $$;

-- 13) Persist dynamic invite info.
CREATE OR REPLACE FUNCTION public.save_dynamic_invite_link(
  p_user_id uuid, p_invite_link text, p_expires_at timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.app_user_telegram_verifications
     SET dynamic_invite_link = p_invite_link, invite_expires_at = p_expires_at,
         invite_revoked_at = NULL, updated_at = now()
   WHERE user_id = p_user_id;
END $$;

-- 14) Idempotently record invite revocation/expiry and clear the stored URL.
CREATE OR REPLACE FUNCTION public.revoke_or_expire_dynamic_invite(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.app_user_telegram_verifications
     SET invite_revoked_at = COALESCE(invite_revoked_at, now()),
         dynamic_invite_link = NULL,
         updated_at = now()
   WHERE user_id = p_user_id;
END $$;

-- 15) Persist the message_id of the private approval ("Ajukan Bergabung")
--     message so a later chat_join_request can edit that exact message and
--     remove its used join button.
CREATE OR REPLACE FUNCTION public.save_invite_message_id(
  p_user_id uuid, p_message_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.app_user_telegram_verifications
     SET invite_message_id = p_message_id, updated_at = now()
   WHERE user_id = p_user_id;
END $$;

-- 16) Clear the stored approval message_id once its button has been removed.
CREATE OR REPLACE FUNCTION public.clear_invite_message_id(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.app_user_telegram_verifications
     SET invite_message_id = NULL, updated_at = now()
   WHERE user_id = p_user_id;
END $$;

-- =========================================================================
-- GRANTS: lock every function to service_role only; owner postgres (DEFINER).
-- =========================================================================
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
   'public.register_pending_user_with_telegram_challenge(text,text,text,text,text,timestamptz)',
   'public.issue_telegram_challenge(uuid,text,timestamptz)',
   'public.consume_challenge_and_bind_telegram(text,bigint,bigint)',
   'public.check_telegram_sender_limit(bigint)',
   'public.record_invalid_telegram_attempt(bigint,integer,integer,integer)',
   'public.clear_telegram_sender_limit(bigint)',
   'public.claim_telegram_webhook_update(bigint,integer)',
   'public.complete_telegram_webhook_update(bigint,uuid,text)',
   'public.confirm_channel_join(bigint)',
   'public.claim_admin_notification(uuid,integer)',
   'public.complete_admin_notification(uuid,uuid)',
   'public.fail_admin_notification(uuid,uuid,text)',
   'public.save_dynamic_invite_link(uuid,text,timestamptz)',
   'public.revoke_or_expire_dynamic_invite(uuid)',
   'public.save_invite_message_id(uuid,bigint)',
   'public.clear_invite_message_id(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated;', fn);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO service_role;', fn);
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres;', fn);
  END LOOP;
END $$;

-- No table-level grants to anon/authenticated. service_role bypasses RLS.
REVOKE ALL ON public.app_user_telegram_verifications FROM anon, authenticated;
REVOKE ALL ON public.app_user_telegram_challenges    FROM anon, authenticated;
REVOKE ALL ON public.telegram_verify_webhook_updates FROM anon, authenticated;
REVOKE ALL ON public.telegram_verify_sender_limits   FROM anon, authenticated;
