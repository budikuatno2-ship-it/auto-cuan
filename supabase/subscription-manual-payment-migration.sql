-- Manual bank-transfer subscription review flow.
-- ADDITIVE ONLY. Apply deliberately with the database deployment process.
BEGIN;

CREATE TABLE IF NOT EXISTS public.subscription_payment_settings (
  singleton_key text PRIMARY KEY DEFAULT 'bank_transfer' CHECK (singleton_key = 'bank_transfer'),
  bank_name text NOT NULL,
  account_number text NOT NULL,
  account_holder text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.subscription_manual_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_reference text UNIQUE NOT NULL CHECK (payment_reference ~ '^PAY-[A-F0-9]{12}$'),
  request_idempotency_key uuid UNIQUE NOT NULL,
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  plan_code text NOT NULL REFERENCES public.subscription_plans(code),
  price_idr bigint NOT NULL CHECK (price_idr >= 0),
  voucher_id uuid REFERENCES public.subscription_vouchers(id),
  voucher_code_hint text,
  discount_percent integer CHECK (discount_percent IN (30,50) OR discount_percent IS NULL),
  amount_due_idr bigint NOT NULL CHECK (amount_due_idr >= 0),
  status text NOT NULL DEFAULT 'awaiting_transfer' CHECK (status IN ('awaiting_transfer','submitted','approved','rejected','cancelled')),
  transfer_sender_name text,
  transfer_note text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by_user_id uuid REFERENCES public.app_users(id),
  entitlement_id uuid REFERENCES public.user_entitlements(id),
  admin_telegram_message_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_manual_payments_user_time
  ON public.subscription_manual_payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_manual_payments_status_time
  ON public.subscription_manual_payments(status, created_at DESC);

ALTER TABLE public.subscription_payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_manual_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.subscription_payment_settings, public.subscription_manual_payments FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_manual_subscription_payment(
  p_user_id uuid,
  p_plan_code text,
  p_voucher_code_hash text,
  p_request_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  u public.app_users%ROWTYPE;
  p public.subscription_plans%ROWTYPE;
  pr public.subscription_plan_prices%ROWTYPE;
  v public.subscription_vouchers%ROWTYPE;
  existing public.subscription_manual_payments%ROWTYPE;
  made public.subscription_manual_payments%ROWTYPE;
  effective_price bigint;
  discount integer;
BEGIN
  IF p_user_id IS NULL OR p_request_idempotency_key IS NULL OR p_plan_code NOT IN ('PREMIUM_1_MONTH','PREMIUM_2_MONTHS','PREMIUM_3_MONTHS','LIFETIME') THEN
    RAISE EXCEPTION 'payment unavailable';
  END IF;

  SELECT * INTO existing FROM public.subscription_manual_payments WHERE request_idempotency_key = p_request_idempotency_key;
  IF FOUND THEN
    IF existing.user_id <> p_user_id THEN RAISE EXCEPTION 'payment unavailable'; END IF;
    RETURN jsonb_build_object(
      'payment_reference', existing.payment_reference,
      'plan_code', existing.plan_code,
      'price_idr', existing.price_idr,
      'discount_percent', existing.discount_percent,
      'amount_due_idr', existing.amount_due_idr,
      'status', existing.status,
      'voucher_code_hint', existing.voucher_code_hint
    );
  END IF;

  SELECT * INTO u FROM public.app_users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR u.is_blocked THEN RAISE EXCEPTION 'payment unavailable'; END IF;

  SELECT * INTO p FROM public.subscription_plans WHERE code = p_plan_code AND active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment unavailable'; END IF;

  SELECT * INTO pr FROM public.subscription_plan_prices WHERE plan_code = p_plan_code AND active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment unavailable'; END IF;

  effective_price := CASE
    WHEN pr.promo_enabled = true
      AND pr.promo_price_idr IS NOT NULL
      AND pr.promo_starts_at IS NOT NULL
      AND pr.promo_starts_at <= now()
      AND (pr.promo_ends_at IS NULL OR now() < pr.promo_ends_at)
    THEN pr.promo_price_idr
    ELSE pr.normal_price_idr
  END;

  IF p_voucher_code_hash IS NOT NULL THEN
    SELECT * INTO v FROM public.subscription_vouchers WHERE code_hash = p_voucher_code_hash FOR UPDATE;
    IF NOT FOUND OR NOT v.active OR v.revoked_at IS NOT NULL OR v.redemption_count >= v.max_redemptions OR
       (v.expires_at IS NOT NULL AND v.expires_at <= now()) OR v.plan_code <> p_plan_code THEN
      RAISE EXCEPTION 'voucher unavailable';
    END IF;
    IF coalesce(v.voucher_type, CASE WHEN v.plan_code='LIFETIME' THEN 'LIFETIME' ELSE 'PERCENT_100' END) NOT IN ('PERCENT_30','PERCENT_50') THEN
      RAISE EXCEPTION 'voucher direct activation required';
    END IF;
    IF EXISTS (SELECT 1 FROM public.subscription_voucher_redemptions WHERE voucher_id = v.id AND user_id = p_user_id) THEN
      RAISE EXCEPTION 'voucher unavailable';
    END IF;
    discount := CASE v.voucher_type WHEN 'PERCENT_30' THEN 30 WHEN 'PERCENT_50' THEN 50 ELSE NULL END;
  END IF;

  INSERT INTO public.subscription_manual_payments(
    payment_reference, request_idempotency_key, user_id, plan_code, price_idr,
    voucher_id, voucher_code_hint, discount_percent, amount_due_idr
  ) VALUES (
    'PAY-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)),
    p_request_idempotency_key,
    p_user_id,
    p_plan_code,
    effective_price,
    CASE WHEN discount IS NULL THEN NULL ELSE v.id END,
    CASE WHEN discount IS NULL THEN NULL ELSE v.code_hint END,
    discount,
    CASE WHEN discount IS NULL THEN effective_price ELSE round(effective_price * (100 - discount) / 100.0)::bigint END
  ) RETURNING * INTO made;

  INSERT INTO public.subscription_events(user_id,event_type,metadata)
  VALUES (p_user_id,'manual_payment_created',jsonb_strip_nulls(jsonb_build_object(
    'payment_reference',made.payment_reference,'plan_code',made.plan_code,
    'price_idr',made.price_idr,'discount_percent',made.discount_percent,
    'amount_due_idr',made.amount_due_idr,'voucher_code_hint',made.voucher_code_hint
  )));

  RETURN jsonb_build_object(
    'payment_reference', made.payment_reference,
    'plan_code', made.plan_code,
    'price_idr', made.price_idr,
    'discount_percent', made.discount_percent,
    'amount_due_idr', made.amount_due_idr,
    'status', made.status,
    'voucher_code_hint', made.voucher_code_hint
  );
END $$;

CREATE OR REPLACE FUNCTION public.submit_manual_subscription_payment(
  p_user_id uuid,
  p_payment_reference text,
  p_transfer_sender_name text,
  p_transfer_note text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m public.subscription_manual_payments%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_payment_reference !~ '^PAY-[A-F0-9]{12}$' OR
     p_transfer_sender_name IS NULL OR length(btrim(p_transfer_sender_name)) < 2 OR length(p_transfer_sender_name) > 100 OR
     length(coalesce(p_transfer_note,'')) > 500 THEN
    RAISE EXCEPTION 'payment unavailable';
  END IF;
  SELECT * INTO m FROM public.subscription_manual_payments WHERE payment_reference=p_payment_reference AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment unavailable'; END IF;
  IF m.status='submitted' THEN
    RETURN jsonb_build_object('payment_reference',m.payment_reference,'status',m.status,'submitted_at',m.submitted_at);
  END IF;
  IF m.status <> 'awaiting_transfer' THEN RAISE EXCEPTION 'payment unavailable'; END IF;
  UPDATE public.subscription_manual_payments
  SET status='submitted', transfer_sender_name=btrim(p_transfer_sender_name), transfer_note=nullif(btrim(coalesce(p_transfer_note,'')),''), submitted_at=now(), updated_at=now()
  WHERE id=m.id RETURNING * INTO m;
  INSERT INTO public.subscription_events(user_id,event_type,metadata)
  VALUES (m.user_id,'manual_payment_submitted',jsonb_build_object('payment_reference',m.payment_reference,'plan_code',m.plan_code,'amount_due_idr',m.amount_due_idr));
  RETURN jsonb_build_object('payment_reference',m.payment_reference,'status',m.status,'submitted_at',m.submitted_at);
END $$;

CREATE OR REPLACE FUNCTION public.review_manual_subscription_payment(
  p_payment_reference text,
  p_admin_telegram_user_id bigint,
  p_decision text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  m public.subscription_manual_payments%ROWTYPE;
  v public.subscription_vouchers%ROWTYPE;
  e public.user_entitlements%ROWTYPE;
  admin_id uuid;
  starts timestamptz;
  expiry timestamptz;
BEGIN
  IF p_admin_telegram_user_id <> 6396446903 OR p_payment_reference !~ '^PAY-[A-F0-9]{12}$' OR p_decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'payment unavailable';
  END IF;
  SELECT id INTO admin_id FROM public.app_users WHERE lower(username)='budi';
  IF admin_id IS NULL THEN RAISE EXCEPTION 'payment unavailable'; END IF;
  SELECT * INTO m FROM public.subscription_manual_payments WHERE payment_reference=p_payment_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment unavailable'; END IF;
  IF m.status IN ('approved','rejected') THEN
    RETURN jsonb_build_object('payment_reference',m.payment_reference,'status',m.status,'entitlement_id',m.entitlement_id,'already_reviewed',true);
  END IF;
  IF m.status <> 'submitted' THEN RAISE EXCEPTION 'payment unavailable'; END IF;

  IF p_decision='reject' THEN
    UPDATE public.subscription_manual_payments SET status='rejected',reviewed_at=now(),reviewed_by_user_id=admin_id,updated_at=now() WHERE id=m.id RETURNING * INTO m;
    INSERT INTO public.subscription_events(user_id,event_type,actor_user_id,metadata)
      VALUES(m.user_id,'manual_payment_rejected',admin_id,jsonb_build_object('payment_reference',m.payment_reference,'plan_code',m.plan_code,'amount_due_idr',m.amount_due_idr));
    RETURN jsonb_build_object('payment_reference',m.payment_reference,'status','rejected');
  END IF;

  IF m.voucher_id IS NOT NULL THEN
    SELECT * INTO v FROM public.subscription_vouchers WHERE id=m.voucher_id FOR UPDATE;
    IF NOT FOUND OR NOT v.active OR v.revoked_at IS NOT NULL OR v.redemption_count>=v.max_redemptions OR
       (v.expires_at IS NOT NULL AND v.expires_at<=now()) OR v.plan_code<>m.plan_code OR
       v.voucher_type NOT IN ('PERCENT_30','PERCENT_50') THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
    IF EXISTS(SELECT 1 FROM public.subscription_voucher_redemptions WHERE voucher_id=v.id AND user_id=m.user_id) THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  END IF;

  starts:=now();
  expiry:=CASE m.plan_code
    WHEN 'LIFETIME' THEN NULL
    WHEN 'PREMIUM_1_MONTH' THEN starts + make_interval(months=>1)
    WHEN 'PREMIUM_2_MONTHS' THEN starts + make_interval(months=>2)
    WHEN 'PREMIUM_3_MONTHS' THEN starts + make_interval(months=>3)
    ELSE NULL END;

  INSERT INTO public.user_entitlements(user_id,plan_code,source,status,starts_at,expires_at,lifetime,source_reference,activation_idempotency_key)
  VALUES(m.user_id,m.plan_code,'payment','active',starts,expiry,(m.plan_code='LIFETIME'),m.id::text,'manual-payment:'||m.id::text)
  RETURNING * INTO e;

  IF m.voucher_id IS NOT NULL THEN
    INSERT INTO public.subscription_voucher_redemptions(voucher_id,user_id,entitlement_id,redemption_idempotency_key)
      VALUES(m.voucher_id,m.user_id,e.id,m.id);
    UPDATE public.subscription_vouchers SET redemption_count=redemption_count+1 WHERE id=m.voucher_id;
    INSERT INTO public.subscription_events(user_id,entitlement_id,event_type,actor_user_id,metadata)
      VALUES(m.user_id,e.id,'voucher_redeemed_after_payment',admin_id,jsonb_build_object('voucher_code_hint',m.voucher_code_hint,'plan_code',m.plan_code,'payment_reference',m.payment_reference));
  END IF;

  UPDATE public.app_users SET is_approved=true WHERE id=m.user_id AND is_approved=false;
  UPDATE public.subscription_manual_payments SET status='approved',reviewed_at=now(),reviewed_by_user_id=admin_id,entitlement_id=e.id,updated_at=now() WHERE id=m.id RETURNING * INTO m;
  INSERT INTO public.subscription_events(user_id,entitlement_id,event_type,actor_user_id,metadata)
    VALUES(m.user_id,e.id,'manual_payment_approved',admin_id,jsonb_build_object('payment_reference',m.payment_reference,'plan_code',m.plan_code,'amount_due_idr',m.amount_due_idr,'expires_at',expiry,'lifetime',(m.plan_code='LIFETIME')));

  RETURN jsonb_build_object('payment_reference',m.payment_reference,'status','approved','entitlement_id',e.id,'plan_code',m.plan_code,'starts_at',starts,'expires_at',expiry,'lifetime',(m.plan_code='LIFETIME'),'voucher_code_hint',m.voucher_code_hint);
END $$;

REVOKE ALL ON FUNCTION public.create_manual_subscription_payment(uuid,text,text,uuid),
  public.submit_manual_subscription_payment(uuid,text,text,text),
  public.review_manual_subscription_payment(text,bigint,text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_manual_subscription_payment(uuid,text,text,uuid),
  public.submit_manual_subscription_payment(uuid,text,text,text),
  public.review_manual_subscription_payment(text,bigint,text)
TO service_role;

COMMIT;
