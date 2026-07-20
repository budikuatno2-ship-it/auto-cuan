-- =========================================================================
-- Telegram verification v2 — APPROVAL-GATE HOTFIX (additive migration).
--
-- PURPOSE
--   Introduces the admin approval gate between Telegram verification and the
--   private channel invite:
--
--     Stage 2  user verifies code  -> Telegram identity bound, admin notified
--                                     immediately ("waiting for admin approval").
--     Stage 3  admin approves      -> a dynamic single-use invite is created and
--                                     delivered privately to the user.
--     Stage 4  user joins channel  -> membership confirmed (requires an APPROVED
--                                     account), invite revoked, admin notified.
--
-- SAFETY / SCOPE
--   - Additive ONLY. It adds columns (ADD COLUMN IF NOT EXISTS) to the existing
--     public.app_user_telegram_verifications table and adds/replaces functions.
--     It performs NO destructive ALTER/DROP on any table or column.
--   - THREE independent delivery-state groups are kept strictly separate so they
--     can never be confused:
--       (a) verify_notification_*  -> Stage 2 "user verified" admin notification
--       (b) invite_delivery_*      -> Stage 3 approval invite message to the user
--       (c) admin_notification_*   -> Stage 4 "user joined channel" admin note
--                                     (pre-existing columns; left untouched here)
--   - Every function is SECURITY DEFINER with a fixed, non-hijackable search_path
--     (pg_catalog, public), fully schema-qualified, owned by postgres, and granted
--     EXECUTE to service_role only (revoked from PUBLIC/anon/authenticated). RLS on
--     the underlying tables stays service-role-only.
--   - No raw code, bot token, or full Telegram payload is stored. Only token-owned
--     claim state, coarse timestamps, and sanitized (short) error codes.
--
-- This file is a migration DRAFT for review. Do NOT rely on it being applied by
-- the application; run it intentionally by an operator AFTER the base migration
-- (supabase/telegram-verification-v2-migration.sql).
-- =========================================================================

-- -------------------------------------------------------------------------
-- (a) Verification-notification outbox (Stage 2): "user is verified, waiting
--     for admin approval". Durable, token-owned, at-least-once.
-- -------------------------------------------------------------------------
ALTER TABLE public.app_user_telegram_verifications
  ADD COLUMN IF NOT EXISTS verify_notification_status text NOT NULL DEFAULT 'pending';

-- Enforce the allowed status set without failing if the constraint already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_autv_verify_notification_status'
  ) THEN
    ALTER TABLE public.app_user_telegram_verifications
      ADD CONSTRAINT chk_autv_verify_notification_status
      CHECK (verify_notification_status IN ('pending','claimed','sent','failed'));
  END IF;
END $$;

ALTER TABLE public.app_user_telegram_verifications
  ADD COLUMN IF NOT EXISTS verify_notification_claim_token uuid,
  ADD COLUMN IF NOT EXISTS verify_notification_claimed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS verify_notification_attempts    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verify_notification_last_error  text,
  ADD COLUMN IF NOT EXISTS verify_notification_sent_at     timestamptz;

CREATE INDEX IF NOT EXISTS idx_autv_verify_notify_retry
  ON public.app_user_telegram_verifications (verify_notification_status)
  WHERE verify_notification_status IN ('pending','failed','claimed');

-- -------------------------------------------------------------------------
-- (b) Approval invite-message delivery state (Stage 3): created + sent AFTER an
--     admin approves the account. Retryable, token-owned, at-least-once.
-- -------------------------------------------------------------------------
ALTER TABLE public.app_user_telegram_verifications
  ADD COLUMN IF NOT EXISTS invite_delivery_status text NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_autv_invite_delivery_status'
  ) THEN
    ALTER TABLE public.app_user_telegram_verifications
      ADD CONSTRAINT chk_autv_invite_delivery_status
      CHECK (invite_delivery_status IN ('pending','claimed','sent','failed'));
  END IF;
END $$;

ALTER TABLE public.app_user_telegram_verifications
  ADD COLUMN IF NOT EXISTS invite_delivery_claim_token uuid,
  ADD COLUMN IF NOT EXISTS invite_delivery_claimed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS invite_delivery_attempts    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invite_delivery_last_error  text,
  ADD COLUMN IF NOT EXISTS invite_delivery_sent_at     timestamptz;

CREATE INDEX IF NOT EXISTS idx_autv_invite_delivery_retry
  ON public.app_user_telegram_verifications (invite_delivery_status)
  WHERE invite_delivery_status IN ('pending','failed','claimed');

