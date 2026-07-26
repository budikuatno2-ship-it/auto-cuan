-- Telegram Membership V2 / Part 2
-- Correct approval behavior for channel renewals and enforce 90-day/lifetime channel rules.
-- Apply to staging after Part 1.

CREATE OR REPLACE FUNCTION public.membership_review_purchase(
  p_purchase_id uuid,
  p_approve boolean,
  p_reason text,
  p_admin_user_id uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  purchase_row public.membership_purchases;
  package_row public.membership_packages;
  entitlement public.membership_entitlements;
  entitlement_end timestamptz;
  included_end timestamptz;
  covered_end timestamptz;
  new_channel_end timestamptz;
  telegram_id bigint;
BEGIN
  IF EXISTS(
    SELECT 1 FROM public.membership_audit_events
    WHERE idempotency_key=p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('duplicate',true);
  END IF;

  SELECT * INTO purchase_row
  FROM public.membership_purchases
  WHERE id=p_purchase_id
  FOR UPDATE;
  IF NOT FOUND
    OR purchase_row.status<>'awaiting_admin_review'
    OR purchase_row.expires_at<=now() THEN
    RAISE EXCEPTION 'purchase_state_conflict';
  END IF;

  SELECT * INTO package_row
  FROM public.membership_packages
  WHERE id=purchase_row.package_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'package_unavailable'; END IF;

  IF NOT p_approve THEN
    IF length(trim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'reason_required'; END IF;
    UPDATE public.membership_purchases
    SET status='rejected',rejected_at=now(),rejection_reason=p_reason,updated_at=now()
    WHERE id=purchase_row.id;
  ELSE
    IF EXISTS(
      SELECT 1 FROM public.app_users
      WHERE id=purchase_row.user_id AND is_blocked=true
    ) THEN
      RAISE EXCEPTION 'blocked_account';
    END IF;

    IF package_row.product_type='channel_addon' THEN
      SELECT e.* INTO entitlement
      FROM public.membership_entitlements e
      JOIN public.membership_purchases base_purchase ON base_purchase.id=e.purchase_id
      JOIN public.membership_packages base_package ON base_package.id=base_purchase.package_id
      WHERE e.user_id=purchase_row.user_id
        AND e.status='active'
        AND e.ends_at>now()
        AND NOT e.lifetime
        AND base_package.product_type='membership'
        AND base_package.duration_days=90
      ORDER BY e.ends_at DESC
      LIMIT 1
      FOR UPDATE OF e;
      IF NOT FOUND THEN RAISE EXCEPTION 'channel_addon_requires_90_day'; END IF;

      SELECT telegram_user_id INTO telegram_id
      FROM public.app_user_telegram_verifications
      WHERE user_id=purchase_row.user_id
        AND telegram_verified_at IS NOT NULL;
      IF telegram_id IS NULL THEN RAISE EXCEPTION 'telegram_verification_required'; END IF;

      included_end:=least(entitlement.starts_at+interval '30 days',entitlement.ends_at);
      SELECT greatest(included_end,coalesce(max(g.expires_at),included_end))
      INTO covered_end
      FROM public.membership_channel_grants g
      WHERE g.user_id=purchase_row.user_id
        AND g.telegram_user_id=telegram_id
        AND g.entitlement_id=entitlement.id
        AND g.revoked_at IS NULL;

      IF covered_end>=entitlement.ends_at THEN RAISE EXCEPTION 'channel_already_covered'; END IF;
      new_channel_end:=least(covered_end+interval '30 days',entitlement.ends_at);

      INSERT INTO public.membership_channel_grants(
        user_id,telegram_user_id,entitlement_id,expires_at
      ) VALUES(
        purchase_row.user_id,telegram_id,entitlement.id,new_channel_end
      )
      ON CONFLICT(user_id,telegram_user_id,entitlement_id) DO UPDATE SET
        expires_at=excluded.expires_at,
        revoked_at=NULL
      RETURNING expires_at INTO entitlement_end;
    ELSE
      IF NOT package_row.lifetime THEN
        SELECT greatest(now(),coalesce(max(e.ends_at),now()))
          +make_interval(days=>package_row.duration_days)
        INTO entitlement_end
        FROM public.membership_entitlements e
        WHERE e.user_id=purchase_row.user_id
          AND e.status='active'
          AND NOT e.lifetime;
      END IF;

      INSERT INTO public.membership_entitlements(
        user_id,purchase_id,status,ends_at,lifetime
      ) VALUES(
        purchase_row.user_id,purchase_row.id,'active',entitlement_end,package_row.lifetime
      )
      ON CONFLICT(purchase_id) DO NOTHING;
    END IF;

    UPDATE public.membership_purchases
    SET status='approved',approved_at=now(),updated_at=now()
    WHERE id=purchase_row.id;

    UPDATE public.membership_voucher_redemptions
    SET status='finalized',redeemed_at=now()
    WHERE purchase_id=purchase_row.id AND status='reserved';

    UPDATE public.membership_vouchers
    SET redemption_count=redemption_count+1
    WHERE id=purchase_row.voucher_id AND purchase_row.voucher_id IS NOT NULL;

    UPDATE public.app_users
    SET is_approved=true
    WHERE id=purchase_row.user_id AND is_approved=false AND is_blocked=false;
  END IF;

  INSERT INTO public.membership_audit_events(
    event_type,actor_user_id,purchase_id,idempotency_key,metadata
  ) VALUES(
    CASE WHEN p_approve THEN 'purchase_approved' ELSE 'purchase_rejected' END,
    p_admin_user_id,
    purchase_row.id,
    p_idempotency_key,
    jsonb_build_object(
      'reason',p_reason,
      'productType',package_row.product_type,
      'channelEndsAt',new_channel_end
    )
  );

  RETURN jsonb_build_object(
    'approved',p_approve,
    'duplicate',false,
    'productType',package_row.product_type,
    'packageName',package_row.name,
    'lifetime',package_row.lifetime,
    'endsAt',entitlement_end,
    'channelEndsAt',new_channel_end
  );
END $$;

CREATE OR REPLACE FUNCTION public.membership_issue_channel_grant(
  p_telegram_user_id bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  user_id_value uuid;
  entitlement public.membership_entitlements;
  package_row public.membership_packages;
  grant_id uuid;
  admin_link public.membership_admin_telegram_links;
  included_end timestamptz;
  grant_end timestamptz;
  allowed_end timestamptz;
BEGIN
  SELECT * INTO admin_link
  FROM public.membership_admin_telegram_links
  WHERE telegram_user_id=p_telegram_user_id AND revoked_at IS NULL;

  IF FOUND AND EXISTS(
    SELECT 1 FROM public.app_users u
    WHERE u.id=admin_link.user_id
      AND lower(u.username)='budi'
      AND u.is_approved=true
      AND u.is_blocked=false
  ) THEN
    user_id_value:=admin_link.user_id;
    SELECT id INTO grant_id
    FROM public.membership_channel_grants
    WHERE user_id=user_id_value
      AND telegram_user_id=p_telegram_user_id
      AND entitlement_id IS NULL
      AND revoked_at IS NULL
    LIMIT 1;
    IF grant_id IS NULL THEN
      INSERT INTO public.membership_channel_grants(
        user_id,telegram_user_id,entitlement_id,expires_at
      ) VALUES(
        user_id_value,p_telegram_user_id,NULL,NULL
      ) RETURNING id INTO grant_id;
    END IF;
    allowed_end:=NULL;
  ELSE
    SELECT v.user_id INTO user_id_value
    FROM public.app_user_telegram_verifications v
    JOIN public.app_users u ON u.id=v.user_id
    WHERE v.telegram_user_id=p_telegram_user_id
      AND v.telegram_verified_at IS NOT NULL
      AND u.is_approved=true
      AND u.is_blocked=false;
    IF user_id_value IS NULL THEN RAISE EXCEPTION 'verified_approved_account_required'; END IF;

    SELECT e.* INTO entitlement
    FROM public.membership_entitlements e
    JOIN public.membership_purchases p ON p.id=e.purchase_id
    JOIN public.membership_packages mp ON mp.id=p.package_id
    WHERE e.user_id=user_id_value
      AND e.status='active'
      AND (e.lifetime OR e.ends_at>now())
      AND mp.product_type='membership'
    ORDER BY e.lifetime DESC,e.ends_at DESC NULLS FIRST
    LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'entitlement_required'; END IF;

    SELECT mp.* INTO package_row
    FROM public.membership_purchases p
    JOIN public.membership_packages mp ON mp.id=p.package_id
    WHERE p.id=entitlement.purchase_id;

    IF entitlement.lifetime THEN
      allowed_end:=NULL;
    ELSIF package_row.duration_days=90 THEN
      included_end:=least(entitlement.starts_at+interval '30 days',entitlement.ends_at);
      SELECT max(g.expires_at) INTO grant_end
      FROM public.membership_channel_grants g
      WHERE g.user_id=user_id_value
        AND g.telegram_user_id=p_telegram_user_id
        AND g.entitlement_id=entitlement.id
        AND g.revoked_at IS NULL;
      allowed_end:=greatest(included_end,coalesce(grant_end,included_end));
      IF allowed_end<=now() THEN RAISE EXCEPTION 'channel_extension_required'; END IF;
    ELSE
      RAISE EXCEPTION 'channel_not_included';
    END IF;

    INSERT INTO public.membership_channel_grants(
      user_id,telegram_user_id,entitlement_id,expires_at
    ) VALUES(
      user_id_value,p_telegram_user_id,entitlement.id,allowed_end
    )
    ON CONFLICT(user_id,telegram_user_id,entitlement_id) DO UPDATE SET
      expires_at=excluded.expires_at,
      revoked_at=NULL
    RETURNING id INTO grant_id;
  END IF;

  INSERT INTO public.membership_audit_events(event_type,actor_user_id,metadata)
  VALUES(
    'channel_grant_issued',user_id_value,
    jsonb_build_object('grantId',grant_id,'expiresAt',allowed_end)
  );

  RETURN jsonb_build_object('grantId',grant_id,'expiresAt',allowed_end);
END $$;

CREATE OR REPLACE FUNCTION public.membership_admin_bot_review_purchase(
  p_purchase_id uuid,
  p_approve boolean,
  p_reason text,
  p_admin_user_id uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  core_result jsonb;
  review_context jsonb;
BEGIN
  core_result:=public.membership_review_purchase(
    p_purchase_id,p_approve,p_reason,p_admin_user_id,p_idempotency_key
  );

  SELECT jsonb_build_object(
    'customer_chat_id',verification.telegram_private_chat_id,
    'package_name',package_row.name,
    'product_type',package_row.product_type,
    'lifetime',package_row.lifetime,
    'ends_at',CASE
      WHEN package_row.product_type='channel_addon'
        THEN NULLIF(core_result->>'channelEndsAt','')::timestamptz
      ELSE entitlement.ends_at
    END
  ) INTO review_context
  FROM public.membership_purchases purchase_row
  JOIN public.membership_packages package_row ON package_row.id=purchase_row.package_id
  LEFT JOIN public.app_user_telegram_verifications verification
    ON verification.user_id=purchase_row.user_id
   AND verification.telegram_verified_at IS NOT NULL
  LEFT JOIN public.membership_entitlements entitlement
    ON entitlement.purchase_id=purchase_row.id
  WHERE purchase_row.id=p_purchase_id;

  IF review_context IS NULL THEN RAISE EXCEPTION 'review_context_unavailable'; END IF;
  RETURN coalesce(core_result,'{}'::jsonb)||review_context;
END $$;

CREATE OR REPLACE FUNCTION public.membership_admin_bot_create_voucher(
  p_code_hash text,
  p_code_hint text,
  p_discount_type text,
  p_discount_value bigint,
  p_package_slug text,
  p_total_limit integer,
  p_valid_days integer,
  p_admin_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  voucher_id_value uuid;
  package_ids_value uuid[];
BEGIN
  IF p_code_hash !~ '^[0-9a-f]{64}$'
    OR p_code_hint !~ '^[A-Z0-9]{4}…[A-Z0-9]{4}$'
    OR p_discount_type NOT IN ('percent','fixed')
    OR p_discount_value<1
    OR (p_discount_type='percent' AND p_discount_value>100)
    OR p_discount_value>1000000000
    OR p_package_slug NOT IN ('channel-30','channel-90','lifetime','channel-addon-30','all')
    OR coalesce(p_total_limit,1)<1
    OR coalesce(p_valid_days,1)<1
  THEN
    RAISE EXCEPTION 'voucher_policy_invalid';
  END IF;

  IF p_package_slug<>'all' THEN
    SELECT array_agg(id) INTO package_ids_value
    FROM public.membership_packages
    WHERE slug=p_package_slug AND active;
    IF package_ids_value IS NULL THEN RAISE EXCEPTION 'package_unavailable'; END IF;
  END IF;

  INSERT INTO public.membership_vouchers(
    code_hash,code_hint,discount_type,discount_value,package_ids,
    active,valid_from,valid_until,total_limit,per_account_limit
  ) VALUES(
    p_code_hash,p_code_hint,p_discount_type,p_discount_value,package_ids_value,
    true,now(),CASE WHEN p_valid_days IS NULL THEN NULL ELSE now()+make_interval(days=>p_valid_days) END,
    p_total_limit,1
  ) RETURNING id INTO voucher_id_value;

  INSERT INTO public.membership_audit_events(event_type,actor_user_id,metadata)
  VALUES('voucher_created',p_admin_user_id,jsonb_build_object('voucherId',voucher_id_value));
  RETURN jsonb_build_object('id',voucher_id_value,'code_hint',p_code_hint);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'voucher_duplicate';
END $$;

CREATE OR REPLACE FUNCTION public.membership_admin_bot_user_lookup(p_query text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'masked_username',left(u.username,2)||repeat('*',greatest(length(u.username)-2,2)),
    'approved',u.is_approved,
    'blocked',u.is_blocked,
    'telegram_verified',verification.telegram_verified_at IS NOT NULL,
    'package_name',package_row.name,
    'lifetime',coalesce(entitlement.lifetime,false),
    'ends_at',entitlement.ends_at,
    'pending_payment_status',(
      SELECT p.status
      FROM public.membership_purchases p
      WHERE p.user_id=u.id
        AND p.status IN ('awaiting_payment','awaiting_admin_review','rejected')
      ORDER BY p.created_at DESC LIMIT 1
    ),
    'channel_access',CASE
      WHEN entitlement.lifetime THEN true
      WHEN package_row.duration_days=90 THEN
        greatest(
          least(entitlement.starts_at+interval '30 days',entitlement.ends_at),
          coalesce((
            SELECT max(g.expires_at)
            FROM public.membership_channel_grants g
            WHERE g.user_id=u.id
              AND g.entitlement_id=entitlement.id
              AND g.revoked_at IS NULL
          ),least(entitlement.starts_at+interval '30 days',entitlement.ends_at))
        )>now()
      ELSE false
    END,
    'dashboard_access',coalesce(entitlement.lifetime,false)
  )
  FROM public.app_users u
  LEFT JOIN public.app_user_telegram_verifications verification ON verification.user_id=u.id
  LEFT JOIN LATERAL (
    SELECT e.*
    FROM public.membership_entitlements e
    JOIN public.membership_purchases p ON p.id=e.purchase_id
    JOIN public.membership_packages mp ON mp.id=p.package_id
    WHERE e.user_id=u.id
      AND e.status='active'
      AND (e.lifetime OR e.ends_at>now())
      AND mp.product_type='membership'
    ORDER BY e.lifetime DESC,e.ends_at DESC
    LIMIT 1
  ) entitlement ON true
  LEFT JOIN public.membership_purchases entitlement_purchase
    ON entitlement_purchase.id=entitlement.purchase_id
  LEFT JOIN public.membership_packages package_row
    ON package_row.id=entitlement_purchase.package_id
  WHERE lower(u.username)=lower(p_query)
     OR (p_query ~ '^[0-9]{1,20}$' AND verification.telegram_user_id=p_query::bigint)
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION
  public.membership_review_purchase(uuid,boolean,text,uuid,text),
  public.membership_issue_channel_grant(bigint),
  public.membership_admin_bot_review_purchase(uuid,boolean,text,uuid,text),
  public.membership_admin_bot_create_voucher(text,text,text,bigint,text,integer,integer,uuid),
  public.membership_admin_bot_user_lookup(text)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
  public.membership_review_purchase(uuid,boolean,text,uuid,text),
  public.membership_issue_channel_grant(bigint),
  public.membership_admin_bot_review_purchase(uuid,boolean,text,uuid,text),
  public.membership_admin_bot_create_voucher(text,text,text,bigint,text,integer,integer,uuid),
  public.membership_admin_bot_user_lookup(text)
TO service_role;
