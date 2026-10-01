-- =========================================================================
-- Telegram MEMBER LIFECYCLE hotfix (additive migration).
--
-- PURPOSE
--   Adds the minimum persistence + service-role RPCs for three additive
--   member-lifecycle features on top of the Telegram verification v2 schema:
--
--     1) 30-day in-bot rating   -> review_requested_at / review_submitted_at /
--                                  review_score (1..5). One request, one stored
--                                  score, idempotent submission.
--     2) Legacy verification     -> verification_reminder_count /
--        reminders                 verification_reminded_at. At most TWO
--                                  reminders, the second at least 24h after the
--                                  first, and ONLY for records that already carry
--                                  a valid Telegram private chat id (an unknown
--                                  channel member is never messaged).
--     3) Legacy channel notice   -> a single-row guard table keyed by a notice
--                                  key, carrying legacy_notice_sent_at, so a
--                                  generic channel announcement can be triggered
--                                  exactly once (double-submission is blocked).
--
-- RELIABLE / RETRYABLE DELIVERY (two-phase claim -> send -> commit/release)
--   A failed Telegram send must NOT permanently consume one of the two reminder
--   attempts, nor the single review request. Delivery is therefore split into
--   three RPCs per feature, coordinated by short-lived lease columns:
--
--     * claim_*   : atomically acquires a lease (claim_token + claim_expires_at)
--                   under a row lock. Concurrent workers are serialized; only one
--                   wins the lease, everyone else gets 'skip'. The delivered
--                   counter / review_requested_at is NOT advanced here.
--     * commit_*  : called ONLY after a confirmed successful send. If the lease
--                   token still matches, it advances the delivered state
--                   (verification_reminder_count / verification_reminded_at or
--                   review_requested_at) and clears the lease.
--     * release_* : called after a FAILED send. If the token matches it clears
--                   the lease so a later daily run can retry. Nothing is counted.
--
--   Because delivered state advances only on commit, a failed send is fully
--   retryable, the "at most two delivered reminders" / "one delivered review
--   request" invariants hold, and an abandoned lease self-heals when
--   claim_expires_at passes. list_due_* skips rows with an active (unexpired)
--   lease so a second worker never targets an in-flight record.
--
-- SAFETY / SCOPE
--   - Additive ONLY. ADD COLUMN IF NOT EXISTS on the existing
--     public.app_user_telegram_verifications table + a new guard table + new
--     functions. NO destructive ALTER, NO DROP, no data deletion.
--   - review_score is constrained to the inclusive range 1..5 (NULL allowed
--     until a rating is submitted).
--   - Every function is SECURITY DEFINER with a fixed, non-hijackable
--     search_path (pg_catalog, public), fully schema-qualified, owned by
--     postgres, and granted EXECUTE to service_role only (revoked from PUBLIC,
--     anon, authenticated).
--   - RLS posture is unchanged: the new guard table has RLS enabled with NO
--     anon/authenticated policies (service_role bypasses RLS). No table grants
--     are added for anon/authenticated.
--   - No raw code, bot token, PII, or full Telegram payload is stored.
--
-- This file is a migration DRAFT for review. Do NOT rely on it being applied by
-- the application; run it intentionally by an operator AFTER the base migration
-- (supabase/telegram-verification-v2-migration.sql) and the approval-gate
-- hotfix (supabase/telegram-verification-v2-approval-gate-hotfix.sql).
-- =========================================================================

-- -------------------------------------------------------------------------
-- (1) 30-day rating columns + review-request delivery lease.
-- -------------------------------------------------------------------------
ALTER TABLE public.app_user_telegram_verifications
  ADD COLUMN IF NOT EXISTS review_requested_at            timestamptz,
  ADD COLUMN IF NOT EXISTS review_submitted_at            timestamptz,
  ADD COLUMN IF NOT EXISTS review_score                   integer,
  -- Temporary delivery lease so a failed review send stays retryable.
  ADD COLUMN IF NOT EXISTS review_request_claim_token       uuid,
  ADD COLUMN IF NOT EXISTS review_request_claim_expires_at  timestamptz;