-- =========================================================================
-- FUNCTIONS / RPCs
-- =========================================================================

-- H1) Claim the Stage-2 verification-notification work (token-owned lease).
--     Claims only a VERIFIED account whose notification is pending/failed, or a
--     stale 'claimed' lease. Never claims 'sent' -> a repeated verification does
--     not notify the admin twice. Returns a deterministic, non-secret event_ref.
CREATE OR REPLACE FUNCTION public.claim_verify_notification(
  p_user_id uuid, p_lease_seconds integer)
RETURNS TABLE (claim_token uuid, out_user_id uuid, event_ref text,
               telegram_user_id bigint, telegram_private_chat_id bigint, username text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_lease int := least(greatest(coalesce(p_lease_seconds,120),30),300);
        v_tok uuid := gen_random_uuid(); v_rc int;
BEGIN
  UPDATE public.app_user_telegram_verifications av
     SET verify_notification_status = 'claimed',
         verify_notification_claim_token = v_tok,
         verify_notification_claimed_at = now(),
         verify_notification_attempts = av.verify_notification_attempts + 1,
         updated_at = now()
   WHERE av.user_id = p_user_id
     AND av.telegram_verified_at IS NOT NULL
     AND ( av.verify_notification_status IN ('pending','failed')
        OR (av.verify_notification_status = 'claimed'
            AND av.verify_notification_claimed_at < now() - make_interval(secs => v_lease)) );
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  IF v_rc <> 1 THEN RETURN; END IF;

  RETURN QUERY
  SELECT v_tok, av.user_id,
         'VN-'||av.user_id::text||'-'||extract(epoch FROM av.telegram_verified_at)::bigint::text,
         av.telegram_user_id, av.telegram_private_chat_id, u.username
    FROM public.app_user_telegram_verifications av
    JOIN public.app_users u ON u.id = av.user_id
   WHERE av.user_id = p_user_id;
END $$;

-- H2) Mark the Stage-2 verification notification sent. Requires the claim token.
CREATE OR REPLACE FUNCTION public.complete_verify_notification(
  p_user_id uuid, p_claim_token uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_rc int;
BEGIN
  UPDATE public.app_user_telegram_verifications av
     SET verify_notification_status = 'sent',
         verify_notification_sent_at = now(), updated_at = now()
   WHERE av.user_id = p_user_id
     AND av.verify_notification_claim_token = p_claim_token
     AND av.verify_notification_status = 'claimed';
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  RETURN v_rc = 1;
END $$;

-- H3) Mark the Stage-2 verification notification failed (sanitized code only).
CREATE OR REPLACE FUNCTION public.fail_verify_notification(
  p_user_id uuid, p_claim_token uuid, p_error_code text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_rc int;
BEGIN
  UPDATE public.app_user_telegram_verifications av
     SET verify_notification_status = 'failed',
         verify_notification_last_error = left(coalesce(p_error_code,'unknown'),120),
         updated_at = now()
   WHERE av.user_id = p_user_id
     AND av.verify_notification_claim_token = p_claim_token
     AND av.verify_notification_status = 'claimed';
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  RETURN v_rc = 1;
END $$;

-- H4) Claim the Stage-3 approval invite-delivery work (token-owned lease).
--     Only claims an APPROVED, verified account that has a bound private chat and
--     whose delivery is pending/failed (or a stale 'claimed' lease). This is the
--     safe retry primitive: a failed delivery stays claimable later.
CREATE OR REPLACE FUNCTION public.claim_invite_delivery(
  p_user_id uuid, p_lease_seconds integer)
RETURNS TABLE (claim_token uuid, out_user_id uuid, telegram_user_id bigint,
               telegram_private_chat_id bigint, username text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_lease int := least(greatest(coalesce(p_lease_seconds,120),30),300);
        v_tok uuid := gen_random_uuid(); v_rc int;
BEGIN
  UPDATE public.app_user_telegram_verifications av
     SET invite_delivery_status = 'claimed',
         invite_delivery_claim_token = v_tok,
         invite_delivery_claimed_at = now(),
         invite_delivery_attempts = av.invite_delivery_attempts + 1,
         updated_at = now()
   WHERE av.user_id = p_user_id
     AND av.telegram_verified_at IS NOT NULL
     AND av.telegram_private_chat_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.app_users u
                  WHERE u.id = av.user_id AND u.is_approved = true AND u.is_blocked = false)
     AND ( av.invite_delivery_status IN ('pending','failed')
        OR (av.invite_delivery_status = 'claimed'
            AND av.invite_delivery_claimed_at < now() - make_interval(secs => v_lease)) );
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  IF v_rc <> 1 THEN RETURN; END IF;

  RETURN QUERY
  SELECT v_tok, av.user_id, av.telegram_user_id, av.telegram_private_chat_id, u.username
    FROM public.app_user_telegram_verifications av
    JOIN public.app_users u ON u.id = av.user_id
   WHERE av.user_id = p_user_id;
