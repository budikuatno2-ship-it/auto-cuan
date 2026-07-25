-- Dedicated Telegram admin bot V1. Additive/idempotent; apply to staging manually.
CREATE TABLE IF NOT EXISTS public.membership_admin_bot_processed_updates (
 update_id bigint PRIMARY KEY, claimed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.membership_admin_bot_proof_notifications (
 purchase_id uuid PRIMARY KEY REFERENCES public.membership_purchases(id), claimed_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.membership_admin_bot_processed_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_admin_bot_proof_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_admin_bot_processed_updates,public.membership_admin_bot_proof_notifications FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.membership_admin_bot_processed_updates,public.membership_admin_bot_proof_notifications TO service_role;

CREATE OR REPLACE FUNCTION public.membership_admin_bot_context(p_telegram_user_id bigint) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN count(*)=1 THEN jsonb_build_object('authorized',true,'user_id',min(u.id::text)::uuid)
 ELSE jsonb_build_object('authorized',false) END
 FROM public.membership_admin_telegram_links l JOIN public.app_users u ON u.id=l.user_id
 WHERE l.telegram_user_id=p_telegram_user_id AND l.revoked_at IS NULL AND lower(u.username)='budi'
 AND u.is_approved=true AND u.is_blocked=false; $$;
CREATE OR REPLACE FUNCTION public.membership_admin_bot_claim_update(p_update_id bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 INSERT INTO public.membership_admin_bot_processed_updates(update_id) VALUES(p_update_id) ON CONFLICT DO NOTHING; RETURN FOUND; END $$;
CREATE OR REPLACE FUNCTION public.membership_admin_bot_release_update(p_update_id bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 DELETE FROM public.membership_admin_bot_processed_updates WHERE update_id=p_update_id AND claimed_at>now()-interval '30 seconds'; RETURN FOUND; END $$;

CREATE OR REPLACE FUNCTION public.membership_admin_bot_pending_payments() RETURNS SETOF jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('purchase_id',p.id,'masked_username',left(u.username,2)||repeat('*',greatest(length(u.username)-2,2)),
 'package_name',pkg.name,'final_amount_idr',p.final_amount_idr,'created_at',p.created_at,'submitted_at',pr.submitted_at,
 'mime_type',pr.mime_type,'file_size',pr.file_size,'proof_id',pr.id)
 FROM public.membership_purchases p JOIN public.app_users u ON u.id=p.user_id JOIN public.membership_packages pkg ON pkg.id=p.package_id
 JOIN LATERAL (SELECT * FROM public.membership_payment_proofs x WHERE x.purchase_id=p.id ORDER BY submitted_at DESC LIMIT 1) pr ON true
 WHERE p.status='awaiting_admin_review' ORDER BY pr.submitted_at LIMIT 10; $$;

CREATE OR REPLACE FUNCTION public.membership_admin_bot_claim_proof_notification(p_purchase_id uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 INSERT INTO public.membership_admin_bot_proof_notifications(purchase_id) VALUES(p_purchase_id) ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT jsonb_build_object('private_chat_id',l.private_chat_id) FROM public.membership_admin_telegram_links l
 JOIN public.app_users u ON u.id=l.user_id WHERE l.revoked_at IS NULL AND lower(u.username)='budi' AND u.is_approved=true AND u.is_blocked=false;
END $$;
CREATE OR REPLACE FUNCTION public.membership_admin_bot_release_proof_notification(p_purchase_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 DELETE FROM public.membership_admin_bot_proof_notifications WHERE purchase_id=p_purchase_id AND claimed_at>now()-interval '5 minutes'; RETURN FOUND; END $$;

CREATE OR REPLACE FUNCTION public.membership_admin_bot_create_voucher(p_code_hash text,p_code_hint text,p_discount_type text,p_discount_value bigint,p_package_slug text,p_total_limit integer,p_valid_days integer,p_admin_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE vid uuid; package_ids uuid[]; BEGIN
 IF p_code_hash !~ '^[0-9a-f]{64}$' OR p_code_hint !~ '^[A-Z0-9]{4}…[A-Z0-9]{4}$' OR p_discount_type NOT IN ('percent','fixed')
 OR p_discount_value<1 OR (p_discount_type='percent' AND p_discount_value>100) OR p_discount_value>1000000000
 OR p_package_slug NOT IN ('channel-30','channel-90','lifetime','all') OR coalesce(p_total_limit,1)<1 OR coalesce(p_valid_days,1)<1 THEN RAISE EXCEPTION 'voucher_policy_invalid'; END IF;
 IF p_package_slug<>'all' THEN SELECT array_agg(id) INTO package_ids FROM public.membership_packages WHERE slug=p_package_slug; IF package_ids IS NULL THEN RAISE EXCEPTION 'package_unavailable'; END IF; END IF;
 INSERT INTO public.membership_vouchers(code_hash,code_hint,discount_type,discount_value,package_ids,active,valid_from,valid_until,total_limit,per_account_limit)
 VALUES(p_code_hash,p_code_hint,p_discount_type,p_discount_value,package_ids,true,now(),CASE WHEN p_valid_days IS NULL THEN NULL ELSE now()+make_interval(days=>p_valid_days) END,p_total_limit,1)
 RETURNING id INTO vid;
 INSERT INTO public.membership_audit_events(event_type,actor_user_id,metadata) VALUES('voucher_created',p_admin_user_id,jsonb_build_object('voucherId',vid));
 RETURN jsonb_build_object('id',vid,'code_hint',p_code_hint); EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'voucher_duplicate'; END $$;

CREATE OR REPLACE FUNCTION public.membership_admin_bot_list_vouchers() RETURNS SETOF jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',v.id,'code_hint',v.code_hint,'discount_type',v.discount_type,'discount_value',v.discount_value,
 'package_slugs',coalesce((SELECT string_agg(p.slug,',') FROM public.membership_packages p WHERE p.id=ANY(v.package_ids)),'all'),
 'active',v.active,'valid_until',v.valid_until,'total_limit',v.total_limit,'redemption_count',v.redemption_count)
 FROM public.membership_vouchers v ORDER BY v.created_at DESC LIMIT 20; $$;
CREATE OR REPLACE FUNCTION public.membership_admin_bot_voucher_detail(p_identifier text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$ DECLARE result jsonb; n integer; BEGIN
 SELECT count(*),min(jsonb_build_object('id',v.id,'code_hint',v.code_hint,'discount_type',v.discount_type,'discount_value',v.discount_value,
 'package_slugs',coalesce((SELECT string_agg(p.slug,',') FROM public.membership_packages p WHERE p.id=ANY(v.package_ids)),'all'),'active',v.active,
 'valid_until',v.valid_until,'total_limit',v.total_limit,'redemption_count',v.redemption_count)::text)::jsonb INTO n,result
 FROM public.membership_vouchers v WHERE (p_identifier ~* '^[0-9a-f-]{36}$' AND v.id=p_identifier::uuid) OR upper(v.code_hint)=upper(p_identifier);
 IF n<>1 THEN RETURN NULL; END IF; RETURN result; END $$;
CREATE OR REPLACE FUNCTION public.membership_admin_bot_deactivate_voucher(p_voucher_id uuid,p_admin_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE was_active boolean; BEGIN
 SELECT active INTO was_active FROM public.membership_vouchers WHERE id=p_voucher_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'voucher_not_found'; END IF;
 IF was_active THEN UPDATE public.membership_vouchers SET active=false WHERE id=p_voucher_id; INSERT INTO public.membership_audit_events(event_type,actor_user_id,metadata) VALUES('voucher_deactivated',p_admin_user_id,jsonb_build_object('voucherId',p_voucher_id)); END IF;
 RETURN jsonb_build_object('already_inactive',NOT was_active); END $$;

CREATE OR REPLACE FUNCTION public.membership_admin_bot_user_lookup(p_query text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('masked_username',left(u.username,2)||repeat('*',greatest(length(u.username)-2,2)),'approved',u.is_approved,'blocked',u.is_blocked,
 'telegram_verified',v.telegram_verified_at IS NOT NULL,'package_name',pkg.name,'lifetime',coalesce(e.lifetime,false),'ends_at',e.ends_at,
 'pending_payment_status',(SELECT p.status FROM public.membership_purchases p WHERE p.user_id=u.id AND p.status IN ('awaiting_payment','awaiting_admin_review','rejected') ORDER BY p.created_at DESC LIMIT 1),
 'channel_access',(e.id IS NOT NULL),'dashboard_access',coalesce(e.lifetime,false))
 FROM public.app_users u LEFT JOIN public.app_user_telegram_verifications v ON v.user_id=u.id
 LEFT JOIN LATERAL (SELECT * FROM public.membership_entitlements x WHERE x.user_id=u.id AND x.status='active' AND (x.lifetime OR x.ends_at>now()) ORDER BY x.lifetime DESC,x.ends_at DESC LIMIT 1)e ON true
 LEFT JOIN public.membership_purchases ep ON ep.id=e.purchase_id LEFT JOIN public.membership_packages pkg ON pkg.id=ep.package_id
 WHERE lower(u.username)=lower(p_query) OR (p_query ~ '^[0-9]{1,20}$' AND v.telegram_user_id=p_query::bigint) LIMIT 1; $$;
CREATE OR REPLACE FUNCTION public.membership_admin_bot_audit(p_purchase_id uuid DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$ SELECT jsonb_build_object('event_type',event_type,'purchase_id',purchase_id,'created_at',created_at)
 FROM public.membership_audit_events WHERE p_purchase_id IS NULL OR purchase_id=p_purchase_id ORDER BY created_at DESC LIMIT 20; $$;

-- Return only the context required for durable best-effort admin notification.
CREATE OR REPLACE FUNCTION public.membership_submit_payment_proof(p_telegram_user_id bigint,p_purchase_id uuid,p_file_id text,p_file_unique_id text,p_mime_type text,p_file_size bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE uid uuid; p public.membership_purchases; pkg public.membership_packages; uname text; BEGIN
 SELECT user_id INTO uid FROM public.app_user_telegram_verifications WHERE telegram_user_id=p_telegram_user_id AND telegram_verified_at IS NOT NULL;
 IF uid IS NULL OR p_mime_type NOT IN ('image/jpeg','image/png','application/pdf') OR p_file_size<=0 OR p_file_size>8388608 THEN RAISE EXCEPTION 'proof_invalid'; END IF;
 UPDATE public.membership_purchases SET status='awaiting_admin_review',updated_at=now() WHERE id=p_purchase_id AND user_id=uid AND status IN ('awaiting_payment','rejected') AND expires_at>now() RETURNING * INTO p;
 IF NOT FOUND THEN RAISE EXCEPTION 'purchase_state_conflict'; END IF;
 INSERT INTO public.membership_payment_proofs(purchase_id,telegram_file_id,telegram_file_unique_id,mime_type,file_size) VALUES(p_purchase_id,p_file_id,p_file_unique_id,p_mime_type,p_file_size);
 INSERT INTO public.membership_audit_events(event_type,purchase_id) VALUES('proof_submitted',p_purchase_id);
 SELECT * INTO pkg FROM public.membership_packages WHERE id=p.package_id; SELECT username INTO uname FROM public.app_users WHERE id=uid;
 RETURN jsonb_build_object('accepted',true,'purchaseId',p.id,'notificationText','Bukti baru #'||left(p.id::text,8)||E'\nAkun: '||left(uname,2)||'****'||E'\nPaket: '||pkg.name||E'\nJumlah: Rp'||p.final_amount_idr); END $$;

-- Enrich the existing transactional result without changing its entitlement/idempotency rules.
CREATE OR REPLACE FUNCTION public.membership_review_purchase(p_purchase_id uuid,p_approve boolean,p_reason text,p_admin_user_id uuid,p_idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE p public.membership_purchases; pkg public.membership_packages; end_at timestamptz; duplicate boolean:=false; chat bigint; BEGIN
 IF EXISTS(SELECT 1 FROM public.membership_audit_events WHERE idempotency_key=p_idempotency_key) THEN duplicate:=true; ELSE
  SELECT * INTO p FROM public.membership_purchases WHERE id=p_purchase_id FOR UPDATE; IF p.status<>'awaiting_admin_review' OR p.expires_at<=now() THEN RAISE EXCEPTION 'purchase_state_conflict'; END IF;
  SELECT * INTO pkg FROM public.membership_packages WHERE id=p.package_id; IF EXISTS(SELECT 1 FROM public.app_users WHERE id=p.user_id AND is_blocked=true) THEN RAISE EXCEPTION 'blocked_account'; END IF;
  IF NOT p_approve THEN IF length(trim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'reason_required'; END IF; UPDATE public.membership_purchases SET status='rejected',rejected_at=now(),rejection_reason=p_reason,updated_at=now() WHERE id=p.id;
  ELSE UPDATE public.membership_purchases SET status='approved',approved_at=now(),updated_at=now() WHERE id=p.id; UPDATE public.app_users SET is_approved=true WHERE id=p.user_id AND is_approved=false AND is_blocked=false;
   IF pkg.lifetime THEN INSERT INTO public.membership_entitlements(user_id,purchase_id,status,lifetime,ends_at) VALUES(p.user_id,p.id,'active',true,NULL);
   ELSE SELECT greatest(now(),coalesce(max(ends_at),now()))+make_interval(days=>pkg.duration_days) INTO end_at FROM public.membership_entitlements WHERE user_id=p.user_id AND status='active' AND lifetime=false; INSERT INTO public.membership_entitlements(user_id,purchase_id,status,lifetime,ends_at) VALUES(p.user_id,p.id,'active',false,end_at); END IF;
   UPDATE public.membership_voucher_redemptions SET status='finalized',redeemed_at=now() WHERE purchase_id=p.id AND status='reserved'; UPDATE public.membership_vouchers SET redemption_count=redemption_count+1 WHERE id=p.voucher_id AND p.voucher_id IS NOT NULL;
  END IF;
  INSERT INTO public.membership_audit_events(event_type,actor_user_id,purchase_id,idempotency_key,metadata) VALUES(CASE WHEN p_approve THEN 'purchase_approved' ELSE 'purchase_rejected' END,p_admin_user_id,p.id,p_idempotency_key,jsonb_build_object('reason',p_reason));
 END IF;
 SELECT * INTO p FROM public.membership_purchases WHERE id=p_purchase_id; SELECT * INTO pkg FROM public.membership_packages WHERE id=p.package_id; SELECT telegram_private_chat_id INTO chat FROM public.app_user_telegram_verifications WHERE user_id=p.user_id AND telegram_verified_at IS NOT NULL;
 SELECT ends_at INTO end_at FROM public.membership_entitlements WHERE purchase_id=p.id;
 RETURN jsonb_build_object('approved',p_approve,'duplicate',duplicate,'customer_chat_id',chat,'package_name',pkg.name,'lifetime',pkg.lifetime,'ends_at',end_at); END $$;

REVOKE ALL ON FUNCTION public.membership_admin_bot_context(bigint),public.membership_admin_bot_claim_update(bigint),public.membership_admin_bot_release_update(bigint),public.membership_admin_bot_pending_payments(),public.membership_admin_bot_claim_proof_notification(uuid),public.membership_admin_bot_release_proof_notification(uuid),public.membership_admin_bot_create_voucher(text,text,text,bigint,text,integer,integer,uuid),public.membership_admin_bot_list_vouchers(),public.membership_admin_bot_voucher_detail(text),public.membership_admin_bot_deactivate_voucher(uuid,uuid),public.membership_admin_bot_user_lookup(text),public.membership_admin_bot_audit(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_admin_bot_context(bigint),public.membership_admin_bot_claim_update(bigint),public.membership_admin_bot_release_update(bigint),public.membership_admin_bot_pending_payments(),public.membership_admin_bot_claim_proof_notification(uuid),public.membership_admin_bot_release_proof_notification(uuid),public.membership_admin_bot_create_voucher(text,text,text,bigint,text,integer,integer,uuid),public.membership_admin_bot_list_vouchers(),public.membership_admin_bot_voucher_detail(text),public.membership_admin_bot_deactivate_voucher(uuid,uuid),public.membership_admin_bot_user_lookup(text),public.membership_admin_bot_audit(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.membership_submit_payment_proof(bigint,uuid,text,text,text,bigint),public.membership_review_purchase(uuid,boolean,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_submit_payment_proof(bigint,uuid,text,text,text,bigint),public.membership_review_purchase(uuid,boolean,text,uuid,text) TO service_role;

-- Schema-clone repair: backend tables remain service-role only (no new anon/authenticated grants).
GRANT SELECT,INSERT,UPDATE,DELETE ON public.app_users,public.app_user_telegram_verifications,public.membership_admin_telegram_links,public.membership_packages,public.membership_vouchers,public.membership_purchases,public.membership_payment_proofs,public.membership_entitlements,public.membership_voucher_redemptions,public.membership_channel_grants,public.membership_audit_events TO service_role;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
