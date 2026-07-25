-- Telegram Membership V2: guided checkout and correct channel eligibility.
-- Additive/idempotent. Apply to staging before testing the V2 customer flow.

ALTER TABLE public.membership_packages
  ADD COLUMN IF NOT EXISTS product_type text;
UPDATE public.membership_packages SET product_type='membership' WHERE product_type IS NULL;
ALTER TABLE public.membership_packages ALTER COLUMN product_type SET DEFAULT 'membership';
ALTER TABLE public.membership_packages ALTER COLUMN product_type SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.membership_packages'::regclass
      AND conname='membership_packages_product_type_check'
  ) THEN
    ALTER TABLE public.membership_packages
      ADD CONSTRAINT membership_packages_product_type_check
      CHECK (product_type IN ('membership','channel_addon'));
  END IF;
END $$;

UPDATE public.membership_packages
SET name='Bot 30 Hari',
    description='Akses bot Auto-Cuan selama 30 hari. Tidak termasuk akses channel.',
    product_type='membership'
WHERE slug='channel-30';

UPDATE public.membership_packages
SET name='Bot 90 Hari',
    description='Akses bot selama 90 hari dan channel untuk 30 hari pertama. Channel bulan kedua dan ketiga dapat diperpanjang Rp10.000 per 30 hari.',
    product_type='membership'
WHERE slug='channel-90';

UPDATE public.membership_packages
SET name='Lifetime',
    description='Akses bot, dashboard web, dan channel tanpa batas waktu.',
    product_type='membership'
WHERE slug='lifetime';

INSERT INTO public.membership_packages(
  slug,name,description,duration_days,lifetime,price_idr,active,sort_order,product_type
) VALUES (
  'channel-addon-30','Perpanjangan Channel 30 Hari',
  'Perpanjangan channel 30 hari khusus pemilik paket Bot 90 Hari yang masih aktif.',
  30,false,10000,true,40,'channel_addon'
)
ON CONFLICT (slug) DO UPDATE SET
  name=excluded.name,
  description=excluded.description,
  duration_days=excluded.duration_days,
  lifetime=excluded.lifetime,
  price_idr=excluded.price_idr,
  active=excluded.active,
  sort_order=excluded.sort_order,
  product_type=excluded.product_type;