END $$;

-- H5) Mark the Stage-3 invite delivery sent. Requires the claim token.
CREATE OR REPLACE FUNCTION public.complete_invite_delivery(
  p_user_id uuid, p_claim_token uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_rc int;
BEGIN
  UPDATE public.app_user_telegram_verifications av
     SET invite_delivery_status = 'sent',
         invite_delivery_sent_at = now(), updated_at = now()
   WHERE av.user_id = p_user_id
     AND av.invite_delivery_claim_token = p_claim_token
     AND av.invite_delivery_status = 'claimed';
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  RETURN v_rc = 1;
END $$;

-- H6) Mark the Stage-3 invite delivery failed (sanitized code only). Stays
--     retryable: claim_invite_delivery() will pick a 'failed' row up again.
CREATE OR REPLACE FUNCTION public.fail_invite_delivery(
  p_user_id uuid, p_claim_token uuid, p_error_code text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_rc int;
BEGIN
  UPDATE public.app_user_telegram_verifications av
     SET invite_delivery_status = 'failed',
         invite_delivery_last_error = left(coalesce(p_error_code,'unknown'),120),
         updated_at = now()
   WHERE av.user_id = p_user_id
     AND av.invite_delivery_claim_token = p_claim_token
     AND av.invite_delivery_status = 'claimed';
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  RETURN v_rc = 1;
END $$;

-- H7) Approve a VERIFIED pending account (Stage 3 gate). Atomic false -> true.
--     Eligible only when the Telegram identity is bound, the private chat is
--     known, the account is not blocked, and the username is not budi/review.
--     Resets invite_delivery_* so a fresh invite can be delivered. Returns a
--     coarse result_code plus the fields the caller needs to send the invite.
--     Idempotent: a second call after approval returns 'already_approved'.
CREATE OR REPLACE FUNCTION public.approve_verified_user(p_username text)
RETURNS TABLE (result_code text, out_user_id uuid, username text,
               telegram_user_id bigint, telegram_private_chat_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_u public.app_users%ROWTYPE; v public.app_user_telegram_verifications%ROWTYPE;
        v_uname text := lower(coalesce(p_username,''));
BEGIN
  SELECT * INTO v_u FROM public.app_users u WHERE lower(u.username) = v_uname FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint; RETURN; END IF;
  IF v_uname IN ('budi','review') THEN RETURN QUERY SELECT 'reserved'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint; RETURN; END IF;
  IF v_u.is_blocked = true THEN RETURN QUERY SELECT 'blocked'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint; RETURN; END IF;
  IF v_u.is_approved = true THEN RETURN QUERY SELECT 'already_approved'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint; RETURN; END IF;

  SELECT * INTO v FROM public.app_user_telegram_verifications av WHERE av.user_id = v_u.id FOR UPDATE;
  IF NOT FOUND OR v.telegram_verified_at IS NULL
     OR v.telegram_user_id IS NULL OR v.telegram_private_chat_id IS NULL THEN
    RETURN QUERY SELECT 'not_verified'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint; RETURN;
  END IF;

  UPDATE public.app_users u SET is_approved = true WHERE u.id = v_u.id AND u.is_approved = false;
  IF NOT FOUND THEN RETURN QUERY SELECT 'already_approved'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint; RETURN; END IF;

  -- Fresh invite must be delivered for this approval.
  UPDATE public.app_user_telegram_verifications av
     SET invite_delivery_status = 'pending',
         invite_delivery_claim_token = NULL,
         invite_delivery_last_error = NULL,
         updated_at = now()
   WHERE av.user_id = v_u.id;

  RETURN QUERY SELECT 'approved'::text, v_u.id, v_u.username, v.telegram_user_id, v.telegram_private_chat_id;
END $$;

-- H8) Delete a Pending or Blocked account (never Approved, never budi/review).
--     Requires an explicit confirmation username that must match exactly. The
--     ON DELETE CASCADE on the child tables removes challenges + verification
--     rows, and dropping the row releases the unique device_id for reuse.
--     Returns a coarse result_code; performs NO destructive action unless the
--     account is eligible AND the confirmation matches.
CREATE OR REPLACE FUNCTION public.admin_delete_user(
  p_username text, p_confirm_username text)