-- Enforce review_score in [1,5] without failing if the constraint already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_autv_review_score_range'
  ) THEN
    ALTER TABLE public.app_user_telegram_verifications
      ADD CONSTRAINT chk_autv_review_score_range
      CHECK (review_score IS NULL OR (review_score >= 1 AND review_score <= 5));
  END IF;
END $$;

-- Review-request scheduling lookup (only rows not yet requested/submitted).
CREATE INDEX IF NOT EXISTS idx_autv_review_due
  ON public.app_user_telegram_verifications (channel_joined_at)
  WHERE review_requested_at IS NULL AND review_submitted_at IS NULL;

-- -------------------------------------------------------------------------
-- (2) Legacy verification reminder columns + reminder delivery lease.
-- -------------------------------------------------------------------------
ALTER TABLE public.app_user_telegram_verifications
  ADD COLUMN IF NOT EXISTS verification_reminder_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verification_reminded_at    timestamptz,
  -- Temporary delivery lease so a failed reminder send stays retryable.
  ADD COLUMN IF NOT EXISTS verification_reminder_claim_token      uuid,
  ADD COLUMN IF NOT EXISTS verification_reminder_claim_expires_at timestamptz;

-- Reminder scheduling lookup (only records that carry a private chat id and are
-- not yet verified are ever eligible; the partial predicate keeps it small).
CREATE INDEX IF NOT EXISTS idx_autv_reminder_due
  ON public.app_user_telegram_verifications (verification_reminded_at)
  WHERE telegram_verified_at IS NULL
    AND telegram_private_chat_id IS NOT NULL
    AND verification_reminder_count < 2;

-- -------------------------------------------------------------------------
-- (3) Legacy channel-announcement single-row guard (double-submit protection).
--     legacy_notice_sent_at records the exact time a keyed announcement was
--     first triggered; the primary key blocks any repeated trigger.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telegram_legacy_channel_announcements (
  announcement_key      text PRIMARY KEY,
  legacy_notice_sent_at timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.telegram_legacy_channel_announcements ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- FUNCTIONS / RPCs
-- =========================================================================

-- L1) Record a 30-day rating from the private bot. Identity is resolved ONLY by
--     telegram_user_id (the callback sender). Accepts scores 1..5 only. Stores
--     the score exactly once; a repeated callback is idempotent
--     ('already_submitted') and never overwrites the first score. Never sends /
--     never mutates any other state.
--       outcomes: recorded | already_submitted | invalid_score
--                 | not_found | ineligible
CREATE OR REPLACE FUNCTION public.record_review_rating(
  p_telegram_user_id bigint, p_score integer)
