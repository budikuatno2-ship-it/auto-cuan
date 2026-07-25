-- Telegram Membership V2 / Part 1
-- Guided checkout, corrected package catalog, channel add-on product, and safe cancellation.
-- Apply to staging before Part 2.

ALTER TABLE public.membership_packages
  ADD COLUMN IF NOT EXISTS product_type text;
UPDATE public.membership_packages SET product_type='membership' WHERE product_type IS NULL;
ALTER TABLE public.membership_packages ALTER COLUMN product_type SET DEFAULT 'membership';
ALTER TABLE public.membership_packages ALTER COLUMN product_type SET NOT NULL;
DO $$
BEGIN
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
  'Tambahan channel 30 hari khusus pemilik paket Bot 90 Hari yang masih aktif.',
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
  admin_link public.membership_admin_telegram_links;
  app_user public.app_users;
  verification public.app_user_telegram_verifications;
  entitlement public.membership_entitlements;
  package_row public.membership_packages;
  pending_review boolean;
  included_end timestamptz;
  grant_end timestamptz;
  channel_end timestamptz;
  channel_access boolean:=false;
  addon_available boolean:=false;
BEGIN
  SELECT * INTO admin_link
  FROM public.membership_admin_telegram_links
  WHERE telegram_user_id=p_telegram_user_id AND revoked_at IS NULL;

  IF FOUND THEN
    SELECT * INTO app_user
    FROM public.app_users
    WHERE id=admin_link.user_id AND lower(username)='budi'
      AND is_approved=true AND is_blocked=false;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'verified',true,'isAdmin',true,'username',app_user.username,
        'accountStatus','active','blocked',false,'botAccess',true,
        'channelAccess',true,'dashboardAccess',true,'entitlement',NULL,
        'pendingPurchase',false,'channelCoverageEndsAt',NULL,
        'channelAddonAvailable',false
      );
    END IF;
  END IF;

  SELECT * INTO verification
  FROM public.app_user_telegram_verifications
  WHERE telegram_user_id=p_telegram_user_id AND telegram_verified_at IS NOT NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO app_user FROM public.app_users WHERE id=verification.user_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.membership_purchases p
    WHERE p.user_id=verification.user_id
      AND p.status IN ('proof_submitted','awaiting_admin_review')
  ) INTO pending_review;

  IF app_user.is_blocked=true THEN
    RETURN jsonb_build_object(
      'verified',true,'isAdmin',false,'username',app_user.username,
      'accountStatus','blocked','blocked',true,'botAccess',false,
      'channelAccess',false,'dashboardAccess',false,'entitlement',NULL,
      'pendingPurchase',pending_review,'channelCoverageEndsAt',NULL,
      'channelAddonAvailable',false
    );
  END IF;

  IF app_user.is_approved IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'verified',true,'isAdmin',false,'username',app_user.username,
      'accountStatus','pending','blocked',false,'botAccess',false,
      'channelAccess',false,'dashboardAccess',false,'entitlement',NULL,
      'pendingPurchase',pending_review,'channelCoverageEndsAt',NULL,
      'channelAddonAvailable',false
    );
  END IF;

  SELECT e.* INTO entitlement
  FROM public.membership_entitlements e
  JOIN public.membership_purchases p ON p.id=e.purchase_id
  JOIN public.membership_packages mp ON mp.id=p.package_id
  WHERE e.user_id=verification.user_id
    AND e.status='active'
    AND (e.lifetime OR e.ends_at>now())
    AND mp.product_type='membership'
  ORDER BY e.lifetime DESC,e.ends_at DESC NULLS FIRST
  LIMIT 1;

  IF entitlement.id IS NOT NULL THEN
    SELECT mp.* INTO package_row
    FROM public.membership_purchases p
    JOIN public.membership_packages mp ON mp.id=p.package_id
    WHERE p.id=entitlement.purchase_id;

    IF entitlement.lifetime THEN
      channel_access:=true;
      channel_end:=NULL;
    ELSIF package_row.duration_days=90 THEN
      included_end:=least(entitlement.starts_at+interval '30 days',entitlement.ends_at);
      SELECT max(g.expires_at) INTO grant_end
      FROM public.membership_channel_grants g
      WHERE g.user_id=verification.user_id
        AND g.telegram_user_id=p_telegram_user_id
        AND g.entitlement_id=entitlement.id
        AND g.revoked_at IS NULL;
      channel_end:=greatest(included_end,coalesce(grant_end,included_end));
      channel_access:=channel_end>now();
      addon_available:=channel_end<entitlement.ends_at;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'verified',true,'isAdmin',false,'username',app_user.username,
    'accountStatus','approved','blocked',false,
    'botAccess',entitlement.id IS NOT NULL,
    'channelAccess',channel_access,
    'dashboardAccess',coalesce(entitlement.lifetime,false),
    'entitlement',CASE WHEN entitlement.id IS NULL THEN NULL ELSE jsonb_build_object(
      'status',entitlement.status,
      'lifetime',entitlement.lifetime,
      'startsAt',entitlement.starts_at,
      'endsAt',entitlement.ends_at,
      'packageName',package_row.name,
      'packageSlug',package_row.slug,
      'durationDays',package_row.duration_days
    ) END,
    'pendingPurchase',pending_review,
    'channelCoverageEndsAt',channel_end,
    'channelAddonAvailable',addon_available
  );
