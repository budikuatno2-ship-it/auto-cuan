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
ALTER TABLE public.subscription_plan_prices ADD COLUMN IF NOT EXISTS publication_submission_id text UNIQUE;
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
BEGIN
  -- Price facts are append-only, but atomic publication must retire exactly the
  -- prior active version. No price, duration, actor, or audit field can change.
  IF TG_TABLE_NAME = 'subscription_plan_prices' AND OLD.active = true AND NEW.active = false
     AND NEW.plan_code = OLD.plan_code AND NEW.normal_price_idr = OLD.normal_price_idr
     AND NEW.promo_price_idr IS NOT DISTINCT FROM OLD.promo_price_idr
     AND NEW.promo_enabled = OLD.promo_enabled AND NEW.promo_starts_at IS NOT DISTINCT FROM OLD.promo_starts_at
     AND NEW.promo_ends_at IS NOT DISTINCT FROM OLD.promo_ends_at AND NEW.price_version = OLD.price_version
     AND NEW.created_by_user_id IS NOT DISTINCT FROM OLD.created_by_user_id AND NEW.change_reason = OLD.change_reason
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'subscription plans and price versions are immutable';
END $$;
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

-- Atomic, append-only catalog publication. It is deliberately callable only
-- with the service-role credential; the API derives actor identity from its
-- signed session and never accepts browser actor/timestamp authority.
CREATE OR REPLACE FUNCTION public.publish_subscription_plan_price(p_plan_code text, p_normal_price_idr bigint, p_promo_price_idr bigint, p_promo_enabled boolean, p_promo_starts_at timestamptz, p_promo_ends_at timestamptz, p_actor_user_id uuid, p_change_reason text, p_submission_id text)
RETURNS TABLE(plan_code text, price_version integer, already_published boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_plan public.subscription_plans%ROWTYPE; v_old public.subscription_plan_prices%ROWTYPE; v_version integer; v_event text;
BEGIN
  IF p_plan_code NOT IN ('PREMIUM_1_MONTH','PREMIUM_2_MONTHS','PREMIUM_3_MONTHS','LIFETIME') OR p_normal_price_idr <= 0 OR p_normal_price_idr IS NULL OR p_change_reason IS NULL OR length(btrim(p_change_reason)) = 0 OR length(p_change_reason) > 240 OR p_submission_id !~ '^[A-Za-z0-9_-]{16,80}$' THEN RAISE EXCEPTION 'invalid catalog publication'; END IF;
  IF p_promo_enabled AND (p_promo_price_idr IS NULL OR p_promo_price_idr <= 0 OR p_promo_starts_at IS NULL) THEN RAISE EXCEPTION 'invalid promotion'; END IF;
  IF p_promo_ends_at IS NOT NULL AND (p_promo_starts_at IS NULL OR p_promo_ends_at <= p_promo_starts_at) THEN RAISE EXCEPTION 'invalid promotion boundary'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('subscription-price:' || p_plan_code, 0));
  SELECT * INTO v_old FROM public.subscription_plan_prices WHERE publication_submission_id=p_submission_id;
  IF FOUND THEN RETURN QUERY SELECT v_old.plan_code, v_old.price_version, true; RETURN; END IF;
  SELECT * INTO v_plan FROM public.subscription_plans WHERE code=p_plan_code FOR UPDATE;
  IF NOT FOUND OR NOT v_plan.active THEN RAISE EXCEPTION 'plan unavailable'; END IF;
  SELECT * INTO v_old FROM public.subscription_plan_prices WHERE plan_code=p_plan_code AND active FOR UPDATE;
  v_version := COALESCE(v_old.price_version, 0) + 1;
  IF FOUND THEN UPDATE public.subscription_plan_prices SET active=false WHERE id=v_old.id; END IF;
  INSERT INTO public.subscription_plan_prices(plan_code,normal_price_idr,promo_price_idr,promo_enabled,promo_starts_at,promo_ends_at,active,price_version,created_by_user_id,change_reason,publication_submission_id) VALUES (p_plan_code,p_normal_price_idr,CASE WHEN p_promo_enabled THEN p_promo_price_idr ELSE NULL END,p_promo_enabled,CASE WHEN p_promo_enabled THEN p_promo_starts_at ELSE NULL END,CASE WHEN p_promo_enabled THEN p_promo_ends_at ELSE NULL END,true,v_version,p_actor_user_id,btrim(p_change_reason),p_submission_id);
  v_event := CASE WHEN p_promo_enabled AND COALESCE(v_old.promo_enabled,false)=false THEN 'plan_promo_enabled' WHEN NOT p_promo_enabled AND COALESCE(v_old.promo_enabled,false)=true THEN 'plan_promo_disabled' ELSE 'plan_price_version_published' END;
  INSERT INTO public.subscription_events(event_type,actor_user_id,metadata) VALUES (v_event,p_actor_user_id,jsonb_strip_nulls(jsonb_build_object('plan_code',p_plan_code,'previous_price_version',v_old.price_version,'new_price_version',v_version,'previous_normal_price_idr',v_old.normal_price_idr,'new_normal_price_idr',p_normal_price_idr,'previous_promo_price_idr',v_old.promo_price_idr,'new_promo_price_idr',CASE WHEN p_promo_enabled THEN p_promo_price_idr ELSE NULL END,'previous_promo_enabled',COALESCE(v_old.promo_enabled,false),'new_promo_enabled',p_promo_enabled,'promo_starts_at',CASE WHEN p_promo_enabled THEN p_promo_starts_at ELSE NULL END,'promo_ends_at',CASE WHEN p_promo_enabled THEN p_promo_ends_at ELSE NULL END,'change_reason',btrim(p_change_reason))));
  RETURN QUERY SELECT p_plan_code,v_version,false;