RETURNS TABLE (outcome text, out_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.app_user_telegram_verifications%ROWTYPE; v_appr boolean; v_blk boolean; v_uname text;
BEGIN
  IF p_score IS NULL OR p_score < 1 OR p_score > 5 THEN
    RETURN QUERY SELECT 'invalid_score'::text, NULL::uuid; RETURN;
  END IF;

  SELECT * INTO v FROM public.app_user_telegram_verifications av
   WHERE av.telegram_user_id = p_telegram_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;
  IF v.telegram_verified_at IS NULL THEN RETURN QUERY SELECT 'ineligible'::text, NULL::uuid; RETURN; END IF;

  SELECT u.is_approved, u.is_blocked, u.username INTO v_appr, v_blk, v_uname
    FROM public.app_users u WHERE u.id = v.user_id;
  IF v_appr IS DISTINCT FROM true OR v_blk IS DISTINCT FROM false
     OR lower(coalesce(v_uname,'')) IN ('budi','review') THEN
    RETURN QUERY SELECT 'ineligible'::text, NULL::uuid; RETURN;
  END IF;

  -- Idempotent: never store a second score, never overwrite the first. A
  -- submitted review is terminal and can never be requested again.
  IF v.review_submitted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_submitted'::text, v.user_id; RETURN;
  END IF;

  UPDATE public.app_user_telegram_verifications av
     SET review_score = p_score,
         review_submitted_at = now(),
         review_requested_at = COALESCE(av.review_requested_at, now()),
         -- Clear any in-flight request lease; the review is now complete.
         review_request_claim_token = NULL,
         review_request_claim_expires_at = NULL,
         updated_at = now()
   WHERE av.user_id = v.user_id;
  RETURN QUERY SELECT 'recorded'::text, v.user_id;
END $$;

-- L2) List app users due for a 30-day review request. Eligibility: verified,
--     approved, not blocked, not reserved, with a KNOWN channel_joined_at at
--     least 30 days old, a bound private chat, no request/submission yet, and NO
--     active delivery lease. A NULL channel_joined_at (unknown historical join
--     date) is NEVER eligible — a join date is never invented.
CREATE OR REPLACE FUNCTION public.list_due_review_requests(p_limit integer)
RETURNS TABLE (user_id uuid, telegram_private_chat_id bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT av.user_id, av.telegram_private_chat_id
    FROM public.app_user_telegram_verifications av
    JOIN public.app_users u ON u.id = av.user_id
   WHERE av.telegram_verified_at IS NOT NULL
     AND av.telegram_private_chat_id IS NOT NULL
     AND av.channel_joined_at IS NOT NULL
     AND av.channel_joined_at <= now() - interval '30 days'
     AND av.review_requested_at IS NULL
     AND av.review_submitted_at IS NULL
     AND (av.review_request_claim_expires_at IS NULL
          OR av.review_request_claim_expires_at <= now())
     AND u.is_approved = true
     AND u.is_blocked = false
     AND lower(u.username) NOT IN ('budi','review')
   ORDER BY av.channel_joined_at ASC
   LIMIT least(greatest(coalesce(p_limit,50),1),500);
$$;

-- L3a) Claim (lease) a review request for one user. Re-checks the full
--      eligibility under a row lock and, if the lease is free/expired, stamps a
--      fresh claim_token + claim_expires_at. It does NOT set review_requested_at
--      — that only happens on commit after a successful send. Concurrent workers
--      are serialized by FOR UPDATE; the loser sees an active lease and skips.
--       outcomes: claimed | skip
CREATE OR REPLACE FUNCTION public.claim_review_request(
  p_user_id uuid, p_lease_seconds integer DEFAULT 120)
