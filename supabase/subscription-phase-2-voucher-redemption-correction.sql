-- Phase 2 voucher redemption correction. UNAPPLIED; service role only.
-- Term access stacks from the latest active term expiry, while lifetime access
-- starts immediately and prevents any further voucher consumption.
BEGIN;

CREATE OR REPLACE FUNCTION public.redeem_subscription_voucher(
  p_user_id uuid,
  p_voucher_code_hash text,
  p_redemption_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.subscription_vouchers%ROWTYPE;
  u public.app_users%ROWTYPE;
  e public.user_entitlements%ROWTYPE;
  r public.subscription_voucher_redemptions%ROWTYPE;
  starts timestamptz;
  expiry timestamptz;
  active_term_expiry timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_voucher_code_hash IS NULL OR p_redemption_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'invalid redemption';
  END IF;

  SELECT * INTO r
  FROM public.subscription_voucher_redemptions
  WHERE redemption_idempotency_key = p_redemption_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('redeemed', true, 'entitlement_id', r.entitlement_id);
  END IF;

  SELECT * INTO u FROM public.app_users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR u.is_blocked THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  SELECT * INTO v FROM public.subscription_vouchers WHERE code_hash = p_voucher_code_hash FOR UPDATE;
  IF NOT FOUND OR NOT v.active OR v.revoked_at IS NOT NULL OR v.redemption_count >= v.max_redemptions
     OR (v.expires_at IS NOT NULL AND v.expires_at <= now()) THEN
    RAISE EXCEPTION 'voucher unavailable';
  END IF;
  IF coalesce(v.voucher_type, 'PERCENT_100') IN ('PERCENT_30','PERCENT_50') THEN
    RAISE EXCEPTION 'voucher requires payment';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.subscription_voucher_redemptions
    WHERE voucher_id = v.id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'already redeemed';
  END IF;

  -- Serialize all entitlement decisions for this user after the app-user row lock.
  PERFORM 1 FROM public.user_entitlements WHERE user_id = p_user_id FOR UPDATE;

  -- Lifetime is terminal: do not consume either a term or another lifetime voucher.
  IF EXISTS (
    SELECT 1 FROM public.user_entitlements
    WHERE user_id = p_user_id AND lifetime = true AND status = 'active'
  ) THEN
    RETURN jsonb_build_object(
      'redeemed', true,
      'result_code', 'already_lifetime',
      'plan_code', 'LIFETIME',
      'lifetime', true,
      'expires_at', NULL
    );
  END IF;

  IF v.plan_code = 'LIFETIME' THEN
    starts := now();
    expiry := NULL;
  ELSE
    SELECT max(expires_at) INTO active_term_expiry
    FROM public.user_entitlements
    WHERE user_id = p_user_id
      AND lifetime = false
      AND status = 'active'
      AND expires_at > now();

    starts := greatest(now(), coalesce(active_term_expiry, now()));
    expiry := CASE v.plan_code
      WHEN 'PREMIUM_1_MONTH' THEN starts + make_interval(months => 1)
      WHEN 'PREMIUM_2_MONTHS' THEN starts + make_interval(months => 2)
      WHEN 'PREMIUM_3_MONTHS' THEN starts + make_interval(months => 3)
      ELSE NULL
    END;
    IF expiry IS NULL THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  END IF;

  INSERT INTO public.user_entitlements(
    user_id, plan_code, source, status, starts_at, expires_at, lifetime,
    source_reference, activation_idempotency_key
  ) VALUES (
    p_user_id, v.plan_code, 'voucher', 'active', starts, expiry,
    (v.plan_code = 'LIFETIME'), v.id::text, p_redemption_idempotency_key::text
  ) RETURNING * INTO e;

  INSERT INTO public.subscription_voucher_redemptions(
    voucher_id, user_id, entitlement_id, redemption_idempotency_key
  ) VALUES (v.id, p_user_id, e.id, p_redemption_idempotency_key)
  RETURNING * INTO r;

  UPDATE public.subscription_vouchers
  SET redemption_count = redemption_count + 1
  WHERE id = v.id;

  INSERT INTO public.subscription_events(user_id, entitlement_id, event_type, metadata)
  VALUES (
    p_user_id,
    e.id,
    'voucher_redeemed',
    jsonb_build_object(
      'voucher_code_hint', v.code_hint,
      'plan_code', v.plan_code,
      'duration_days', v.duration_days,
      'result_code', 'redeemed'
    )
  );

  RETURN jsonb_build_object(
    'redeemed', true,
    'plan_code', v.plan_code,
    'duration_days', v.duration_days,
    'starts_at', starts,
    'expires_at', expiry,
    'lifetime', (v.plan_code = 'LIFETIME')
  );
END $$;

REVOKE ALL ON FUNCTION public.redeem_subscription_voucher(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_subscription_voucher(uuid,text,uuid) TO service_role;

COMMIT;
