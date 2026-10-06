-- ======================================================================
-- Auto-Cuan Subscription Trial & Google Account Linking Migration
-- Wave 8 Product Contract: 14-day initial trial + 7-day Google link bonus
-- DO NOT APPLY TO REMOTE DATABASE WITHOUT EXTERNAL APPROVAL
-- ======================================================================

-- 1. Evolve public.user_entitlements to support trial_kind discriminator
ALTER TABLE public.user_entitlements
  ADD COLUMN IF NOT EXISTS trial_kind text;

-- 2. Backfill existing historical trial rows safely as 'legacy_initial' (10-day historical trial)
UPDATE public.user_entitlements
  SET trial_kind = 'legacy_initial'
  WHERE source = 'trial' AND trial_kind IS NULL;

-- 3. Replace the legacy 10-day trial CHECK constraint with an explicit kind-aware integrity constraint.
-- IMPORTANT: Preserve user_entitlements_check (lifetime vs expires consistency)
-- and user_entitlements_check1 (expires_at > starts_at).
-- Drop ONLY the legacy trial check constraint (by inspecting pg_constraint definition containing '10 days' or matching user_entitlements_check2).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN (
    SELECT conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND t.relname = 'user_entitlements'
      AND c.contype = 'c'
      AND (
        pg_get_constraintdef(c.oid) ILIKE '%10 days%'
        OR conname = 'user_entitlements_check2'
        OR conname = 'user_entitlements_trial_check'
        OR conname = 'user_entitlements_trial_kind_check'
      )
      AND conname NOT IN ('user_entitlements_check', 'user_entitlements_check1')
  ) LOOP
    EXECUTE format('ALTER TABLE public.user_entitlements DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END;
$$;

ALTER TABLE public.user_entitlements
  ADD CONSTRAINT user_entitlements_trial_kind_check
  CHECK (
    (source <> 'trial' AND trial_kind IS NULL)
    OR
    (
      source = 'trial'
      AND trial_kind IS NOT NULL
      AND starts_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND lifetime = false
      AND plan_code IS NULL
      AND (
        (trial_kind = 'legacy_initial'
          AND expires_at = starts_at + interval '10 days')
        OR
        (trial_kind = 'initial'
          AND expires_at = starts_at + interval '14 days')
        OR
        (trial_kind = 'google_link_bonus'
          AND expires_at = starts_at + interval '7 days')
      )
    )
  );

-- 4. Replace single trial index with kind-specific unique constraints
-- Each user may have at most ONE initial-type trial (legacy_initial OR initial)
-- and at most ONE google_link_bonus trial.
DROP INDEX IF EXISTS public.uq_one_trial_per_web_user;

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_initial_trial_per_user
  ON public.user_entitlements (user_id)
  WHERE source = 'trial' AND trial_kind IN ('legacy_initial', 'initial');

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_google_bonus_per_user
  ON public.user_entitlements (user_id)
  WHERE source = 'trial' AND trial_kind = 'google_link_bonus';

-- 5. Authoritative Feature Rollout Cutoff Singleton
-- Pre-rollout accounts receive one +7 bonus on Google link. Post-rollout accounts receive 14d initial and 0 bonus.
-- ON CONFLICT DO NOTHING ensures subsequent migration reruns never advance the cutoff.
CREATE TABLE IF NOT EXISTS public.system_feature_rollouts (
  feature_key text PRIMARY KEY,
  cutoff_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.system_feature_rollouts (feature_key, cutoff_at)
  VALUES ('google_link_bonus', now())
  ON CONFLICT (feature_key) DO NOTHING;

ALTER TABLE public.system_feature_rollouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.system_feature_rollouts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.system_feature_rollouts TO service_role;

-- 6. Authoritative Google Link Table
-- Enforces a strict 1:1 historical relationship: ONE Auto-Cuan user <-> ONE Google subject identity.
-- ON DELETE RESTRICT prevents accidental or cascading erasure of historical Google identity ownership.
-- Unlink deactivates (unlinked_at = now()) without deleting historical ownership.
-- Bonus granted state is tracked authoritatively by bonus_granted_at timestamp (no redundant boolean).
CREATE TABLE IF NOT EXISTS public.app_user_google_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.app_users(id) ON DELETE RESTRICT,
  google_sub text NOT NULL UNIQUE,
  google_email text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  linked_at timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz,
  bonus_granted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Database-level 1:1 historical ownership constraints:
-- UNIQUE (google_sub): prevents the same Google identity from being linked to a different Auto-Cuan user
DROP INDEX IF EXISTS public.uq_app_user_google_links_sub_owner;
DROP INDEX IF EXISTS public.uq_app_user_google_links_sub;
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_user_google_links_sub
  ON public.app_user_google_links (google_sub);

-- UNIQUE (user_id): prevents an Auto-Cuan user from linking a second Google identity in normal self-service
DROP INDEX IF EXISTS public.uq_app_user_google_links_active_user;
DROP INDEX IF EXISTS public.uq_app_user_google_links_user;
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_user_google_links_user
  ON public.app_user_google_links (user_id);

-- RLS & Security Grants
ALTER TABLE public.app_user_google_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_user_google_links FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.app_user_google_links TO service_role;

-- 7. Authoritative Short-Lived OAuth State Storage Table
-- State/nonce/PKCE code_verifier bound to authenticated user session with single-use consumption.
CREATE TABLE IF NOT EXISTS public.app_user_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  state text NOT NULL UNIQUE,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  redirect_uri text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_app_user_oauth_states_user
  ON public.app_user_oauth_states (user_id);

CREATE INDEX IF NOT EXISTS idx_app_user_oauth_states_state
  ON public.app_user_oauth_states (state);

ALTER TABLE public.app_user_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_user_oauth_states FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.app_user_oauth_states TO service_role;

-- RPC to atomically consume OAuth state using opaque state token as authority
-- Does NOT require client-provided user_id (ac_sess is not available on cross-site callback).
-- Returns the authoritative user_id stored during state creation.
CREATE OR REPLACE FUNCTION public.consume_oauth_state(
  p_state text,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  consumed boolean,
  user_id uuid,
  nonce text,
  code_verifier text,
  error_code text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_rec public.app_user_oauth_states%ROWTYPE;
BEGIN
  IF p_state IS NULL OR length(btrim(p_state)) = 0 THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::text, 'invalid_arguments'::text;
    RETURN;
  END IF;

  SELECT * INTO v_rec FROM public.app_user_oauth_states
    WHERE state = p_state FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::text, 'state_not_found'::text;
    RETURN;
  END IF;

  IF v_rec.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::text, 'state_already_consumed'::text;
    RETURN;
  END IF;

  IF v_rec.expires_at < p_now THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::text, 'state_expired'::text;
    RETURN;
  END IF;

  UPDATE public.app_user_oauth_states
    SET consumed_at = p_now
    WHERE id = v_rec.id;

  RETURN QUERY SELECT true, v_rec.user_id, v_rec.nonce, v_rec.code_verifier, NULL::text;
END $$;
REVOKE ALL ON FUNCTION public.consume_oauth_state(text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_oauth_state(text,timestamptz) TO service_role;

-- 8. Updated Initial Trial Activation RPC (14 Days)
-- Strictly preserves existing Telegram verification, account unblocked, and approval gates.
CREATE OR REPLACE FUNCTION public.activate_subscription_trial(
  p_user_id uuid,
  p_activation_idempotency_key uuid,
  p_activation_time timestamptz
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  u public.app_users%ROWTYPE;
  l public.telegram_subscription_links%ROWTYPE;
  e public.user_entitlements%ROWTYPE;
  v_start timestamptz;
  v_expiry timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_activation_idempotency_key IS NULL OR p_activation_time IS NULL
     OR p_activation_time > now() + interval '5 minutes'
     OR p_activation_time < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid activation';
  END IF;

  SELECT * INTO e FROM public.user_entitlements
    WHERE activation_idempotency_key = p_activation_idempotency_key::text FOR UPDATE;
  IF FOUND THEN
    IF e.user_id <> p_user_id THEN RAISE EXCEPTION 'activation rejected'; END IF;
    RETURN jsonb_build_object(
      'active', e.status = 'active' AND e.starts_at <= now() AND now() < e.expires_at,
      'starts_at', e.starts_at,
      'expires_at', e.expires_at,
      'duration_days', ROUND(EXTRACT(EPOCH FROM (e.expires_at - e.starts_at)) / 86400)::integer
    );
  END IF;

  SELECT * INTO u FROM public.app_users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR u.is_blocked THEN RAISE EXCEPTION 'activation rejected'; END IF;
  IF lower(btrim(u.username)) = 'budi' THEN
    RETURN jsonb_build_object('active', true, 'admin', true);
  END IF;

  INSERT INTO public.subscription_events(user_id, event_type, metadata)
    VALUES (u.id, 'subscription_trial_activation_requested', jsonb_build_object('request_id', p_activation_idempotency_key::text, 'source_channel', 'api'));

  SELECT * INTO l FROM public.telegram_subscription_links WHERE user_id = u.id AND link_state = 'linked' FOR UPDATE;
  IF NOT FOUND OR l.telegram_user_id IS NULL THEN RAISE EXCEPTION 'telegram required'; END IF;

  IF EXISTS (SELECT 1 FROM public.user_entitlements WHERE user_id = u.id AND source = 'trial' AND trial_kind IN ('legacy_initial', 'initial') FOR UPDATE) THEN
    RAISE EXCEPTION 'trial consumed';
  END IF;

  v_start := p_activation_time;
  v_expiry := v_start + interval '14 days';

  INSERT INTO public.user_entitlements(user_id, source, trial_kind, status, starts_at, expires_at, lifetime, activation_idempotency_key)
    VALUES (u.id, 'trial', 'initial', 'active', v_start, v_expiry, false, p_activation_idempotency_key::text)
    RETURNING * INTO e;

  INSERT INTO public.subscription_trial_telegram_users(telegram_user_id, entitlement_id)
    VALUES (l.telegram_user_id, e.id);

  INSERT INTO public.subscription_events(user_id, entitlement_id, event_type, metadata)
    VALUES (u.id, e.id, 'subscription_trial_activated', jsonb_build_object('duration_days', 14, 'starts_at', v_start, 'expires_at', v_expiry, 'trial_kind', 'initial'));

  IF u.is_approved = false THEN
    UPDATE public.app_users SET is_approved = true WHERE id = u.id;
    INSERT INTO public.subscription_events(user_id, entitlement_id, event_type, metadata)
      VALUES (u.id, e.id, 'account_auto_approved_by_trial', jsonb_build_object('previous_approval_state', 'pending', 'new_approval_state', 'approved'));
  END IF;

  RETURN jsonb_build_object('active', true, 'starts_at', v_start, 'expires_at', v_expiry, 'duration_days', 14);
END $$;
REVOKE ALL ON FUNCTION public.activate_subscription_trial(uuid,uuid,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_subscription_trial(uuid,uuid,timestamptz) TO service_role;

-- 9. Atomic Google Identity Link and Trial Bonus RPC
-- All validations, identity updates, pre-rollout bonus check, and entitlement inserts execute inside ONE transaction.
CREATE OR REPLACE FUNCTION public.link_google_identity_and_grant_bonus(
  p_user_id uuid,
  p_google_sub text,
  p_google_email text,
  p_email_verified boolean,
  p_idempotency_key text,
  p_activation_time timestamptz DEFAULT now()
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  u public.app_users%ROWTYPE;
  existing_sub public.app_user_google_links%ROWTYPE;
  existing_user public.app_user_google_links%ROWTYPE;
  active_trial public.user_entitlements%ROWTYPE;
  bonus_ent public.user_entitlements%ROWTYPE;
  v_cutoff_at timestamptz;
  v_is_pre_rollout boolean := false;
  v_bonus_already_claimed boolean := false;
  v_bonus_start timestamptz;
  v_bonus_expiry timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_google_sub IS NULL OR length(btrim(p_google_sub)) = 0
     OR p_google_email IS NULL OR length(btrim(p_google_email)) = 0
     OR p_email_verified IS NOT TRUE
     OR p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'invalid_google_link_request';
  END IF;

  -- Idempotency check: if this idempotency key was already processed, return existing result
  SELECT * INTO bonus_ent FROM public.user_entitlements WHERE activation_idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF bonus_ent.user_id <> p_user_id THEN RAISE EXCEPTION 'idempotency_key_mismatch'; END IF;
    RETURN jsonb_build_object(
      'success', true,
      'linked', true,
      'bonus_granted', true,
      'starts_at', bonus_ent.starts_at,
      'expires_at', bonus_ent.expires_at,
      'duration_days', 7,
      'google_sub', p_google_sub
    );
  END IF;

  SELECT * INTO u FROM public.app_users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR u.is_blocked THEN RAISE EXCEPTION 'user_not_eligible'; END IF;

  -- Historical stable ownership protection: a google_sub cannot belong to different users
  SELECT * INTO existing_sub FROM public.app_user_google_links WHERE google_sub = p_google_sub FOR UPDATE;
  IF FOUND AND existing_sub.user_id <> p_user_id THEN
    RAISE EXCEPTION 'google_identity_conflict';
  END IF;

  -- 1:1 user ownership: an Auto-Cuan user cannot link a different Google identity in normal self-service
  SELECT * INTO existing_user FROM public.app_user_google_links WHERE user_id = p_user_id FOR UPDATE;
  IF FOUND AND existing_user.google_sub <> p_google_sub THEN
    RAISE EXCEPTION 'user_google_link_mismatch';
  END IF;

  -- Rollout cutoff determination: +7 bonus applies ONLY to pre-rollout accounts
  -- If rollout record is missing or unreadable, FAIL CLOSED: treat bonus eligibility as false!
  SELECT cutoff_at INTO v_cutoff_at FROM public.system_feature_rollouts WHERE feature_key = 'google_link_bonus';
  IF v_cutoff_at IS NULL THEN
    v_is_pre_rollout := false;
  ELSE
    v_is_pre_rollout := (u.created_at < v_cutoff_at);
  END IF;

  -- Check if bonus was ever claimed by this user or with this Google sub (bonus_granted_at timestamp is the source of truth)
  v_bonus_already_claimed := (existing_user.id IS NOT NULL AND existing_user.bonus_granted_at IS NOT NULL)
    OR (existing_sub.id IS NOT NULL AND existing_sub.bonus_granted_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.user_entitlements WHERE user_id = p_user_id AND source = 'trial' AND trial_kind = 'google_link_bonus');

  -- Upsert or reactivate existing ownership row (never create duplicate row for the same user)
  IF existing_user.id IS NOT NULL THEN
    UPDATE public.app_user_google_links
      SET unlinked_at = NULL, google_email = p_google_email, email_verified = true, updated_at = p_activation_time
      WHERE id = existing_user.id;
  ELSE
    INSERT INTO public.app_user_google_links(user_id, google_sub, google_email, email_verified, linked_at, created_at, updated_at)
      VALUES (p_user_id, p_google_sub, p_google_email, true, p_activation_time, p_activation_time, p_activation_time);
  END IF;

  -- If eligible for bonus (pre-rollout account AND bonus not yet claimed): grant 7-day bonus
  IF v_is_pre_rollout AND NOT v_bonus_already_claimed THEN
    -- Check for currently active trial
    SELECT * INTO active_trial FROM public.user_entitlements
      WHERE user_id = p_user_id AND source = 'trial' AND status = 'active'
        AND starts_at <= p_activation_time AND expires_at > p_activation_time
      ORDER BY expires_at DESC LIMIT 1;

    IF FOUND THEN
      v_bonus_start := active_trial.expires_at;
    ELSE
      v_bonus_start := p_activation_time;
    END IF;
    v_bonus_expiry := v_bonus_start + interval '7 days';

    INSERT INTO public.user_entitlements(user_id, source, trial_kind, status, starts_at, expires_at, lifetime, activation_idempotency_key, created_at, updated_at)
      VALUES (p_user_id, 'trial', 'google_link_bonus', 'active', v_bonus_start, v_bonus_expiry, false, p_idempotency_key, p_activation_time, p_activation_time)
      RETURNING * INTO bonus_ent;

    UPDATE public.app_user_google_links
      SET bonus_granted_at = p_activation_time, updated_at = p_activation_time
      WHERE user_id = p_user_id AND google_sub = p_google_sub;

    INSERT INTO public.subscription_events(user_id, entitlement_id, event_type, metadata)
      VALUES (p_user_id, bonus_ent.id, 'subscription_google_link_bonus_granted', jsonb_build_object('duration_days', 7, 'starts_at', v_bonus_start, 'expires_at', v_bonus_expiry, 'google_sub', p_google_sub));

    RETURN jsonb_build_object(
      'success', true,
      'linked', true,
      'bonus_granted', true,
      'starts_at', v_bonus_start,
      'expires_at', v_bonus_expiry,
      'duration_days', 7,
      'google_sub', p_google_sub,
      'pre_rollout_eligible', true
    );
  ELSE
    RETURN jsonb_build_object(
      'success', true,
      'linked', true,
      'bonus_granted', false,
      'already_claimed', v_bonus_already_claimed,
      'pre_rollout_eligible', v_is_pre_rollout,
      'google_sub', p_google_sub
    );
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.link_google_identity_and_grant_bonus(uuid,text,text,boolean,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_google_identity_and_grant_bonus(uuid,text,text,boolean,text,timestamptz) TO service_role;