RETURNS TABLE (outcome text, telegram_private_chat_id bigint, claim_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.app_user_telegram_verifications%ROWTYPE; v_appr boolean; v_blk boolean; v_uname text; v_token uuid;
        v_lease integer := least(greatest(coalesce(p_lease_seconds,120),10),3600);
BEGIN
  SELECT * INTO v FROM public.app_user_telegram_verifications av
   WHERE av.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'skip'::text, NULL::bigint, NULL::uuid; RETURN; END IF;
  IF v.telegram_verified_at IS NULL OR v.telegram_private_chat_id IS NULL
     OR v.channel_joined_at IS NULL
     OR v.channel_joined_at > now() - interval '30 days'
     OR v.review_requested_at IS NOT NULL
     OR v.review_submitted_at IS NOT NULL
     OR (v.review_request_claim_expires_at IS NOT NULL
         AND v.review_request_claim_expires_at > now()) THEN
    RETURN QUERY SELECT 'skip'::text, NULL::bigint, NULL::uuid; RETURN;
  END IF;

  SELECT u.is_approved, u.is_blocked, u.username INTO v_appr, v_blk, v_uname
    FROM public.app_users u WHERE u.id = v.user_id;
  IF v_appr IS DISTINCT FROM true OR v_blk IS DISTINCT FROM false
     OR lower(coalesce(v_uname,'')) IN ('budi','review') THEN
    RETURN QUERY SELECT 'skip'::text, NULL::bigint, NULL::uuid; RETURN;
  END IF;

  v_token := gen_random_uuid();
  UPDATE public.app_user_telegram_verifications av
     SET review_request_claim_token = v_token,
         review_request_claim_expires_at = now() + make_interval(secs => v_lease),
         updated_at = now()
   WHERE av.user_id = v.user_id;
  RETURN QUERY SELECT 'claimed'::text, v.telegram_private_chat_id, v_token;
END $$;

-- L3b) Commit a review request AFTER a confirmed successful send. Only the lease
--      owner (matching token) may set review_requested_at. Idempotent: a stale
--      or missing token yields 'stale' and changes nothing.
--       outcomes: committed | stale
CREATE OR REPLACE FUNCTION public.commit_review_request(p_user_id uuid, p_token uuid)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.app_user_telegram_verifications%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.app_user_telegram_verifications av
   WHERE av.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR v.review_request_claim_token IS DISTINCT FROM p_token THEN
    RETURN QUERY SELECT 'stale'::text; RETURN;
  END IF;
  IF v.review_submitted_at IS NOT NULL THEN
    -- Already terminal; just drop the lease.
    UPDATE public.app_user_telegram_verifications av
       SET review_request_claim_token = NULL, review_request_claim_expires_at = NULL, updated_at = now()
     WHERE av.user_id = v.user_id;
    RETURN QUERY SELECT 'stale'::text; RETURN;
  END IF;

  UPDATE public.app_user_telegram_verifications av
     SET review_requested_at = COALESCE(av.review_requested_at, now()),
         review_request_claim_token = NULL,
         review_request_claim_expires_at = NULL,
         updated_at = now()
   WHERE av.user_id = v.user_id;
  RETURN QUERY SELECT 'committed'::text;
END $$;

-- L3c) Release a review-request lease AFTER a failed send so a later run retries.
--      Only the lease owner may release. review_requested_at stays NULL.
--       outcomes: released | stale
CREATE OR REPLACE FUNCTION public.release_review_request(p_user_id uuid, p_token uuid)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.app_user_telegram_verifications%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.app_user_telegram_verifications av
   WHERE av.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR v.review_request_claim_token IS DISTINCT FROM p_token THEN
    RETURN QUERY SELECT 'stale'::text; RETURN;
  END IF;
  UPDATE public.app_user_telegram_verifications av
     SET review_request_claim_token = NULL,
         review_request_claim_expires_at = NULL,
         updated_at = now()
   WHERE av.user_id = v.user_id;
  RETURN QUERY SELECT 'released'::text;
END $$;

-- L4) List records due for a legacy verification reminder. Eligibility: a bound
--     private chat id (so an unknown channel member is NEVER selected), NOT yet
--     verified, the account not blocked and not reserved, fewer than two
--     reminders sent, NO active delivery lease, and — for the SECOND reminder —
--     the first sent at least 24h ago. Reserved/blocked/verified users are
--     excluded.
CREATE OR REPLACE FUNCTION public.list_due_verification_reminders(p_limit integer)
RETURNS TABLE (user_id uuid, telegram_private_chat_id bigint, verification_reminder_count integer)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT av.user_id, av.telegram_private_chat_id, av.verification_reminder_count
    FROM public.app_user_telegram_verifications av
    JOIN public.app_users u ON u.id = av.user_id
   WHERE av.telegram_private_chat_id IS NOT NULL
     AND av.telegram_verified_at IS NULL
     AND av.verification_reminder_count < 2
     AND (av.verification_reminder_claim_expires_at IS NULL
          OR av.verification_reminder_claim_expires_at <= now())
     AND u.is_blocked = false
     AND lower(u.username) NOT IN ('budi','review')
     AND (
           av.verification_reminder_count = 0
           OR (av.verification_reminder_count = 1
               AND av.verification_reminded_at IS NOT NULL
               AND av.verification_reminded_at <= now() - interval '24 hours')
         )
   ORDER BY av.verification_reminded_at ASC NULLS FIRST
   LIMIT least(greatest(coalesce(p_limit,50),1),500);