CREATE TABLE IF NOT EXISTS public.membership_checkout_sessions (
  telegram_user_id bigint PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  package_id uuid NOT NULL REFERENCES public.membership_packages(id),
  state text NOT NULL DEFAULT 'voucher_input' CHECK(state IN ('voucher_input')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.membership_checkout_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_checkout_sessions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.membership_checkout_sessions TO service_role;

CREATE OR REPLACE FUNCTION public.membership_account_for_telegram(p_telegram_user_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
DECLARE
  a public.membership_admin_telegram_links;
  u public.app_users;
  v public.app_user_telegram_verifications;
  e public.membership_entitlements;
  pkg public.membership_packages;
  pending_review boolean;
  included_end timestamptz;
  grant_end timestamptz;
  channel_end timestamptz;
  channel_access boolean:=false;
  addon_available boolean:=false;
BEGIN
  SELECT * INTO a FROM public.membership_admin_telegram_links
  WHERE telegram_user_id=p_telegram_user_id AND revoked_at IS NULL;
  IF FOUND THEN
    SELECT * INTO u FROM public.app_users
    WHERE id=a.user_id AND lower(username)='budi' AND is_approved=true AND is_blocked=false;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'verified',true,'isAdmin',true,'username',u.username,'accountStatus','active','blocked',false,
        'botAccess',true,'channelAccess',true,'dashboardAccess',true,'entitlement',NULL,
        'pendingPurchase',false,'channelCoverageEndsAt',NULL,'channelAddonAvailable',false
      );
    END IF;
  END IF;

  SELECT * INTO v FROM public.app_user_telegram_verifications
  WHERE telegram_user_id=p_telegram_user_id AND telegram_verified_at IS NOT NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO u FROM public.app_users WHERE id=v.user_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.membership_purchases p
    WHERE p.user_id=v.user_id AND p.status IN ('proof_submitted','awaiting_admin_review')
  ) INTO pending_review;

  IF u.is_blocked=true THEN
    RETURN jsonb_build_object(
      'verified',true,'isAdmin',false,'username',u.username,'accountStatus','blocked','blocked',true,
      'botAccess',false,'channelAccess',false,'dashboardAccess',false,'entitlement',NULL,
      'pendingPurchase',pending_review,'channelCoverageEndsAt',NULL,'channelAddonAvailable',false
    );
  END IF;
  IF u.is_approved IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'verified',true,'isAdmin',false,'username',u.username,'accountStatus','pending','blocked',false,
      'botAccess',false,'channelAccess',false,'dashboardAccess',false,'entitlement',NULL,
      'pendingPurchase',pending_review,'channelCoverageEndsAt',NULL,'channelAddonAvailable',false
    );
  END IF;

  SELECT e0.* INTO e
  FROM public.membership_entitlements e0
  JOIN public.membership_purchases p ON p.id=e0.purchase_id
  JOIN public.membership_packages mp ON mp.id=p.package_id AND mp.product_type='membership'
  WHERE e0.user_id=v.user_id AND e0.status='active' AND (e0.lifetime OR e0.ends_at>now())
  ORDER BY e0.lifetime DESC,e0.ends_at DESC NULLS FIRST LIMIT 1;

  IF e.id IS NOT NULL THEN
    SELECT mp.* INTO pkg
    FROM public.membership_purchases p JOIN public.membership_packages mp ON mp.id=p.package_id
    WHERE p.id=e.purchase_id;

    IF e.lifetime THEN
      channel_access:=true;
      channel_end:=NULL;
    ELSIF pkg.duration_days=90 THEN
      included_end:=least(e.starts_at+interval '30 days',e.ends_at);
      SELECT max(g.expires_at) INTO grant_end
      FROM public.membership_channel_grants g
      WHERE g.user_id=v.user_id AND g.telegram_user_id=p_telegram_user_id
        AND g.entitlement_id=e.id AND g.revoked_at IS NULL;
      channel_end:=greatest(included_end,coalesce(grant_end,included_end));
      channel_access:=channel_end>now();
      addon_available:=channel_end<e.ends_at;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'verified',true,'isAdmin',false,'username',u.username,'accountStatus','approved','blocked',false,
    'botAccess',e.id IS NOT NULL,'channelAccess',channel_access,'dashboardAccess',coalesce(e.lifetime,false),
    'entitlement',CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object(
      'status',e.status,'lifetime',e.lifetime,'startsAt',e.starts_at,'endsAt',e.ends_at,
      'packageName',pkg.name,'packageSlug',pkg.slug,'durationDays',pkg.duration_days
    ) END,
    'pendingPurchase',pending_review,
    'channelCoverageEndsAt',channel_end,
    'channelAddonAvailable',addon_available
  );
END $$;