RETURNS TABLE (result_code text, deleted_user_id uuid, released_device_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_u public.app_users%ROWTYPE; v_uname text := lower(coalesce(p_username,''));
BEGIN
  IF v_uname = '' OR lower(coalesce(p_confirm_username,'')) <> v_uname THEN
    RETURN QUERY SELECT 'confirmation_mismatch'::text, NULL::uuid, NULL::text; RETURN;
  END IF;
  IF v_uname IN ('budi','review') THEN
    RETURN QUERY SELECT 'reserved'::text, NULL::uuid, NULL::text; RETURN;
  END IF;

  SELECT * INTO v_u FROM public.app_users u WHERE lower(u.username) = v_uname FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text; RETURN; END IF;

  -- Only Pending (is_approved=false) or Blocked users may be deleted.
  IF v_u.is_approved = true AND v_u.is_blocked = false THEN
    RETURN QUERY SELECT 'approved_protected'::text, NULL::uuid, NULL::text; RETURN;
  END IF;

  DELETE FROM public.app_users u WHERE u.id = v_u.id;  -- cascades to challenges + verifications
  RETURN QUERY SELECT 'deleted'::text, v_u.id, v_u.device_id;
END $$;

-- H9) REPLACE confirm_channel_join: the join callback now requires an APPROVED
--     account. Previously it required is_approved=false (pending); the approval
--     gate flips this so only approved users can complete the join. Fully
--     schema-qualified/aliased so it is never ambiguous with the OUT params.
--       outcomes: not_found | not_verified | pending_approval | blocked
--                 | already_joined | joined_now
CREATE OR REPLACE FUNCTION public.confirm_channel_join(p_telegram_user_id bigint)
RETURNS TABLE (outcome text, user_id uuid, admin_notification_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.app_user_telegram_verifications%ROWTYPE; v_appr boolean; v_blk boolean;
BEGIN
  SELECT * INTO v FROM public.app_user_telegram_verifications av
   WHERE av.telegram_user_id = p_telegram_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text; RETURN; END IF;
  IF v.telegram_verified_at IS NULL THEN RETURN QUERY SELECT 'not_verified'::text, NULL::uuid, NULL::text; RETURN; END IF;

  SELECT u.is_approved, u.is_blocked INTO v_appr, v_blk
    FROM public.app_users u WHERE u.id = v.user_id;
  IF v_blk IS DISTINCT FROM false THEN RETURN QUERY SELECT 'blocked'::text, NULL::uuid, NULL::text; RETURN; END IF;
  IF v_appr IS DISTINCT FROM true THEN RETURN QUERY SELECT 'pending_approval'::text, NULL::uuid, NULL::text; RETURN; END IF;

  IF v.channel_joined_at IS NOT NULL THEN
     RETURN QUERY SELECT 'already_joined'::text, v.user_id, v.admin_notification_status; RETURN;
  END IF;

  UPDATE public.app_user_telegram_verifications av
     SET channel_joined_at = now(),
         admin_notification_status = CASE WHEN av.admin_notification_status='sent'
                                          THEN av.admin_notification_status ELSE 'pending' END,
         updated_at = now()
   WHERE av.user_id = v.user_id;
  RETURN QUERY SELECT 'joined_now'::text, v.user_id, 'pending'::text;
END $$;

-- =========================================================================
-- GRANTS: lock every new/replaced function to service_role only; owner postgres.
-- =========================================================================
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
   'public.claim_verify_notification(uuid,integer)',
   'public.complete_verify_notification(uuid,uuid)',
   'public.fail_verify_notification(uuid,uuid,text)',
   'public.claim_invite_delivery(uuid,integer)',
   'public.complete_invite_delivery(uuid,uuid)',
   'public.fail_invite_delivery(uuid,uuid,text)',
   'public.approve_verified_user(text)',
   'public.admin_delete_user(text,text)',
   'public.confirm_channel_join(bigint)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated;', fn);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO service_role;', fn);
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres;', fn);
  END LOOP;
END $$;

-- RLS on public.app_user_telegram_verifications remains enabled with no
-- anon/authenticated policies (service_role bypasses RLS). No table grants added.
REVOKE ALL ON public.app_user_telegram_verifications FROM anon, authenticated;
