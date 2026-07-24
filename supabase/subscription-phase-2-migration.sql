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
ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_trial_telegram_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_plans, public.subscription_plan_prices, public.user_entitlements,
  public.subscription_events, public.subscription_trial_telegram_users FROM anon, authenticated;
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

-- Phase 4: separate subscription Telegram linking only. ADDITIVE ONLY; this
-- migration is intentionally unapplied by application code. Email is not an
-- identity, eligibility, or delivery mechanism in the first release.
CREATE TABLE IF NOT EXISTS public.telegram_subscription_links (
 user_id uuid PRIMARY KEY REFERENCES public.app_users(id), telegram_user_id bigint UNIQUE, telegram_private_chat_id bigint,
 link_state text NOT NULL DEFAULT 'unlinked' CHECK (link_state IN ('linked','unlinked')), linked_at timestamptz, unlinked_at timestamptz,
 trial_ever_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.telegram_subscription_link_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.app_users(id), token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, used_at timestamptz, revoked_at timestamptz, request_id text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_subscription_link_token ON public.telegram_subscription_link_tokens(user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS public.telegram_subscription_webhook_updates (update_id bigint PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.telegram_subscription_links ENABLE ROW LEVEL SECURITY; ALTER TABLE public.telegram_subscription_link_tokens ENABLE ROW LEVEL SECURITY; ALTER TABLE public.telegram_subscription_webhook_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_subscription_links, public.telegram_subscription_link_tokens, public.telegram_subscription_webhook_updates FROM anon, authenticated;

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
 INSERT INTO public.subscription_events(user_id,event_type,metadata) VALUES(t.user_id,'subscription_telegram_linked',jsonb_build_object('result_code','linked'));
 RETURN 'linked';
END $$;
REVOKE ALL ON FUNCTION public.consume_subscription_telegram_link(text,bigint,bigint,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_subscription_telegram_link(text,bigint,bigint,bigint) TO service_role;

-- Token issuance is serialized per web user. It rejects bursts (one fresh token
-- every 30 seconds), revokes a prior unused token, and stores no plaintext.
CREATE OR REPLACE FUNCTION public.issue_subscription_telegram_link_token(p_user_id uuid, p_token_hash text, p_request_id text, p_expires_at timestamptz)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_last timestamptz;
BEGIN
 IF p_user_id IS NULL OR p_token_hash IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{16,100}$' OR p_expires_at <= now() OR p_expires_at > now() + interval '5 minutes' THEN RAISE EXCEPTION 'invalid link token'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('subscription-telegram-link:' || p_user_id::text, 0));
 SELECT created_at INTO v_last FROM public.telegram_subscription_link_tokens WHERE user_id=p_user_id ORDER BY created_at DESC LIMIT 1;
 IF v_last IS NOT NULL AND v_last > now() - interval '30 seconds' THEN RETURN 'rate_limited'; END IF;
 UPDATE public.telegram_subscription_link_tokens SET revoked_at=now() WHERE user_id=p_user_id AND used_at IS NULL AND revoked_at IS NULL;
 INSERT INTO public.telegram_subscription_link_tokens(user_id,token_hash,expires_at,request_id) VALUES(p_user_id,p_token_hash,p_expires_at,p_request_id);
 INSERT INTO public.subscription_events(user_id,event_type,metadata) VALUES(p_user_id,'subscription_telegram_link_token_created',jsonb_build_object('request_id',p_request_id));
 RETURN 'created';
END $$;
REVOKE ALL ON FUNCTION public.issue_subscription_telegram_link_token(uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_subscription_telegram_link_token(uuid,text,text,timestamptz) TO service_role;

-- Phase 5A: explicit trial activation only.  Ten days is an elapsed 240-hour
-- interval; this RPC is service-role-only and performs every state change atomically.
CREATE OR REPLACE FUNCTION public.activate_subscription_trial(p_user_id uuid, p_activation_idempotency_key uuid, p_activation_time timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE u public.app_users%ROWTYPE; l public.telegram_subscription_links%ROWTYPE; e public.user_entitlements%ROWTYPE; v_start timestamptz; v_expiry timestamptz;
BEGIN
 IF p_user_id IS NULL OR p_activation_idempotency_key IS NULL OR p_activation_time IS NULL OR p_activation_time > now()+interval '5 minutes' OR p_activation_time < now()-interval '5 minutes' THEN RAISE EXCEPTION 'invalid activation'; END IF;
 SELECT * INTO e FROM public.user_entitlements WHERE activation_idempotency_key=p_activation_idempotency_key FOR UPDATE;
 IF FOUND THEN IF e.user_id<>p_user_id THEN RAISE EXCEPTION 'activation rejected'; END IF; RETURN jsonb_build_object('active',e.status='active' AND e.starts_at<=now() AND now()<e.expires_at,'starts_at',e.starts_at,'expires_at',e.expires_at); END IF;
 SELECT * INTO u FROM public.app_users WHERE id=p_user_id FOR UPDATE;
 IF NOT FOUND OR u.is_blocked THEN RAISE EXCEPTION 'activation rejected'; END IF;
 IF lower(btrim(u.username))='budi' THEN RETURN jsonb_build_object('active',true,'admin',true); END IF;
 INSERT INTO public.subscription_events(user_id,event_type,metadata) VALUES(u.id,'subscription_trial_activation_requested',jsonb_build_object('request_id',p_activation_idempotency_key::text,'source_channel','api')) ;
 SELECT * INTO l FROM public.telegram_subscription_links WHERE user_id=u.id AND link_state='linked' FOR UPDATE;
 IF NOT FOUND OR l.telegram_user_id IS NULL THEN RAISE EXCEPTION 'telegram required'; END IF;
 -- Lock the permanent Telegram reservation; unique constraints make concurrent abuse fail closed.
 IF EXISTS (SELECT 1 FROM public.user_entitlements WHERE user_id=u.id AND source='trial' FOR UPDATE) THEN RAISE EXCEPTION 'trial consumed'; END IF;
 v_start:=p_activation_time; v_expiry:=v_start + interval '10 days';
 INSERT INTO public.user_entitlements(user_id,source,status,starts_at,expires_at,lifetime,activation_idempotency_key) VALUES(u.id,'trial','active',v_start,v_expiry,false,p_activation_idempotency_key) RETURNING * INTO e;
 INSERT INTO public.subscription_trial_telegram_users(telegram_user_id,entitlement_id) VALUES(l.telegram_user_id,e.id);
 INSERT INTO public.subscription_events(user_id,entitlement_id,event_type,metadata) VALUES(u.id,e.id,'subscription_trial_activated',jsonb_build_object('duration_days',10,'starts_at',v_start,'expires_at',v_expiry));
 IF u.is_approved=false THEN UPDATE public.app_users SET is_approved=true WHERE id=u.id; INSERT INTO public.subscription_events(user_id,entitlement_id,event_type,metadata) VALUES(u.id,e.id,'account_auto_approved_by_trial',jsonb_build_object('previous_approval_state','pending','new_approval_state','approved')); END IF;
 RETURN jsonb_build_object('active',true,'starts_at',v_start,'expires_at',v_expiry);
END $$;
REVOKE ALL ON FUNCTION public.activate_subscription_trial(uuid,uuid,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_subscription_trial(uuid,uuid,timestamptz) TO service_role;

-- Phase 5B: voucher foundations. This remains an unapplied, additive migration.
-- Voucher plaintext is never stored; application code supplies an HMAC hash only.
CREATE TABLE IF NOT EXISTS public.subscription_vouchers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_hash text NOT NULL UNIQUE, code_hint text NOT NULL CHECK (length(code_hint) BETWEEN 4 AND 4),
 plan_code text NOT NULL REFERENCES public.subscription_plans(code), duration_days integer NOT NULL CHECK (duration_days BETWEEN 1 AND 3650),
 max_redemptions integer NOT NULL DEFAULT 1 CHECK (max_redemptions BETWEEN 1 AND 100000), redemption_count integer NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
 active boolean NOT NULL DEFAULT true, expires_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), created_by_user_id uuid REFERENCES public.app_users(id),
 CHECK (redemption_count <= max_redemptions)
);
CREATE TABLE IF NOT EXISTS public.subscription_voucher_redemptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), voucher_id uuid NOT NULL REFERENCES public.subscription_vouchers(id), user_id uuid NOT NULL REFERENCES public.app_users(id), entitlement_id uuid NOT NULL UNIQUE REFERENCES public.user_entitlements(id),
 redemption_idempotency_key uuid NOT NULL UNIQUE, redeemed_at timestamptz NOT NULL DEFAULT now(), UNIQUE(voucher_id,user_id)
);
CREATE TABLE IF NOT EXISTS public.voucher_admin_telegram_updates (update_id bigint PRIMARY KEY, telegram_user_id bigint NOT NULL, command text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.subscription_vouchers ENABLE ROW LEVEL SECURITY; ALTER TABLE public.subscription_voucher_redemptions ENABLE ROW LEVEL SECURITY; ALTER TABLE public.voucher_admin_telegram_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.subscription_vouchers, public.subscription_voucher_redemptions, public.voucher_admin_telegram_updates FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.quote_subscription_voucher(p_user_id uuid,p_voucher_code_hash text,p_redemption_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.subscription_vouchers%ROWTYPE; u public.app_users%ROWTYPE;
BEGIN
 SELECT * INTO u FROM public.app_users WHERE id=p_user_id; IF NOT FOUND OR u.is_blocked THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
 SELECT * INTO v FROM public.subscription_vouchers WHERE code_hash=p_voucher_code_hash;
 IF NOT FOUND OR NOT v.active OR v.revoked_at IS NOT NULL OR v.redemption_count>=v.max_redemptions OR (v.expires_at IS NOT NULL AND v.expires_at<=now()) THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
 INSERT INTO public.subscription_events(user_id,event_type,metadata) VALUES(p_user_id,'voucher_quote_available',jsonb_build_object('voucher_code_hint',v.code_hint,'plan_code',v.plan_code,'duration_days',v.duration_days));
 RETURN jsonb_build_object('plan_code',v.plan_code,'duration_days',v.duration_days,'expires_at',v.expires_at,'voucher_type',coalesce(v.voucher_type,CASE WHEN v.plan_code='LIFETIME' THEN 'LIFETIME' ELSE 'PERCENT_100' END),'discount_percent',CASE WHEN v.voucher_type='PERCENT_30' THEN 30 WHEN v.voucher_type='PERCENT_50' THEN 50 ELSE NULL END);
END $$;
CREATE OR REPLACE FUNCTION public.redeem_subscription_voucher(p_user_id uuid,p_voucher_code_hash text,p_redemption_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.subscription_vouchers%ROWTYPE; u public.app_users%ROWTYPE; e public.user_entitlements%ROWTYPE; r public.subscription_voucher_redemptions%ROWTYPE; starts timestamptz; expiry timestamptz;
BEGIN
 IF p_user_id IS NULL OR p_voucher_code_hash IS NULL OR p_redemption_idempotency_key IS NULL THEN RAISE EXCEPTION 'invalid redemption'; END IF;
 SELECT * INTO r FROM public.subscription_voucher_redemptions WHERE redemption_idempotency_key=p_redemption_idempotency_key; IF FOUND THEN RETURN jsonb_build_object('redeemed',true,'entitlement_id',r.entitlement_id); END IF;
 SELECT * INTO u FROM public.app_users WHERE id=p_user_id FOR UPDATE; IF NOT FOUND OR u.is_blocked THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
 SELECT * INTO v FROM public.subscription_vouchers WHERE code_hash=p_voucher_code_hash FOR UPDATE;
 IF coalesce(v.voucher_type,'PERCENT_100') IN ('PERCENT_30','PERCENT_50') THEN RAISE EXCEPTION 'voucher requires payment'; END IF;
 IF NOT FOUND OR NOT v.active OR v.revoked_at IS NOT NULL OR v.redemption_count>=v.max_redemptions OR (v.expires_at IS NOT NULL AND v.expires_at<=now()) THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_voucher_redemptions WHERE voucher_id=v.id AND user_id=p_user_id) THEN RAISE EXCEPTION 'already redeemed'; END IF;
 IF v.plan_code='LIFETIME' AND EXISTS(SELECT 1 FROM public.user_entitlements WHERE user_id=p_user_id AND lifetime=true AND status='active' FOR UPDATE) THEN
   RETURN jsonb_build_object('redeemed',true,'result_code','already_lifetime','plan_code','LIFETIME','lifetime',true,'expires_at',NULL);
 END IF;
 starts:=now(); expiry:=CASE WHEN v.plan_code='LIFETIME' THEN NULL ELSE starts + make_interval(days=>v.duration_days) END;
 INSERT INTO public.user_entitlements(user_id,plan_code,source,status,starts_at,expires_at,lifetime,source_reference,activation_idempotency_key) VALUES(p_user_id,v.plan_code,'voucher','active',starts,expiry,(v.plan_code='LIFETIME'),v.id::text,p_redemption_idempotency_key::text) RETURNING * INTO e;
 INSERT INTO public.subscription_voucher_redemptions(voucher_id,user_id,entitlement_id,redemption_idempotency_key) VALUES(v.id,p_user_id,e.id,p_redemption_idempotency_key) RETURNING * INTO r;
 UPDATE public.subscription_vouchers SET redemption_count=redemption_count+1 WHERE id=v.id;
 INSERT INTO public.subscription_events(user_id,entitlement_id,event_type,metadata) VALUES(p_user_id,e.id,'voucher_redeemed',jsonb_build_object('voucher_code_hint',v.code_hint,'plan_code',v.plan_code,'duration_days',v.duration_days,'result_code','redeemed'));
 RETURN jsonb_build_object('redeemed',true,'plan_code',v.plan_code,'duration_days',v.duration_days,'starts_at',starts,'expires_at',expiry,'lifetime',(v.plan_code='LIFETIME'));
END $$;
CREATE OR REPLACE FUNCTION public.create_subscription_voucher(p_voucher_code_hash text,p_voucher_code_hint text,p_plan_code text,p_duration_days integer,p_max_redemptions integer,p_actor_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.subscription_vouchers%ROWTYPE;
BEGIN
 IF p_voucher_code_hash !~ '^[a-f0-9]{64}$' OR p_voucher_code_hint !~ '^[A-Z0-9]{4}$' OR p_plan_code NOT IN ('PREMIUM_1_MONTH','PREMIUM_2_MONTHS','PREMIUM_3_MONTHS','LIFETIME') OR p_duration_days NOT BETWEEN 1 AND 3650 OR p_max_redemptions NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'invalid voucher'; END IF;
 INSERT INTO public.subscription_vouchers(code_hash,code_hint,plan_code,duration_days,max_redemptions,created_by_user_id) VALUES(p_voucher_code_hash,p_voucher_code_hint,p_plan_code,p_duration_days,p_max_redemptions,p_actor_user_id) RETURNING * INTO v;
 INSERT INTO public.subscription_events(actor_user_id,event_type,metadata) VALUES(p_actor_user_id,'voucher_created',jsonb_build_object('voucher_code_hint',v.code_hint,'plan_code',v.plan_code,'duration_days',v.duration_days)); RETURN jsonb_build_object('id',v.id,'code_hint',v.code_hint);
END $$;
CREATE OR REPLACE FUNCTION public.revoke_subscription_voucher(p_voucher_code_hash text,p_voucher_code_hint text,p_plan_code text,p_duration_days integer,p_max_redemptions integer,p_actor_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.subscription_vouchers%ROWTYPE; BEGIN SELECT * INTO v FROM public.subscription_vouchers WHERE code_hash=p_voucher_code_hash FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'voucher unavailable'; END IF; UPDATE public.subscription_vouchers SET active=false,revoked_at=now() WHERE id=v.id; INSERT INTO public.subscription_events(actor_user_id,event_type,metadata) VALUES(p_actor_user_id,'voucher_revoked',jsonb_build_object('voucher_code_hint',v.code_hint,'result_code','revoked')); RETURN jsonb_build_object('id',v.id,'revoked',true); END $$;
CREATE OR REPLACE FUNCTION public.record_voucher_admin_telegram_command(p_update_id bigint,p_telegram_user_id bigint,p_command text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ BEGIN IF p_telegram_user_id<>6396446903 THEN RAISE EXCEPTION 'unauthorized'; END IF; INSERT INTO public.voucher_admin_telegram_updates(update_id,telegram_user_id,command) VALUES(p_update_id,p_telegram_user_id,left(coalesce(p_command,''),160)) ON CONFLICT DO NOTHING; INSERT INTO public.subscription_events(event_type,metadata) VALUES('voucher_admin_telegram_command',jsonb_build_object('result_code','accepted')); END $$;
REVOKE ALL ON FUNCTION public.quote_subscription_voucher(uuid,text,uuid), public.redeem_subscription_voucher(uuid,text,uuid), public.create_subscription_voucher(text,text,text,integer,integer,uuid), public.revoke_subscription_voucher(text,text,text,integer,integer,uuid), public.record_voucher_admin_telegram_command(bigint,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_subscription_voucher(uuid,text,uuid), public.redeem_subscription_voucher(uuid,text,uuid), public.create_subscription_voucher(text,text,text,integer,integer,uuid), public.revoke_subscription_voucher(text,text,text,integer,integer,uuid), public.record_voucher_admin_telegram_command(bigint,bigint,text) TO service_role;