$$;

-- L5a) Claim (lease) a verification reminder for one record. Re-checks
--      eligibility under a row lock (max-two + 24h-gap + bound private chat +
--      not verified/blocked/reserved) and, if the lease is free/expired, stamps a
--      fresh claim_token + claim_expires_at. It does NOT increment the delivered
--      counter — that only happens on commit after a successful send. Concurrent
--      workers are serialized; the loser sees an active lease and skips.
--       outcomes: claimed | skip
CREATE OR REPLACE FUNCTION public.claim_verification_reminder(
  p_user_id uuid, p_lease_seconds integer DEFAULT 120)
RETURNS TABLE (outcome text, telegram_private_chat_id bigint, reminder_count integer, claim_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.app_user_telegram_verifications%ROWTYPE; v_blk boolean; v_uname text; v_token uuid;
        v_lease integer := least(greatest(coalesce(p_lease_seconds,120),10),3600);
BEGIN
  SELECT * INTO v FROM public.app_user_telegram_verifications av
   WHERE av.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'skip'::text, NULL::bigint, NULL::integer, NULL::uuid; RETURN; END IF;

  -- Stop immediately after verification; never remind an unknown/verified user;
  -- never exceed two delivered reminders; skip while a lease is still active.
  IF v.telegram_verified_at IS NOT NULL
     OR v.telegram_private_chat_id IS NULL
     OR v.verification_reminder_count >= 2
     OR (v.verification_reminder_claim_expires_at IS NOT NULL
         AND v.verification_reminder_claim_expires_at > now()) THEN
    RETURN QUERY SELECT 'skip'::text, NULL::bigint, NULL::integer, NULL::uuid; RETURN;
  END IF;

  -- The second reminder must wait at least 24h after the first delivered one.
  IF v.verification_reminder_count = 1
     AND (v.verification_reminded_at IS NULL
          OR v.verification_reminded_at > now() - interval '24 hours') THEN
    RETURN QUERY SELECT 'skip'::text, NULL::bigint, NULL::integer, NULL::uuid; RETURN;
  END IF;

  SELECT u.is_blocked, u.username INTO v_blk, v_uname
    FROM public.app_users u WHERE u.id = v.user_id;
  IF v_blk IS DISTINCT FROM false OR lower(coalesce(v_uname,'')) IN ('budi','review') THEN
    RETURN QUERY SELECT 'skip'::text, NULL::bigint, NULL::integer, NULL::uuid; RETURN;
  END IF;

  v_token := gen_random_uuid();
  UPDATE public.app_user_telegram_verifications av
     SET verification_reminder_claim_token = v_token,
         verification_reminder_claim_expires_at = now() + make_interval(secs => v_lease),
         updated_at = now()
   WHERE av.user_id = v.user_id;
  RETURN QUERY SELECT 'claimed'::text, v.telegram_private_chat_id, v.verification_reminder_count, v_token;
END $$;

-- L5b) Commit a verification reminder AFTER a confirmed successful send. Only the
--      lease owner (matching token) increments verification_reminder_count and
--      stamps verification_reminded_at, then clears the lease. The count can
--      never exceed two (re-checked under the lock).
--       outcomes: committed | stale
CREATE OR REPLACE FUNCTION public.commit_verification_reminder(p_user_id uuid, p_token uuid)
RETURNS TABLE (outcome text, reminder_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.app_user_telegram_verifications%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.app_user_telegram_verifications av
   WHERE av.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR v.verification_reminder_claim_token IS DISTINCT FROM p_token THEN
    RETURN QUERY SELECT 'stale'::text, NULL::integer; RETURN;
  END IF;
  IF v.verification_reminder_count >= 2 THEN
    -- Defensive cap; just drop the lease without a third increment.
    UPDATE public.app_user_telegram_verifications av
       SET verification_reminder_claim_token = NULL, verification_reminder_claim_expires_at = NULL, updated_at = now()
     WHERE av.user_id = v.user_id;
    RETURN QUERY SELECT 'stale'::text, v.verification_reminder_count; RETURN;
  END IF;

  UPDATE public.app_user_telegram_verifications av
     SET verification_reminder_count = av.verification_reminder_count + 1,
         verification_reminded_at = now(),
         verification_reminder_claim_token = NULL,
         verification_reminder_claim_expires_at = NULL,
         updated_at = now()
   WHERE av.user_id = v.user_id;
  RETURN QUERY SELECT 'committed'::text, (v.verification_reminder_count + 1);
END $$;

-- L5c) Release a verification-reminder lease AFTER a failed send so a later run
--      retries. Only the lease owner may release; the counter is untouched.
--       outcomes: released | stale
CREATE OR REPLACE FUNCTION public.release_verification_reminder(p_user_id uuid, p_token uuid)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.app_user_telegram_verifications%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.app_user_telegram_verifications av
   WHERE av.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR v.verification_reminder_claim_token IS DISTINCT FROM p_token THEN
    RETURN QUERY SELECT 'stale'::text; RETURN;
  END IF;
  UPDATE public.app_user_telegram_verifications av
     SET verification_reminder_claim_token = NULL,
         verification_reminder_claim_expires_at = NULL,
         updated_at = now()
   WHERE av.user_id = v.user_id;
  RETURN QUERY SELECT 'released'::text;