END $$;

CREATE OR REPLACE FUNCTION public.membership_begin_checkout(
  p_telegram_user_id bigint,
  p_package_slug text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  user_id_value uuid;
  package_row public.membership_packages;
  eligible boolean;
BEGIN
  SELECT v.user_id INTO user_id_value
  FROM public.app_user_telegram_verifications v
  JOIN public.app_users u ON u.id=v.user_id
  WHERE v.telegram_user_id=p_telegram_user_id
    AND v.telegram_verified_at IS NOT NULL
    AND u.is_approved=true
    AND u.is_blocked=false;
  IF user_id_value IS NULL THEN RAISE EXCEPTION 'verified_approved_account_required'; END IF;

  SELECT * INTO package_row
  FROM public.membership_packages
  WHERE slug=lower(p_package_slug) AND active
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'package_unavailable'; END IF;

  IF package_row.product_type='channel_addon' THEN
    SELECT EXISTS(
      SELECT 1
      FROM public.membership_entitlements e
      JOIN public.membership_purchases p ON p.id=e.purchase_id
      JOIN public.membership_packages base ON base.id=p.package_id
      WHERE e.user_id=user_id_value
        AND e.status='active'
        AND e.ends_at>now()
        AND NOT e.lifetime
        AND base.product_type='membership'
        AND base.duration_days=90
    ) INTO eligible;
    IF NOT eligible THEN RAISE EXCEPTION 'channel_addon_requires_90_day'; END IF;
  END IF;

  INSERT INTO public.membership_checkout_sessions(
    telegram_user_id,user_id,package_id,expires_at
  ) VALUES(
    p_telegram_user_id,user_id_value,package_row.id,now()+interval '10 minutes'
  )
  ON CONFLICT(telegram_user_id) DO UPDATE SET
    user_id=excluded.user_id,
    package_id=excluded.package_id,
    state='voucher_input',
    expires_at=excluded.expires_at,
    updated_at=now();

  RETURN jsonb_build_object(
    'packageId',package_row.id,
    'packageSlug',package_row.slug,
    'packageName',package_row.name,
    'priceIdr',package_row.price_idr,
    'productType',package_row.product_type,
    'expiresAt',now()+interval '10 minutes'
  );
END $$;

CREATE OR REPLACE FUNCTION public.membership_checkout_session(
  p_telegram_user_id bigint
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'packageId',p.id,
    'packageSlug',p.slug,
    'packageName',p.name,
    'priceIdr',p.price_idr,
    'productType',p.product_type,
    'expiresAt',s.expires_at
  )
  FROM public.membership_checkout_sessions s
  JOIN public.membership_packages p ON p.id=s.package_id
  WHERE s.telegram_user_id=p_telegram_user_id
    AND s.expires_at>now();
$$;

CREATE OR REPLACE FUNCTION public.membership_cancel_checkout(
  p_telegram_user_id bigint
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  DELETE FROM public.membership_checkout_sessions
  WHERE telegram_user_id=p_telegram_user_id;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.membership_create_purchase(
  p_telegram_user_id bigint,
  p_package_id uuid,
  p_voucher_hash text,
  p_bank_instructions text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  user_id_value uuid;
  package_row public.membership_packages;
  voucher_row public.membership_vouchers;
  voucher_id_value uuid;
  subtotal bigint;
  discount bigint:=0;
  purchase_id_value uuid;
  entitlement public.membership_entitlements;
  included_end timestamptz;
  covered_end timestamptz;
BEGIN
  IF length(trim(coalesce(p_bank_instructions,'')))<10
    OR length(p_bank_instructions)>1000 THEN
    RAISE EXCEPTION 'bank_instructions_unavailable';
  END IF;

  SELECT v.user_id INTO user_id_value
  FROM public.app_user_telegram_verifications v
  JOIN public.app_users u ON u.id=v.user_id
  WHERE v.telegram_user_id=p_telegram_user_id
    AND v.telegram_verified_at IS NOT NULL
    AND u.is_blocked=false;
  IF user_id_value IS NULL THEN RAISE EXCEPTION 'verified_unblocked_account_required'; END IF;

  SELECT * INTO package_row
  FROM public.membership_packages
  WHERE id=p_package_id AND active
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'package_unavailable'; END IF;
  subtotal:=package_row.price_idr;

  IF package_row.product_type='channel_addon' THEN
    SELECT e.* INTO entitlement
    FROM public.membership_entitlements e
    JOIN public.membership_purchases p ON p.id=e.purchase_id
    JOIN public.membership_packages base ON base.id=p.package_id
    WHERE e.user_id=user_id_value
      AND e.status='active'
      AND e.ends_at>now()
      AND NOT e.lifetime
      AND base.product_type='membership'
      AND base.duration_days=90
    ORDER BY e.ends_at DESC
    LIMIT 1
    FOR SHARE OF e;
    IF NOT FOUND THEN RAISE EXCEPTION 'channel_addon_requires_90_day'; END IF;

    included_end:=least(entitlement.starts_at+interval '30 days',entitlement.ends_at);
    SELECT greatest(included_end,coalesce(max(g.expires_at),included_end))
    INTO covered_end
    FROM public.membership_channel_grants g
    WHERE g.user_id=user_id_value
      AND g.entitlement_id=entitlement.id
      AND g.revoked_at IS NULL;
    IF covered_end>=entitlement.ends_at THEN RAISE EXCEPTION 'channel_already_covered'; END IF;

    IF EXISTS(
      SELECT 1
      FROM public.membership_purchases pending_purchase
      JOIN public.membership_packages pending_package
        ON pending_package.id=pending_purchase.package_id
       AND pending_package.product_type='channel_addon'
      WHERE pending_purchase.user_id=user_id_value
        AND pending_purchase.status IN ('awaiting_payment','proof_submitted','awaiting_admin_review')
        AND pending_purchase.expires_at>now()
    ) THEN
      RAISE EXCEPTION 'channel_addon_purchase_pending';
    END IF;
  END IF;

  IF p_voucher_hash IS NOT NULL THEN
    SELECT * INTO voucher_row
    FROM public.membership_vouchers
    WHERE code_hash=p_voucher_hash
      AND active
      AND now()>=valid_from
      AND (valid_until IS NULL OR now()<valid_until)
    FOR UPDATE;

    IF NOT FOUND
      OR (voucher_row.package_ids IS NOT NULL AND NOT p_package_id=ANY(voucher_row.package_ids))
      OR (voucher_row.total_limit IS NOT NULL AND (
        voucher_row.redemption_count+(
          SELECT count(*)
          FROM public.membership_voucher_redemptions r
          JOIN public.membership_purchases p ON p.id=r.purchase_id
          WHERE r.voucher_id=voucher_row.id
            AND r.status='reserved'
            AND p.expires_at>now()
        )
      )>=voucher_row.total_limit)
      OR (
        SELECT count(*)
        FROM public.membership_voucher_redemptions r
        JOIN public.membership_purchases p ON p.id=r.purchase_id
        WHERE r.voucher_id=voucher_row.id
          AND r.user_id=user_id_value
          AND r.status IN ('reserved','finalized')
          AND (r.status='finalized' OR p.expires_at>now())
      )>=voucher_row.per_account_limit
    THEN
      RAISE EXCEPTION 'voucher_unavailable';
    END IF;

    voucher_id_value:=voucher_row.id;
    discount:=CASE
      WHEN voucher_row.discount_type='percent'
        THEN floor(subtotal*voucher_row.discount_value/100)
      ELSE voucher_row.discount_value
    END;
    discount:=least(subtotal,discount,coalesce(voucher_row.max_discount_idr,subtotal));
  END IF;

  INSERT INTO public.membership_purchases(
    user_id,package_id,voucher_id,status,subtotal_idr,
    discount_idr,final_amount_idr,bank_instructions,expires_at
  ) VALUES(
    user_id_value,package_row.id,voucher_id_value,'awaiting_payment',subtotal,
    discount,subtotal-discount,p_bank_instructions,now()+interval '24 hours'
  ) RETURNING id INTO purchase_id_value;

  IF voucher_id_value IS NOT NULL THEN
    INSERT INTO public.membership_voucher_redemptions(
      voucher_id,user_id,purchase_id,discount_idr,status
    ) VALUES(
      voucher_id_value,user_id_value,purchase_id_value,discount,'reserved'
    );
  END IF;

  INSERT INTO public.membership_audit_events(event_type,purchase_id,metadata)
  VALUES(
    'purchase_created',purchase_id_value,
    jsonb_build_object('amount',subtotal-discount,'productType',package_row.product_type)
  );

  RETURN jsonb_build_object(
    'purchaseId',purchase_id_value,
    'finalAmount',subtotal-discount,
    'status','awaiting_payment',
    'bankInstructions',p_bank_instructions,
    'packageName',package_row.name,
    'packageSlug',package_row.slug,
    'productType',package_row.product_type
  );
END $$;

CREATE OR REPLACE FUNCTION public.membership_checkout_purchase(
  p_telegram_user_id bigint,
  p_voucher_hash text,
  p_bank_instructions text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  session_row public.membership_checkout_sessions;
  result jsonb;
BEGIN
  SELECT * INTO session_row
  FROM public.membership_checkout_sessions
  WHERE telegram_user_id=p_telegram_user_id
    AND expires_at>now()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'checkout_session_expired'; END IF;

  result:=public.membership_create_purchase(
    p_telegram_user_id,session_row.package_id,p_voucher_hash,p_bank_instructions
  );
  DELETE FROM public.membership_checkout_sessions
  WHERE telegram_user_id=p_telegram_user_id;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.membership_cancel_purchase(
  p_telegram_user_id bigint,
  p_purchase_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  user_id_value uuid;
  voucher_id_value uuid;
BEGIN
  SELECT v.user_id INTO user_id_value
  FROM public.app_user_telegram_verifications v
  JOIN public.app_users u ON u.id=v.user_id
  WHERE v.telegram_user_id=p_telegram_user_id
    AND v.telegram_verified_at IS NOT NULL
    AND u.is_blocked=false;
  IF user_id_value IS NULL THEN RETURN false; END IF;

  UPDATE public.membership_purchases
  SET status='cancelled',updated_at=now()
  WHERE id=p_purchase_id
    AND user_id=user_id_value
    AND status='awaiting_payment'
  RETURNING voucher_id INTO voucher_id_value;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.membership_voucher_redemptions
  SET status='released',released_at=now()
  WHERE purchase_id=p_purchase_id AND status='reserved';

  INSERT INTO public.membership_audit_events(event_type,purchase_id)
  VALUES('purchase_cancelled',p_purchase_id);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION
  public.membership_account_for_telegram(bigint),
  public.membership_begin_checkout(bigint,text),
  public.membership_checkout_session(bigint),
  public.membership_cancel_checkout(bigint),
  public.membership_create_purchase(bigint,uuid,text,text),
  public.membership_checkout_purchase(bigint,text,text),
  public.membership_cancel_purchase(bigint,uuid)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
  public.membership_account_for_telegram(bigint),
  public.membership_begin_checkout(bigint,text),
  public.membership_checkout_session(bigint),
  public.membership_cancel_checkout(bigint),
  public.membership_create_purchase(bigint,uuid,text,text),
  public.membership_checkout_purchase(bigint,text,text),
  public.membership_cancel_purchase(bigint,uuid)
TO service_role;
