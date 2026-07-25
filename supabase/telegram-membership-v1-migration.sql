-- Telegram Membership V1. Additive, service-owned migration; apply manually.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.membership_admin_bind_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.app_users(id), code_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, used_at timestamptz, failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts <= 5), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.membership_admin_telegram_links (
 user_id uuid PRIMARY KEY REFERENCES public.app_users(id), telegram_user_id bigint NOT NULL UNIQUE, private_chat_id bigint NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
CREATE TABLE IF NOT EXISTS public.membership_packages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, name text NOT NULL, description text NOT NULL,
 duration_days integer CHECK (duration_days IN (30,90) OR duration_days IS NULL), lifetime boolean NOT NULL DEFAULT false,
 price_idr bigint NOT NULL CHECK (price_idr >= 0), active boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK (lifetime = (duration_days IS NULL)));
INSERT INTO public.membership_packages(slug,name,description,duration_days,lifetime,price_idr,sort_order) VALUES
 ('channel-30','Channel 30 Hari','Akses bot dan channel selama 30 hari.',30,false,149000,10),
 ('channel-90','Channel 90 Hari','Akses bot dan channel selama 90 hari.',90,false,349000,20),
 ('lifetime','Lifetime','Akses bot, channel, dan dashboard web selamanya.',null,true,1499000,30)
ON CONFLICT (slug) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.membership_vouchers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_hash text NOT NULL UNIQUE, code_hint text NOT NULL, discount_type text NOT NULL CHECK(discount_type IN ('fixed','percent')),
 discount_value bigint NOT NULL CHECK(discount_value > 0), max_discount_idr bigint, package_ids uuid[], valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz,
 total_limit integer, per_account_limit integer NOT NULL DEFAULT 1 CHECK(per_account_limit > 0), redemption_count integer NOT NULL DEFAULT 0,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
DO $$ BEGIN CREATE TYPE public.membership_purchase_status AS ENUM ('draft','awaiting_payment','proof_submitted','awaiting_admin_review','approved','rejected','expired','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.membership_purchases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.app_users(id), package_id uuid NOT NULL REFERENCES public.membership_packages(id),
 voucher_id uuid REFERENCES public.membership_vouchers(id), status public.membership_purchase_status NOT NULL DEFAULT 'draft', subtotal_idr bigint NOT NULL,
 discount_idr bigint NOT NULL DEFAULT 0, final_amount_idr bigint NOT NULL, bank_instructions text NOT NULL, expires_at timestamptz NOT NULL,
 approved_at timestamptz, rejected_at timestamptz, rejection_reason text, activation_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK(final_amount_idr=subtotal_idr-discount_idr));
CREATE INDEX IF NOT EXISTS membership_purchase_queue_idx ON public.membership_purchases(status,expires_at);
CREATE TABLE IF NOT EXISTS public.membership_payment_proofs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), purchase_id uuid NOT NULL REFERENCES public.membership_purchases(id), telegram_file_id text NOT NULL,
 telegram_file_unique_id text NOT NULL, mime_type text NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','application/pdf')),
 file_size bigint NOT NULL CHECK(file_size > 0 AND file_size <= 8388608), submitted_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
 UNIQUE(purchase_id,telegram_file_unique_id));
CREATE TABLE IF NOT EXISTS public.membership_entitlements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.app_users(id), purchase_id uuid REFERENCES public.membership_purchases(id) UNIQUE,
 status text NOT NULL CHECK(status IN ('active','revoked','expired')), starts_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz, lifetime boolean NOT NULL,
 activated_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, CHECK(lifetime=(ends_at IS NULL)));
CREATE INDEX IF NOT EXISTS membership_entitlement_expiry_idx ON public.membership_entitlements(status,ends_at);
CREATE TABLE IF NOT EXISTS public.membership_voucher_redemptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), voucher_id uuid NOT NULL REFERENCES public.membership_vouchers(id), user_id uuid NOT NULL REFERENCES public.app_users(id),
 purchase_id uuid NOT NULL UNIQUE REFERENCES public.membership_purchases(id), discount_idr bigint NOT NULL, redeemed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(voucher_id,user_id,purchase_id));
CREATE TABLE IF NOT EXISTS public.membership_channel_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.app_users(id), telegram_user_id bigint NOT NULL,
 entitlement_id uuid REFERENCES public.membership_entitlements(id), invite_link_hash text, expires_at timestamptz, joined_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,telegram_user_id,entitlement_id));
