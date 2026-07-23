-- Phase 2 subscription storage. ADDITIVE ONLY; apply deliberately, never from app code.
-- Trial duration is exactly interval '10 days' (240 hours), with [starts_at, expires_at).
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  code text PRIMARY KEY CHECK (code IN ('PREMIUM_1_MONTH','PREMIUM_2_MONTHS','PREMIUM_3_MONTHS','LIFETIME')),
  display_name text NOT NULL, kind text NOT NULL CHECK (kind IN ('term','lifetime')),
  duration_months integer CHECK ((kind = 'term' AND duration_months IN (1,2,3)) OR (kind = 'lifetime' AND duration_months IS NULL)),
  active boolean NOT NULL DEFAULT true, sort_order integer NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.subscription_plan_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_code text NOT NULL REFERENCES public.subscription_plans(code),
  normal_price_idr bigint NOT NULL CHECK (normal_price_idr >= 0), promo_price_idr bigint CHECK (promo_price_idr >= 0),
  promo_enabled boolean NOT NULL DEFAULT false, promo_starts_at timestamptz, promo_ends_at timestamptz,
  active boolean NOT NULL DEFAULT true, price_version integer NOT NULL CHECK (price_version > 0), created_by_user_id uuid REFERENCES public.app_users(id),
  change_reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((promo_enabled = false) OR (promo_price_idr IS NOT NULL AND promo_starts_at IS NOT NULL)),
  CHECK (promo_ends_at IS NULL OR promo_starts_at IS NULL OR promo_ends_at > promo_starts_at), UNIQUE(plan_code, price_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_active_price ON public.subscription_plan_prices(plan_code) WHERE active;
CREATE TABLE IF NOT EXISTS public.user_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.app_users(id),
  plan_code text REFERENCES public.subscription_plans(code), source text NOT NULL CHECK (source IN ('trial','payment','voucher','admin')),
  status text NOT NULL CHECK (status IN ('active','expired','revoked','refunded','chargeback')),
  starts_at timestamptz NOT NULL, expires_at timestamptz, lifetime boolean NOT NULL DEFAULT false,
  source_reference text, activation_idempotency_key text NOT NULL, revoked_at timestamptz, revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lifetime AND expires_at IS NULL) OR (NOT lifetime AND expires_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > starts_at),
  CHECK ((source <> 'trial') OR (lifetime = false AND plan_code IS NULL AND expires_at = starts_at + interval '10 days'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_entitlement_activation_key ON public.user_entitlements(activation_idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_trial_per_web_user ON public.user_entitlements(user_id) WHERE source = 'trial';
CREATE INDEX IF NOT EXISTS idx_entitlements_resolution ON public.user_entitlements(user_id, status, starts_at, expires_at);
-- Permanent trial identity reservation for Telegram. This is intentionally not
-- tied to a deletable web account, so a Telegram ID cannot receive a second trial.
CREATE TABLE IF NOT EXISTS public.subscription_trial_telegram_users (
  telegram_user_id bigint PRIMARY KEY, entitlement_id uuid NOT NULL UNIQUE REFERENCES public.user_entitlements(id),
  claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.lifetime_seat_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seat_number integer NOT NULL CHECK (seat_number BETWEEN 1 AND 7),
  entitlement_id uuid NOT NULL UNIQUE REFERENCES public.user_entitlements(id), allocation_source text NOT NULL CHECK (allocation_source IN ('payment','voucher','admin')),
  allocated_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz, release_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lifetime_active_seat ON public.lifetime_seat_ledger(seat_number) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS public.subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES public.app_users(id), entitlement_id uuid REFERENCES public.user_entitlements(id),
  event_type text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), actor_user_id uuid REFERENCES public.app_users(id), metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_subscription_events_user_time ON public.subscription_events(user_id, occurred_at DESC);

-- Catalog seed; prices remain versioned configuration, not frontend rules.
INSERT INTO public.subscription_plans (code,display_name,kind,duration_months,sort_order) VALUES
 ('PREMIUM_1_MONTH','Premium 1 Month','term',1,1),('PREMIUM_2_MONTHS','Premium 2 Months','term',2,2),('PREMIUM_3_MONTHS','Premium 3 Months','term',3,3),('LIFETIME','Lifetime','lifetime',NULL,4) ON CONFLICT (code) DO NOTHING;
INSERT INTO public.subscription_plan_prices (plan_code,normal_price_idr,promo_price_idr,promo_enabled,promo_starts_at,active,price_version,change_reason) VALUES
 ('PREMIUM_1_MONTH',100000,35000,true,now(),true,1,'launch'),('PREMIUM_2_MONTHS',170000,80000,true,now(),true,1,'launch'),('PREMIUM_3_MONTHS',299000,100000,true,now(),true,1,'launch'),('LIFETIME',500000,NULL,false,NULL,true,1,'launch') ON CONFLICT (plan_code,price_version) DO NOTHING;

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plan_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lifetime_seat_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_trial_telegram_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_plans, public.subscription_plan_prices, public.user_entitlements,
  public.lifetime_seat_ledger, public.subscription_events, public.subscription_trial_telegram_users FROM anon, authenticated;
-- Product identity and price versions are append-only configuration. Operational
-- code may deactivate a plan/price by inserting a replacement version, never
-- rewrite identity or money after publication.
CREATE OR REPLACE FUNCTION public.reject_subscription_identity_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'subscription plans and price versions are immutable'; END $$;
CREATE TRIGGER subscription_plans_immutable BEFORE UPDATE OR DELETE ON public.subscription_plans
  FOR EACH ROW EXECUTE FUNCTION public.reject_subscription_identity_update();
CREATE TRIGGER subscription_plan_prices_immutable BEFORE UPDATE OR DELETE ON public.subscription_plan_prices
  FOR EACH ROW EXECUTE FUNCTION public.reject_subscription_identity_update();
CREATE OR REPLACE FUNCTION public.allocate_lifetime_seat(p_entitlement_id uuid, p_source text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_seat integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('lifetime-seat-ledger', 0));
  SELECT s INTO v_seat FROM generate_series(1,7) s WHERE NOT EXISTS (SELECT 1 FROM public.lifetime_seat_ledger l WHERE l.seat_number=s AND l.released_at IS NULL) ORDER BY s LIMIT 1;
  IF v_seat IS NULL THEN RAISE EXCEPTION 'lifetime seats exhausted' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.lifetime_seat_ledger(seat_number,entitlement_id,allocation_source) VALUES (v_seat,p_entitlement_id,p_source);
  RETURN v_seat;
END $$;
REVOKE ALL ON FUNCTION public.allocate_lifetime_seat(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_subscription_identity_update() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_lifetime_seat(uuid,text) TO service_role;