CREATE OR REPLACE FUNCTION public.membership_begin_checkout(p_telegram_user_id bigint,p_package_slug text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE u uuid; pkg public.membership_packages; eligible boolean;
BEGIN
  SELECT v.user_id INTO u
  FROM public.app_user_telegram_verifications v
  JOIN public.app_users au ON au.id=v.user_id
  WHERE v.telegram_user_id=p_telegram_user_id AND v.telegram_verified_at IS NOT NULL
    AND au.is_approved=true AND au.is_blocked=false;
  IF u IS NULL THEN RAISE EXCEPTION 'verified_approved_account_required'; END IF;

  SELECT * INTO pkg FROM public.membership_packages
  WHERE slug=lower(p_package_slug) AND active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'package_unavailable'; END IF;

  IF pkg.product_type='channel_addon' THEN
    SELECT EXISTS(
      SELECT 1
      FROM public.membership_entitlements e
      JOIN public.membership_purchases p ON p.id=e.purchase_id
      JOIN public.membership_packages base ON base.id=p.package_id
      WHERE e.user_id=u AND e.status='active' AND e.ends_at>now() AND NOT e.lifetime
        AND base.product_type='membership' AND base.duration_days=90
    ) INTO eligible;
    IF NOT eligible THEN RAISE EXCEPTION 'channel_addon_requires_90_day'; END IF;
  END IF;

  INSERT INTO public.membership_checkout_sessions(telegram_user_id,user_id,package_id,expires_at)
  VALUES(p_telegram_user_id,u,pkg.id,now()+interval '10 minutes')
  ON CONFLICT(telegram_user_id) DO UPDATE SET
    user_id=excluded.user_id,package_id=excluded.package_id,state='voucher_input',
    expires_at=excluded.expires_at,updated_at=now();

  RETURN jsonb_build_object('packageId',pkg.id,'packageSlug',pkg.slug,'packageName',pkg.name,
    'priceIdr',pkg.price_idr,'productType',pkg.product_type,'expiresAt',now()+interval '10 minutes');
END $$;

CREATE OR REPLACE FUNCTION public.membership_checkout_session(p_telegram_user_id bigint) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('packageId',p.id,'packageSlug',p.slug,'packageName',p.name,
    'priceIdr',p.price_idr,'productType',p.product_type,'expiresAt',s.expires_at)
  FROM public.membership_checkout_sessions s
  JOIN public.membership_packages p ON p.id=s.package_id
  WHERE s.telegram_user_id=p_telegram_user_id AND s.expires_at>now();
$$;

CREATE OR REPLACE FUNCTION public.membership_cancel_checkout(p_telegram_user_id bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  DELETE FROM public.membership_checkout_sessions WHERE telegram_user_id=p_telegram_user_id;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.membership_create_purchase(p_telegram_user_id bigint,p_package_id uuid,p_voucher_hash text,p_bank_instructions text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  u uuid; pkg public.membership_packages; v public.membership_vouchers;
  sub bigint; disc bigint:=0; pid uuid; e public.membership_entitlements;
  included_end timestamptz; covered_end timestamptz;
BEGIN
  IF length(trim(coalesce(p_bank_instructions,'')))<10 OR length(p_bank_instructions)>1000 THEN
    RAISE EXCEPTION 'bank_instructions_unavailable';
  END IF;
  SELECT av.user_id INTO u
  FROM public.app_user_telegram_verifications av
  JOIN public.app_users au ON au.id=av.user_id
  WHERE av.telegram_user_id=p_telegram_user_id AND av.telegram_verified_at IS NOT NULL AND au.is_blocked=false;
  IF u IS NULL THEN RAISE EXCEPTION 'verified_unblocked_account_required'; END IF;

  SELECT * INTO pkg FROM public.membership_packages WHERE id=p_package_id AND active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'package_unavailable'; END IF;
  sub:=pkg.price_idr;

  IF pkg.product_type='channel_addon' THEN
    SELECT e0.* INTO e
    FROM public.membership_entitlements e0
    JOIN public.membership_purchases p0 ON p0.id=e0.purchase_id
    JOIN public.membership_packages base ON base.id=p0.package_id
    WHERE e0.user_id=u AND e0.status='active' AND e0.ends_at>now() AND NOT e0.lifetime
      AND base.product_type='membership' AND base.duration_days=90
    ORDER BY e0.ends_at DESC LIMIT 1 FOR SHARE OF e0;
    IF NOT FOUND THEN RAISE EXCEPTION 'channel_addon_requires_90_day'; END IF;

    included_end:=least(e.starts_at+interval '30 days',e.ends_at);
    SELECT greatest(included_end,coalesce(max(g.expires_at),included_end)) INTO covered_end
    FROM public.membership_channel_grants g
    WHERE g.user_id=u AND g.entitlement_id=e.id AND g.revoked_at IS NULL;
    IF covered_end>=e.ends_at THEN RAISE EXCEPTION 'channel_already_covered'; END IF;

    IF EXISTS(
      SELECT 1 FROM public.membership_purchases px
      JOIN public.membership_packages pp ON pp.id=px.package_id AND pp.product_type='channel_addon'
      WHERE px.user_id=u AND px.status IN ('awaiting_payment','proof_submitted','awaiting_admin_review')
        AND px.expires_at>now()
    ) THEN RAISE EXCEPTION 'channel_addon_purchase_pending'; END IF;
  END IF;

  IF p_voucher_hash IS NOT NULL THEN
    SELECT * INTO v FROM public.membership_vouchers
    WHERE code_hash=p_voucher_hash AND active AND now()>=valid_from
      AND (valid_until IS NULL OR now()<valid_until) FOR UPDATE;
    IF NOT FOUND
      OR (v.package_ids IS NOT NULL AND NOT p_package_id=ANY(v.package_ids))
      OR (v.total_limit IS NOT NULL AND (
        v.redemption_count+(SELECT count(*) FROM public.membership_voucher_redemptions r
          JOIN public.membership_purchases p ON p.id=r.purchase_id
          WHERE r.voucher_id=v.id AND r.status='reserved' AND p.expires_at>now())
      )>=v.total_limit)
      OR (SELECT count(*) FROM public.membership_voucher_redemptions r
        JOIN public.membership_purchases p ON p.id=r.purchase_id
        WHERE r.voucher_id=v.id AND r.user_id=u AND r.status IN ('reserved','finalized')
          AND (r.status='finalized' OR p.expires_at>now()))>=v.per_account_limit
    THEN RAISE EXCEPTION 'voucher_unavailable'; END IF;
    disc:=CASE WHEN v.discount_type='percent' THEN floor(sub*v.discount_value/100) ELSE v.discount_value END;
    disc:=least(sub,disc,coalesce(v.max_discount_idr,sub));
  END IF;

  INSERT INTO public.membership_purchases(
    user_id,package_id,voucher_id,status,subtotal_idr,discount_idr,final_amount_idr,bank_instructions,expires_at
  ) VALUES(u,pkg.id,v.id,'awaiting_payment',sub,disc,sub-disc,p_bank_instructions,now()+interval '24 hours')
  RETURNING id INTO pid;
  IF v.id IS NOT NULL THEN
    INSERT INTO public.membership_voucher_redemptions(voucher_id,user_id,purchase_id,discount_idr,status)
    VALUES(v.id,u,pid,disc,'reserved');
  END IF;
  INSERT INTO public.membership_audit_events(event_type,purchase_id,metadata)
  VALUES('purchase_created',pid,jsonb_build_object('amount',sub-disc,'productType',pkg.product_type));
  RETURN jsonb_build_object('purchaseId',pid,'finalAmount',sub-disc,'status','awaiting_payment',
    'bankInstructions',p_bank_instructions,'packageName',pkg.name,'packageSlug',pkg.slug,'productType',pkg.product_type);
END $$;

CREATE OR REPLACE FUNCTION public.membership_checkout_purchase(p_telegram_user_id bigint,p_voucher_hash text,p_bank_instructions text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.membership_checkout_sessions; result jsonb;
BEGIN
  SELECT * INTO s FROM public.membership_checkout_sessions
  WHERE telegram_user_id=p_telegram_user_id AND expires_at>now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'checkout_session_expired'; END IF;
  result:=public.membership_create_purchase(p_telegram_user_id,s.package_id,p_voucher_hash,p_bank_instructions);
  DELETE FROM public.membership_checkout_sessions WHERE telegram_user_id=p_telegram_user_id;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.membership_review_purchase(p_purchase_id uuid,p_approve boolean,p_reason text,p_admin_user_id uuid,p_idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  p public.membership_purchases; pkg public.membership_packages;
  e public.membership_entitlements; end_at timestamptz;
  included_end timestamptz; covered_end timestamptz; new_channel_end timestamptz;
  tg bigint;
BEGIN
  IF EXISTS(SELECT 1 FROM public.membership_audit_events WHERE idempotency_key=p_idempotency_key) THEN
    RETURN jsonb_build_object('duplicate',true);
  END IF;
  SELECT * INTO p FROM public.membership_purchases WHERE id=p_purchase_id FOR UPDATE;
  IF p.status<>'awaiting_admin_review' OR p.expires_at<=now() THEN RAISE EXCEPTION 'purchase_state_conflict'; END IF;
  SELECT * INTO pkg FROM public.membership_packages WHERE id=p.package_id;

  IF NOT p_approve THEN
    IF length(trim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'reason_required'; END IF;
    UPDATE public.membership_purchases SET status='rejected',rejected_at=now(),rejection_reason=p_reason,updated_at=now() WHERE id=p.id;
  ELSE
    IF EXISTS(SELECT 1 FROM public.app_users u WHERE u.id=p.user_id AND u.is_blocked=true) THEN RAISE EXCEPTION 'blocked_account'; END IF;

    IF pkg.product_type='channel_addon' THEN
      SELECT e0.* INTO e
      FROM public.membership_entitlements e0
      JOIN public.membership_purchases p0 ON p0.id=e0.purchase_id
      JOIN public.membership_packages base ON base.id=p0.package_id
      WHERE e0.user_id=p.user_id AND e0.status='active' AND e0.ends_at>now() AND NOT e0.lifetime
        AND base.product_type='membership' AND base.duration_days=90
      ORDER BY e0.ends_at DESC LIMIT 1 FOR UPDATE OF e0;
      IF NOT FOUND THEN RAISE EXCEPTION 'channel_addon_requires_90_day'; END IF;

      SELECT telegram_user_id INTO tg FROM public.app_user_telegram_verifications
      WHERE user_id=p.user_id AND telegram_verified_at IS NOT NULL;
      IF tg IS NULL THEN RAISE EXCEPTION 'telegram_verification_required'; END IF;

      included_end:=least(e.starts_at+interval '30 days',e.ends_at);
      SELECT greatest(included_end,coalesce(max(g.expires_at),included_end)) INTO covered_end
      FROM public.membership_channel_grants g
      WHERE g.user_id=p.user_id AND g.telegram_user_id=tg AND g.entitlement_id=e.id AND g.revoked_at IS NULL;
      IF covered_end>=e.ends_at THEN RAISE EXCEPTION 'channel_already_covered'; END IF;
      new_channel_end:=least(covered_end+interval '30 days',e.ends_at);

      INSERT INTO public.membership_channel_grants(user_id,telegram_user_id,entitlement_id,expires_at)
      VALUES(p.user_id,tg,e.id,new_channel_end)
      ON CONFLICT(user_id,telegram_user_id,entitlement_id) DO UPDATE SET
        expires_at=excluded.expires_at,revoked_at=NULL
      RETURNING expires_at INTO end_at;
    ELSE
      IF NOT pkg.lifetime THEN
        SELECT greatest(now(),coalesce(max(ends_at),now()))+make_interval(days=>pkg.duration_days)
        INTO end_at FROM public.membership_entitlements
        WHERE user_id=p.user_id AND status='active' AND NOT lifetime;
      END IF;
      INSERT INTO public.membership_entitlements(user_id,purchase_id,status,ends_at,lifetime)
      VALUES(p.user_id,p.id,'active',end_at,pkg.lifetime)
      ON CONFLICT(purchase_id) DO NOTHING;
    END IF;

    UPDATE public.membership_purchases SET status='approved',approved_at=now(),updated_at=now() WHERE id=p.id;
    UPDATE public.membership_voucher_redemptions SET status='finalized',redeemed_at=now()
    WHERE purchase_id=p.id AND status='reserved';
    UPDATE public.membership_vouchers SET redemption_count=redemption_count+1
    WHERE id=p.voucher_id AND p.voucher_id IS NOT NULL;
    UPDATE public.app_users SET is_approved=true WHERE id=p.user_id AND is_approved=false AND is_blocked=false;
  END IF;

  INSERT INTO public.membership_audit_events(event_type,actor_user_id,purchase_id,idempotency_key,metadata)
  VALUES(CASE WHEN p_approve THEN 'purchase_approved' ELSE 'purchase_rejected' END,
    p_admin_user_id,p.id,p_idempotency_key,jsonb_build_object('reason',p_reason,'productType',pkg.product_type,'channelEndsAt',new_channel_end));
  RETURN jsonb_build_object('approved',p_approve,'duplicate',false,'productType',pkg.product_type,
    'packageName',pkg.name,'lifetime',pkg.lifetime,'endsAt',end_at,'channelEndsAt',new_channel_end);
END $$;

CREATE OR REPLACE FUNCTION public.membership_issue_channel_grant(p_telegram_user_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  u uuid; e public.membership_entitlements; pkg public.membership_packages;
  gid uuid; admin_link public.membership_admin_telegram_links;
  included_end timestamptz; grant_end timestamptz; allowed_end timestamptz;
BEGIN
  SELECT * INTO admin_link FROM public.membership_admin_telegram_links
  WHERE telegram_user_id=p_telegram_user_id AND revoked_at IS NULL;
  IF FOUND AND EXISTS(
    SELECT 1 FROM public.app_users x WHERE x.id=admin_link.user_id AND lower(x.username)='budi'
      AND x.is_approved=true AND x.is_blocked=false
  ) THEN
    u:=admin_link.user_id;
    SELECT id INTO gid FROM public.membership_channel_grants
    WHERE user_id=u AND telegram_user_id=p_telegram_user_id AND entitlement_id IS NULL AND revoked_at IS NULL LIMIT 1;
    IF gid IS NULL THEN
      INSERT INTO public.membership_channel_grants(user_id,telegram_user_id,entitlement_id,expires_at)
      VALUES(u,p_telegram_user_id,NULL,NULL) RETURNING id INTO gid;
    END IF;
    allowed_end:=NULL;
  ELSE
    SELECT av.user_id INTO u
    FROM public.app_user_telegram_verifications av
    JOIN public.app_users au ON au.id=av.user_id
    WHERE av.telegram_user_id=p_telegram_user_id AND av.telegram_verified_at IS NOT NULL
      AND au.is_approved=true AND au.is_blocked=false;

    SELECT e0.*,mp.* INTO e,pkg
    FROM public.membership_entitlements e0
    JOIN public.membership_purchases p ON p.id=e0.purchase_id
    JOIN public.membership_packages mp ON mp.id=p.package_id AND mp.product_type='membership'
    WHERE e0.user_id=u AND e0.status='active' AND (e0.lifetime OR e0.ends_at>now())
    ORDER BY e0.lifetime DESC,e0.ends_at DESC NULLS FIRST LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'entitlement_required'; END IF;

    IF e.lifetime THEN
      allowed_end:=NULL;
    ELSIF pkg.duration_days=90 THEN
      included_end:=least(e.starts_at+interval '30 days',e.ends_at);
      SELECT max(expires_at) INTO grant_end FROM public.membership_channel_grants
      WHERE user_id=u AND telegram_user_id=p_telegram_user_id AND entitlement_id=e.id AND revoked_at IS NULL;
      allowed_end:=greatest(included_end,coalesce(grant_end,included_end));
      IF allowed_end<=now() THEN RAISE EXCEPTION 'channel_extension_required'; END IF;
    ELSE
      RAISE EXCEPTION 'channel_not_included';
    END IF;

    INSERT INTO public.membership_channel_grants(user_id,telegram_user_id,entitlement_id,expires_at)
    VALUES(u,p_telegram_user_id,e.id,allowed_end)
    ON CONFLICT(user_id,telegram_user_id,entitlement_id) DO UPDATE SET
      expires_at=excluded.expires_at,revoked_at=NULL
    RETURNING id INTO gid;
  END IF;

  INSERT INTO public.membership_audit_events(event_type,actor_user_id,metadata)
  VALUES('channel_grant_issued',u,jsonb_build_object('grantId',gid,'expiresAt',allowed_end));
  RETURN jsonb_build_object('grantId',gid,'expiresAt',allowed_end);
END $$;

CREATE OR REPLACE FUNCTION public.membership_admin_bot_review_purchase(p_purchase_id uuid,p_approve boolean,p_reason text,p_admin_user_id uuid,p_idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE core_result jsonb; review_context jsonb;
BEGIN
  core_result:=public.membership_review_purchase(p_purchase_id,p_approve,p_reason,p_admin_user_id,p_idempotency_key);
  SELECT jsonb_build_object(
    'customer_chat_id',v.telegram_private_chat_id,
    'package_name',pkg.name,
    'product_type',pkg.product_type,
    'lifetime',pkg.lifetime,
    'ends_at',CASE WHEN pkg.product_type='channel_addon'
      THEN (core_result->>'channelEndsAt')::timestamptz ELSE e.ends_at END
  ) INTO review_context
  FROM public.membership_purchases p
  JOIN public.membership_packages pkg ON pkg.id=p.package_id
  LEFT JOIN public.app_user_telegram_verifications v ON v.user_id=p.user_id AND v.telegram_verified_at IS NOT NULL
  LEFT JOIN public.membership_entitlements e ON e.purchase_id=p.id
  WHERE p.id=p_purchase_id;
  IF review_context IS NULL THEN RAISE EXCEPTION 'review_context_unavailable'; END IF;
  RETURN coalesce(core_result,'{}'::jsonb)||review_context;
END $$;

REVOKE ALL ON FUNCTION
  public.membership_account_for_telegram(bigint),
  public.membership_begin_checkout(bigint,text),
  public.membership_checkout_session(bigint),
  public.membership_cancel_checkout(bigint),
  public.membership_create_purchase(bigint,uuid,text,text),
  public.membership_checkout_purchase(bigint,text,text),
  public.membership_review_purchase(uuid,boolean,text,uuid,text),
  public.membership_issue_channel_grant(bigint),
  public.membership_admin_bot_review_purchase(uuid,boolean,text,uuid,text)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
  public.membership_account_for_telegram(bigint),
  public.membership_begin_checkout(bigint,text),
  public.membership_checkout_session(bigint),
  public.membership_cancel_checkout(bigint),
  public.membership_create_purchase(bigint,uuid,text,text),
  public.membership_checkout_purchase(bigint,text,text),
  public.membership_review_purchase(uuid,boolean,text,uuid,text),
  public.membership_issue_channel_grant(bigint),
  public.membership_admin_bot_review_purchase(uuid,boolean,text,uuid,text)
TO service_role;