END $$;
REVOKE ALL ON FUNCTION public.publish_subscription_plan_price(text,bigint,bigint,boolean,timestamptz,timestamptz,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_subscription_plan_price(text,bigint,bigint,boolean,timestamptz,timestamptz,uuid,text,text) TO service_role;

-- Phase 4: protected email identity and separate subscription Telegram linking.
-- ADDITIVE ONLY. This file is intentionally unapplied by application code.
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS email text, ADD COLUMN IF NOT EXISTS email_normalized text,
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz, ADD COLUMN IF NOT EXISTS email_verification_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_updated_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_users_verified_email ON public.app_users(email_normalized) WHERE email_verified_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.email_otp_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.app_users(id), email_normalized text NOT NULL,
 otp_hash text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, revoked_at timestamptz, attempt_count integer NOT NULL DEFAULT 0,
 locked_until timestamptz, delivery_state text NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','sent','unavailable','failed')),
 delivery_attempts integer NOT NULL DEFAULT 0, request_id text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_email_otp_per_user ON public.email_otp_challenges(user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_email_otp_per_email ON public.email_otp_challenges(email_normalized) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS public.telegram_subscription_links (
 user_id uuid PRIMARY KEY REFERENCES public.app_users(id), telegram_user_id bigint UNIQUE, telegram_private_chat_id bigint,
 link_state text NOT NULL DEFAULT 'unlinked' CHECK (link_state IN ('linked','unlinked')), linked_at timestamptz, unlinked_at timestamptz,
 trial_ever_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.telegram_subscription_link_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.app_users(id), token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, used_at timestamptz, revoked_at timestamptz, request_id text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_subscription_link_token ON public.telegram_subscription_link_tokens(user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS public.telegram_subscription_webhook_updates (update_id bigint PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.email_otp_challenges ENABLE ROW LEVEL SECURITY; ALTER TABLE public.telegram_subscription_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_subscription_link_tokens ENABLE ROW LEVEL SECURITY; ALTER TABLE public.telegram_subscription_webhook_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_otp_challenges, public.telegram_subscription_links, public.telegram_subscription_link_tokens, public.telegram_subscription_webhook_updates FROM anon, authenticated;

-- Fixed-search-path RPC: atomically consumes a hashed token and enforces both
-- legacy and subscription Telegram uniqueness. It does not grant entitlements.
CREATE OR REPLACE FUNCTION public.consume_subscription_telegram_link(p_token_hash text, p_telegram_user_id bigint, p_chat_id bigint, p_update_id bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.telegram_subscription_link_tokens%ROWTYPE; legacy_user uuid;
BEGIN
 IF p_token_hash IS NULL OR p_telegram_user_id IS NULL OR p_chat_id IS NULL OR p_update_id IS NULL THEN RETURN 'rejected'; END IF;
 INSERT INTO public.telegram_subscription_webhook_updates(update_id) VALUES(p_update_id) ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN 'duplicate'; END IF;
 SELECT * INTO t FROM public.telegram_subscription_link_tokens WHERE token_hash=p_token_hash FOR UPDATE;
 IF NOT FOUND OR t.used_at IS NOT NULL OR t.revoked_at IS NOT NULL OR t.expires_at <= now() THEN RETURN 'rejected'; END IF;
 SELECT user_id INTO legacy_user FROM public.app_user_telegram_verifications WHERE telegram_user_id=p_telegram_user_id AND telegram_verified_at IS NOT NULL;
 IF legacy_user IS NOT NULL AND legacy_user <> t.user_id THEN RETURN 'rejected'; END IF;
 IF EXISTS (SELECT 1 FROM public.app_user_telegram_verifications WHERE user_id=t.user_id AND telegram_verified_at IS NOT NULL AND telegram_user_id <> p_telegram_user_id) THEN RETURN 'rejected'; END IF;
 IF EXISTS (SELECT 1 FROM public.telegram_subscription_links WHERE telegram_user_id=p_telegram_user_id AND user_id <> t.user_id AND link_state='linked') THEN RETURN 'rejected'; END IF;
 UPDATE public.telegram_subscription_link_tokens SET used_at=now() WHERE id=t.id;
 INSERT INTO public.telegram_subscription_links(user_id,telegram_user_id,telegram_private_chat_id,link_state,linked_at,updated_at) VALUES(t.user_id,p_telegram_user_id,p_chat_id,'linked',now(),now())
 ON CONFLICT(user_id) DO UPDATE SET telegram_user_id=EXCLUDED.telegram_user_id,telegram_private_chat_id=EXCLUDED.telegram_private_chat_id,link_state='linked',linked_at=now(),unlinked_at=NULL,updated_at=now();
 INSERT INTO public.subscription_events(user_id,event_type,metadata) VALUES(t.user_id,'subscription_telegram_linked',jsonb_build_object('telegram_user_id',p_telegram_user_id));
 RETURN 'linked';
END $$;
REVOKE ALL ON FUNCTION public.consume_subscription_telegram_link(text,bigint,bigint,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_subscription_telegram_link(text,bigint,bigint,bigint) TO service_role;
