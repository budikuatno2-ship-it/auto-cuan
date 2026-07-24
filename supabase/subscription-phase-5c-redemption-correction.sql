-- Phase 5C voucher-redemption correction. UNAPPLIED; service role only.
-- Apply after subscription-phase-2-migration.sql and the Phase 5C voucher schema.
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
  p public.subscription_plans%ROWTYPE;
  e public.user_entitlements%ROWTYPE;
  r public.subscription_voucher_redemptions%ROWTYPE;
  existing_hash text;
  carry_expiry timestamptz;
  starts timestamptz;
  expiry timestamptz;
  affected integer;
BEGIN
  IF p_user_id IS NULL OR p_voucher_code_hash IS NULL OR p_redemption_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'invalid redemption';
  END IF;

  -- Serialize the idempotency key across users as well as within one account.
  PERFORM pg_advisory_xact_lock(hashtextextended('voucher-redemption:' || p_redemption_idempotency_key::text, 0));

  SELECT * INTO r
  FROM public.subscription_voucher_redemptions
  WHERE redemption_idempotency_key = p_redemption_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    SELECT code_hash INTO existing_hash FROM public.subscription_vouchers WHERE id = r.voucher_id;
    SELECT * INTO e FROM public.user_entitlements WHERE id = r.entitlement_id;
    IF r.user_id IS DISTINCT FROM p_user_id OR existing_hash IS DISTINCT FROM p_voucher_code_hash OR e.id IS NULL THEN
      RAISE EXCEPTION 'invalid redemption';
    END IF;
    RETURN jsonb_build_object(
      'redeemed', true,
      'result_code', 'already_redeemed',
      'entitlement_id', e.id,
      'plan_code', e.plan_code,
      'starts_at', e.starts_at,
      'expires_at', e.expires_at,
      'lifetime', e.lifetime
    );
  END IF;

  -- The user row is the per-account serialization lock for entitlement stacking.
  SELECT * INTO u FROM public.app_users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR u.is_blocked THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  SELECT * INTO v FROM public.subscription_vouchers WHERE code_hash = p_voucher_code_hash FOR UPDATE;
  IF NOT FOUND OR NOT v.active OR v.revoked_at IS NOT NULL OR v.redemption_count >= v.max_redemptions OR (v.expires_at IS NOT NULL AND v.expires_at <= now()) THEN
    RAISE EXCEPTION 'voucher unavailable';
  END IF;
  IF coalesce(v.voucher_type, 'PERCENT_100') IN ('PERCENT_30','PERCENT_50') THEN
    RAISE EXCEPTION 'voucher requires payment';
  END IF;
  IF EXISTS (SELECT 1 FROM public.subscription_voucher_redemptions WHERE voucher_id = v.id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'already redeemed';
  END IF;

  SELECT * INTO p FROM public.subscription_plans WHERE code = v.plan_code;
  IF NOT FOUND OR NOT p.active THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  -- Lifetime access is terminal: do not consume either lifetime or term vouchers.
  IF EXISTS (
    SELECT 1 FROM public.user_entitlements
    WHERE user_id = p_user_id AND lifetime = true AND status = 'active' AND starts_at <= now()
  ) THEN
    IF p.kind = 'lifetime' THEN
      RETURN jsonb_build_object(
        'redeemed', true,
        'result_code', 'already_lifetime',
        'plan_code', 'LIFETIME',
        'lifetime', true,
        'expires_at', NULL
      );
    END IF;
    RAISE EXCEPTION 'voucher unavailable';
  END IF;

  IF p.kind = 'lifetime' THEN
    starts := now();
    expiry := NULL;
  ELSE
    -- Preserve every remaining active term/trial day by stacking after the latest expiry.
    SELECT max(expires_at) INTO carry_expiry
    FROM public.user_entitlements
    WHERE user_id = p_user_id
      AND status = 'active'
      AND lifetime = false
      AND expires_at > now();
    starts := greatest(now(), coalesce(carry_expiry, now()));
    expiry := starts + make_interval(months => p.duration_months);
  END IF;

  INSERT INTO public.user_entitlements(
    user_id, plan_code, source, status, starts_at, expires_at, lifetime,
    source_reference, activation_idempotency_key
  ) VALUES (
    p_user_id, v.plan_code, 'voucher', 'active', starts, expiry, p.kind = 'lifetime',
    v.id::text, p_redemption_idempotency_key::text
  ) RETURNING * INTO e;

  INSERT INTO public.subscription_voucher_redemptions(
    voucher_id, user_id, entitlement_id, redemption_idempotency_key
  ) VALUES (v.id, p_user_id, e.id, p_redemption_idempotency_key)
  RETURNING * INTO r;

  UPDATE public.subscription_vouchers
  SET redemption_count = redemption_count + 1
  WHERE id = v.id
    AND active = true
    AND revoked_at IS NULL
    AND redemption_count < max_redemptions;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  INSERT INTO public.subscription_events(user_id, entitlement_id, event_type, metadata)
  VALUES (
    p_user_id,
    e.id,
    'voucher_redeemed',
    jsonb_build_object(
      'voucher_code_hint', v.code_hint,
      'plan_code', v.plan_code,
      'duration_days', v.duration_days,
      'duration_months', p.duration_months,
      'result_code', 'redeemed'
    )
  );

  RETURN jsonb_build_object(
    'redeemed', true,
    'result_code', 'redeemed',
    'entitlement_id', e.id,
    'plan_code', v.plan_code,
    'duration_days', v.duration_days,
    'duration_months', p.duration_months,
    'starts_at', starts,
    'expires_at', expiry,
    'lifetime', p.kind = 'lifetime'
  );
END
$$;

-- Direct foundation creation must not let duration_days contradict the immutable plan.
CREATE OR REPLACE FUNCTION public.create_subscription_voucher(
  p_voucher_code_hash text,
  p_voucher_code_hint text,
  p_plan_code text,
  p_duration_days integer,
  p_max_redemptions integer,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.subscription_vouchers%ROWTYPE;
  p public.subscription_plans%ROWTYPE;
  expected_days integer;
BEGIN
  SELECT * INTO p FROM public.subscription_plans WHERE code = p_plan_code AND active = true;
  expected_days := CASE p_plan_code
    WHEN 'PREMIUM_1_MONTH' THEN 30
    WHEN 'PREMIUM_2_MONTHS' THEN 60
    WHEN 'PREMIUM_3_MONTHS' THEN 90
    WHEN 'LIFETIME' THEN 1
    ELSE NULL
  END;

  IF p.id IS NULL
     OR p_voucher_code_hash !~ '^[a-f0-9]{64}$'
     OR p_voucher_code_hint !~ '^[A-Z0-9]{4}$'
     OR p_duration_days IS DISTINCT FROM expected_days
     OR p_max_redemptions NOT BETWEEN 1 AND 100000
  THEN
    RAISE EXCEPTION 'invalid voucher';
  END IF;

  INSERT INTO public.subscription_vouchers(
    code_hash, code_hint, plan_code, duration_days, max_redemptions, created_by_user_id
  ) VALUES (
    p_voucher_code_hash, p_voucher_code_hint, p_plan_code, p_duration_days, p_max_redemptions, p_actor_user_id
  ) RETURNING * INTO v;

  INSERT INTO public.subscription_events(actor_user_id, event_type, metadata)
  VALUES (
    p_actor_user_id,
    'voucher_created',
    jsonb_build_object(
      'voucher_code_hint', v.code_hint,
      'plan_code', v.plan_code,
      'duration_days', v.duration_days,
      'duration_months', p.duration_months
    )
  );

  RETURN jsonb_build_object('id', v.id, 'code_hint', v.code_hint);
END
$$;

REVOKE ALL ON FUNCTION public.redeem_subscription_voucher(uuid,text,uuid),
  public.create_subscription_voucher(text,text,text,integer,integer,uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_subscription_voucher(uuid,text,uuid),
  public.create_subscription_voucher(text,text,text,integer,integer,uuid)
TO service_role;

COMMIT;