END $$;

-- L6) Claim the one-shot legacy channel announcement (double-submit guard).
--     The primary key makes the FIRST call the only claimant; every repeat is
--     rejected. Returns claimed=true only for the call that inserted the row.
CREATE OR REPLACE FUNCTION public.claim_legacy_channel_announcement(p_key text)
RETURNS TABLE (claimed boolean, legacy_notice_sent_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_key text := left(coalesce(p_key,'default'),120); v_ins text; v_ts timestamptz;
BEGIN
  INSERT INTO public.telegram_legacy_channel_announcements (announcement_key)
  VALUES (v_key)
  ON CONFLICT (announcement_key) DO NOTHING
  RETURNING announcement_key INTO v_ins;

  IF v_ins IS NOT NULL THEN
    SELECT a.legacy_notice_sent_at INTO v_ts
      FROM public.telegram_legacy_channel_announcements a WHERE a.announcement_key = v_key;
    RETURN QUERY SELECT true, v_ts; RETURN;
  END IF;

  SELECT a.legacy_notice_sent_at INTO v_ts
    FROM public.telegram_legacy_channel_announcements a WHERE a.announcement_key = v_key;
  RETURN QUERY SELECT false, v_ts;
END $$;

-- =========================================================================
-- GRANTS: lock every new function to service_role only; owner postgres (DEFINER).
-- =========================================================================
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
   'public.record_review_rating(bigint,integer)',
   'public.list_due_review_requests(integer)',
   'public.claim_review_request(uuid,integer)',
   'public.commit_review_request(uuid,uuid)',
   'public.release_review_request(uuid,uuid)',
   'public.list_due_verification_reminders(integer)',
   'public.claim_verification_reminder(uuid,integer)',
   'public.commit_verification_reminder(uuid,uuid)',
   'public.release_verification_reminder(uuid,uuid)',
   'public.claim_legacy_channel_announcement(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated;', fn);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO service_role;', fn);
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres;', fn);
  END LOOP;
END $$;

-- No table-level grants to anon/authenticated. service_role bypasses RLS.
REVOKE ALL ON public.telegram_legacy_channel_announcements FROM anon, authenticated;