CREATE INDEX IF NOT EXISTS membership_channel_expiry_idx ON public.membership_channel_grants(expires_at) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS public.membership_processed_telegram_updates (
 update_id bigint PRIMARY KEY, claimed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.membership_audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_type text NOT NULL, actor_user_id uuid REFERENCES public.app_users(id),
 purchase_id uuid REFERENCES public.membership_purchases(id), idempotency_key text UNIQUE, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE public.membership_admin_bind_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_admin_telegram_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_payment_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_voucher_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_channel_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_processed_telegram_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_admin_bind_challenges, public.membership_admin_telegram_links,
 public.membership_packages, public.membership_vouchers, public.membership_purchases,
 public.membership_payment_proofs, public.membership_entitlements, public.membership_voucher_redemptions,
 public.membership_channel_grants, public.membership_processed_telegram_updates, public.membership_audit_events
 FROM anon, authenticated;
GRANT SELECT ON public.membership_packages TO authenticated;

CREATE OR REPLACE FUNCTION public.membership_claim_telegram_update(p_update_id bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN INSERT INTO public.membership_processed_telegram_updates(update_id) VALUES(p_update_id) ON CONFLICT DO NOTHING; RETURN FOUND; END $$;
CREATE OR REPLACE FUNCTION public.membership_release_telegram_update(p_update_id bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN DELETE FROM public.membership_processed_telegram_updates WHERE update_id=p_update_id AND claimed_at > now()-interval '30 seconds'; RETURN FOUND; END $$;
CREATE OR REPLACE FUNCTION public.membership_dashboard_access(p_user_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('allowed', EXISTS(SELECT 1 FROM public.app_user_telegram_verifications v JOIN public.membership_entitlements e ON e.user_id=v.user_id WHERE v.user_id=p_user_id AND v.telegram_verified_at IS NOT NULL AND e.status='active' AND e.lifetime)); $$;
CREATE OR REPLACE FUNCTION public.membership_account_for_telegram(p_telegram_user_id bigint) RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
 SELECT COALESCE((SELECT jsonb_build_object('verified',v.telegram_verified_at IS NOT NULL,'isAdmin',false,'userId',v.user_id,'entitlement',CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object('status',e.status,'lifetime',e.lifetime,'endsAt',e.ends_at) END) FROM public.app_user_telegram_verifications v LEFT JOIN LATERAL (SELECT * FROM public.membership_entitlements x WHERE x.user_id=v.user_id ORDER BY x.lifetime DESC,x.ends_at DESC NULLS FIRST LIMIT 1)e ON true WHERE v.telegram_user_id=p_telegram_user_id), 'null'::jsonb); $$;
CREATE OR REPLACE FUNCTION public.membership_enforce_channel_expiry(p_dry_run boolean DEFAULT true) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('dryRun',p_dry_run,'candidates',count(*),'note','Configured owners/admins are excluded; run migration report before destructive enforcement') FROM public.membership_channel_grants g WHERE g.revoked_at IS NULL AND g.expires_at < now() AND NOT EXISTS(SELECT 1 FROM public.membership_admin_telegram_links a WHERE a.telegram_user_id=g.telegram_user_id AND a.revoked_at IS NULL); $$;
REVOKE ALL ON FUNCTION public.membership_claim_telegram_update(bigint), public.membership_release_telegram_update(bigint), public.membership_dashboard_access(uuid), public.membership_account_for_telegram(bigint), public.membership_enforce_channel_expiry(boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_claim_telegram_update(bigint), public.membership_release_telegram_update(bigint), public.membership_dashboard_access(uuid), public.membership_account_for_telegram(bigint), public.membership_enforce_channel_expiry(boolean) TO service_role;

CREATE VIEW public.membership_admin_payment_queue WITH (security_invoker=true) AS SELECT p.id purchase_id,p.user_id,p.status,p.final_amount_idr,p.created_at,pr.id proof_id,pr.mime_type,pr.file_size,pr.submitted_at FROM public.membership_purchases p JOIN public.membership_payment_proofs pr ON pr.purchase_id=p.id WHERE p.status='awaiting_admin_review';
REVOKE ALL ON public.membership_admin_payment_queue FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.membership_admin_payment_queue TO service_role;
CREATE OR REPLACE FUNCTION public.membership_create_purchase(p_telegram_user_id bigint,p_package_id uuid,p_voucher_hash text,p_bank_instructions text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE u uuid; pkg public.membership_packages; v public.membership_vouchers; sub bigint; disc bigint:=0; pid uuid;
BEGIN
 IF length(trim(coalesce(p_bank_instructions,''))) < 10 OR length(p_bank_instructions) > 1000 THEN RAISE EXCEPTION 'bank_instructions_unavailable'; END IF;
 SELECT user_id INTO u FROM public.app_user_telegram_verifications WHERE telegram_user_id=p_telegram_user_id AND telegram_verified_at IS NOT NULL;
 IF u IS NULL THEN RAISE EXCEPTION 'verified_account_required'; END IF;
 SELECT * INTO pkg FROM public.membership_packages WHERE id=p_package_id AND active FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'package_unavailable'; END IF; sub:=pkg.price_idr;
 IF p_voucher_hash IS NOT NULL THEN
  SELECT * INTO v FROM public.membership_vouchers WHERE code_hash=p_voucher_hash AND active AND now()>=valid_from AND (valid_until IS NULL OR now()<valid_until) FOR UPDATE;
  IF NOT FOUND OR (v.package_ids IS NOT NULL AND NOT p_package_id=ANY(v.package_ids)) OR (v.total_limit IS NOT NULL AND v.redemption_count>=v.total_limit) OR (SELECT count(*) FROM public.membership_voucher_redemptions WHERE voucher_id=v.id AND user_id=u)>=v.per_account_limit THEN RAISE EXCEPTION 'voucher_unavailable'; END IF;
  disc:=CASE WHEN v.discount_type='percent' THEN floor(sub*v.discount_value/100) ELSE v.discount_value END; disc:=least(sub,disc,coalesce(v.max_discount_idr,sub));
 END IF;
 INSERT INTO public.membership_purchases(user_id,package_id,voucher_id,status,subtotal_idr,discount_idr,final_amount_idr,bank_instructions,expires_at) VALUES(u,pkg.id,v.id,'awaiting_payment',sub,disc,sub-disc,p_bank_instructions,now()+interval '24 hours') RETURNING id INTO pid;
 IF v.id IS NOT NULL THEN INSERT INTO public.membership_voucher_redemptions(voucher_id,user_id,purchase_id,discount_idr) VALUES(v.id,u,pid,disc); UPDATE public.membership_vouchers SET redemption_count=redemption_count+1 WHERE id=v.id; END IF;
 INSERT INTO public.membership_audit_events(event_type,purchase_id,metadata) VALUES('purchase_created',pid,jsonb_build_object('amount',sub-disc)); RETURN jsonb_build_object('purchaseId',pid,'finalAmount',sub-disc,'status','awaiting_payment','bankInstructions',p_bank_instructions);
END $$;
CREATE OR REPLACE FUNCTION public.membership_submit_payment_proof(p_telegram_user_id bigint,p_purchase_id uuid,p_file_id text,p_file_unique_id text,p_mime_type text,p_file_size bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE u uuid;
BEGIN SELECT user_id INTO u FROM public.app_user_telegram_verifications WHERE telegram_user_id=p_telegram_user_id AND telegram_verified_at IS NOT NULL;
 IF p_mime_type NOT IN ('image/jpeg','image/png','application/pdf') OR p_file_size<=0 OR p_file_size>8388608 THEN RAISE EXCEPTION 'invalid_proof'; END IF;
 UPDATE public.membership_purchases SET status='awaiting_admin_review',updated_at=now() WHERE id=p_purchase_id AND user_id=u AND status IN ('awaiting_payment','rejected'); IF NOT FOUND THEN RAISE EXCEPTION 'purchase_state_conflict'; END IF;
 INSERT INTO public.membership_payment_proofs(purchase_id,telegram_file_id,telegram_file_unique_id,mime_type,file_size) VALUES(p_purchase_id,p_file_id,p_file_unique_id,p_mime_type,p_file_size);
 INSERT INTO public.membership_audit_events(event_type,purchase_id) VALUES('proof_submitted',p_purchase_id); RETURN jsonb_build_object('accepted',true); END $$;
CREATE OR REPLACE FUNCTION public.membership_review_purchase(p_purchase_id uuid,p_approve boolean,p_reason text,p_admin_user_id uuid,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.membership_purchases; pkg public.membership_packages; end_at timestamptz;
BEGIN
 IF EXISTS(SELECT 1 FROM public.membership_audit_events WHERE idempotency_key=p_idempotency_key) THEN RETURN jsonb_build_object('duplicate',true); END IF;
 SELECT * INTO p FROM public.membership_purchases WHERE id=p_purchase_id FOR UPDATE; IF p.status<>'awaiting_admin_review' THEN RAISE EXCEPTION 'purchase_state_conflict'; END IF;
 IF NOT p_approve THEN IF length(trim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'reason_required'; END IF; UPDATE public.membership_purchases SET status='rejected',rejected_at=now(),rejection_reason=p_reason,updated_at=now() WHERE id=p.id; ELSE
  SELECT * INTO pkg FROM public.membership_packages WHERE id=p.package_id; IF NOT pkg.lifetime THEN SELECT greatest(now(),coalesce(max(ends_at),now())) + make_interval(days=>pkg.duration_days) INTO end_at FROM public.membership_entitlements WHERE user_id=p.user_id AND status='active' AND NOT lifetime; END IF;
  INSERT INTO public.membership_entitlements(user_id,purchase_id,status,ends_at,lifetime) VALUES(p.user_id,p.id,'active',end_at,pkg.lifetime) ON CONFLICT(purchase_id) DO NOTHING;
  UPDATE public.membership_purchases SET status='approved',approved_at=now(),updated_at=now() WHERE id=p.id;
 END IF;
 INSERT INTO public.membership_audit_events(event_type,actor_user_id,purchase_id,idempotency_key,metadata) VALUES(CASE WHEN p_approve THEN 'purchase_approved' ELSE 'purchase_rejected' END,p_admin_user_id,p.id,p_idempotency_key,jsonb_build_object('reason',p_reason)); RETURN jsonb_build_object('approved',p_approve,'duplicate',false); END $$;
CREATE OR REPLACE FUNCTION public.membership_issue_channel_grant(p_telegram_user_id bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE u uuid;e public.membership_entitlements;gid uuid;
BEGIN SELECT user_id INTO u FROM public.app_user_telegram_verifications WHERE telegram_user_id=p_telegram_user_id AND telegram_verified_at IS NOT NULL; SELECT * INTO e FROM public.membership_entitlements WHERE user_id=u AND status='active' AND (lifetime OR ends_at>now()) ORDER BY lifetime DESC,ends_at DESC NULLS FIRST LIMIT 1; IF NOT FOUND THEN RAISE EXCEPTION 'entitlement_required'; END IF;
 INSERT INTO public.membership_channel_grants(user_id,telegram_user_id,entitlement_id,expires_at) VALUES(u,p_telegram_user_id,e.id,e.ends_at) ON CONFLICT(user_id,telegram_user_id,entitlement_id) DO UPDATE SET expires_at=excluded.expires_at,revoked_at=NULL RETURNING id INTO gid; INSERT INTO public.membership_audit_events(event_type,actor_user_id,metadata) VALUES('channel_grant_issued',u,jsonb_build_object('grantId',gid)); RETURN jsonb_build_object('grantId',gid); END $$;
REVOKE ALL ON FUNCTION public.membership_create_purchase(bigint,uuid,text,text),public.membership_submit_payment_proof(bigint,uuid,text,text,text,bigint),public.membership_review_purchase(uuid,boolean,text,uuid,text),public.membership_issue_channel_grant(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_create_purchase(bigint,uuid,text,text),public.membership_submit_payment_proof(bigint,uuid,text,text,text,bigint),public.membership_review_purchase(uuid,boolean,text,uuid,text),public.membership_issue_channel_grant(bigint) TO service_role;
CREATE OR REPLACE FUNCTION public.membership_consume_admin_bind_challenge(p_code_hash text,p_telegram_user_id bigint,p_private_chat_id bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.membership_admin_bind_challenges;
BEGIN
 IF p_telegram_user_id IS NULL OR p_private_chat_id IS NULL OR p_telegram_user_id<>p_private_chat_id THEN RETURN false; END IF;
 SELECT * INTO c FROM public.membership_admin_bind_challenges WHERE code_hash=p_code_hash AND used_at IS NULL AND expires_at>now() AND failed_attempts<5 FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.membership_admin_telegram_links WHERE (user_id=c.user_id OR telegram_user_id=p_telegram_user_id) AND revoked_at IS NULL) THEN RETURN false; END IF;
 UPDATE public.membership_admin_bind_challenges SET used_at=now() WHERE id=c.id AND used_at IS NULL;
 INSERT INTO public.membership_admin_telegram_links(user_id,telegram_user_id,private_chat_id) VALUES(c.user_id,p_telegram_user_id,p_private_chat_id);
 INSERT INTO public.membership_audit_events(event_type,actor_user_id,metadata) VALUES('admin_telegram_bound',c.user_id,jsonb_build_object('telegramUserId',p_telegram_user_id)); RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.membership_consume_admin_bind_challenge(text,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_consume_admin_bind_challenge(text,bigint,bigint) TO service_role;
