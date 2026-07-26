-- Telegram Membership V2 / Part 4
-- Complete guided payment flow: quote confirmation, active-order recovery,
-- paid/not-paid actions, captionless proof upload, and safe cancellation.
-- Apply to Supabase staging only after Parts 1-3.

ALTER TABLE public.membership_checkout_sessions
  ADD COLUMN IF NOT EXISTS voucher_hash text,
  ADD COLUMN IF NOT EXISTS purchase_id uuid REFERENCES public.membership_purchases(id);

ALTER TABLE public.membership_checkout_sessions
  DROP CONSTRAINT IF EXISTS membership_checkout_sessions_state_check;

ALTER TABLE public.membership_checkout_sessions
  ADD CONSTRAINT membership_checkout_sessions_state_check
  CHECK (state IN ('voucher_choice','voucher_input','confirm','proof_upload'));

ALTER TABLE public.membership_checkout_sessions
  DROP CONSTRAINT IF EXISTS membership_checkout_sessions_voucher_hash_check;

ALTER TABLE public.membership_checkout_sessions
  ADD CONSTRAINT membership_checkout_sessions_voucher_hash_check
  CHECK (voucher_hash IS NULL OR voucher_hash ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION public.membership_current_purchase_for_telegram(
  p_telegram_user_id bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'purchaseId',purchase_row.id,
    'packageId',package_row.id,
    'packageName',package_row.name,
    'packageSlug',package_row.slug,
    'productType',package_row.product_type,
    'status',purchase_row.status,
    'subtotal',purchase_row.subtotal_idr,
    'discount',purchase_row.discount_idr,
    'finalAmount',purchase_row.final_amount_idr,
    'bankInstructions',purchase_row.bank_instructions,
    'expiresAt',purchase_row.expires_at,
    'createdAt',purchase_row.created_at
  )
  INTO result
  FROM public.app_user_telegram_verifications verification
  JOIN public.membership_purchases purchase_row
    ON purchase_row.user_id=verification.user_id
  JOIN public.membership_packages package_row
    ON package_row.id=purchase_row.package_id
  WHERE verification.telegram_user_id=p_telegram_user_id
    AND verification.telegram_verified_at IS NOT NULL
    AND purchase_row.status IN (
      'awaiting_payment',
      'proof_submitted',
      'awaiting_admin_review',
      'rejected'
    )
    AND purchase_row.expires_at>now()
  ORDER BY purchase_row.created_at DESC
  LIMIT 1;

  RETURN result;
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
  SELECT verification.user_id
  INTO user_id_value
  FROM public.app_user_telegram_verifications verification
  JOIN public.app_users app_user ON app_user.id=verification.user_id
  WHERE verification.telegram_user_id=p_telegram_user_id
    AND verification.telegram_verified_at IS NOT NULL
    AND app_user.is_approved=true
    AND app_user.is_blocked=false;

  IF user_id_value IS NULL THEN
    RAISE EXCEPTION 'verified_approved_account_required';
  END IF;

  IF EXISTS(
    SELECT 1
    FROM public.membership_purchases purchase_row
    WHERE purchase_row.user_id=user_id_value
      AND purchase_row.status IN (
        'awaiting_payment',
        'proof_submitted',
        'awaiting_admin_review',
        'rejected'
      )
      AND purchase_row.expires_at>now()
  ) THEN
    RAISE EXCEPTION 'purchase_pending';
  END IF;

  SELECT *
  INTO package_row
  FROM public.membership_packages
  WHERE slug=lower(p_package_slug)
    AND active
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'package_unavailable';
  END IF;

  IF package_row.product_type='channel_addon' THEN
    SELECT EXISTS(
      SELECT 1
      FROM public.membership_entitlements entitlement
      JOIN public.membership_purchases base_purchase
        ON base_purchase.id=entitlement.purchase_id
      JOIN public.membership_packages base_package
        ON base_package.id=base_purchase.package_id
      WHERE entitlement.user_id=user_id_value
        AND entitlement.status='active'
        AND entitlement.ends_at>now()
        AND NOT entitlement.lifetime
        AND base_package.product_type='membership'
        AND base_package.duration_days=90
    ) INTO eligible;

    IF NOT eligible THEN
      RAISE EXCEPTION 'channel_addon_requires_90_day';
    END IF;
  END IF;

  INSERT INTO public.membership_checkout_sessions(
    telegram_user_id,user_id,package_id,state,voucher_hash,purchase_id,expires_at
  ) VALUES(
    p_telegram_user_id,user_id_value,package_row.id,'voucher_choice',NULL,NULL,
    now()+interval '10 minutes'
  )
  ON CONFLICT(telegram_user_id) DO UPDATE SET
    user_id=excluded.user_id,
    package_id=excluded.package_id,
    state='voucher_choice',
    voucher_hash=NULL,
    purchase_id=NULL,
    expires_at=excluded.expires_at,
    updated_at=now();

  RETURN jsonb_build_object(
    'packageId',package_row.id,
    'packageSlug',package_row.slug,
    'packageName',package_row.name,
    'priceIdr',package_row.price_idr,
    'productType',package_row.product_type,
    'state','voucher_choice',
    'expiresAt',now()+interval '10 minutes'
  );
END $$;

CREATE OR REPLACE FUNCTION public.membership_checkout_session(
  p_telegram_user_id bigint
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'packageId',package_row.id,
    'packageSlug',package_row.slug,
    'packageName',package_row.name,
    'priceIdr',package_row.price_idr,
    'productType',package_row.product_type,
    'state',session_row.state,
    'purchaseId',session_row.purchase_id,
    'expiresAt',session_row.expires_at
  )
  FROM public.membership_checkout_sessions session_row
  JOIN public.membership_packages package_row
    ON package_row.id=session_row.package_id
  WHERE session_row.telegram_user_id=p_telegram_user_id
    AND session_row.expires_at>now();
$$;

CREATE OR REPLACE FUNCTION public.membership_prepare_checkout(
  p_telegram_user_id bigint,
  p_voucher_hash text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  session_row public.membership_checkout_sessions;
  package_row public.membership_packages;
  voucher_row public.membership_vouchers;
  subtotal bigint;
  discount bigint:=0;
BEGIN
  SELECT *
  INTO session_row
  FROM public.membership_checkout_sessions
  WHERE telegram_user_id=p_telegram_user_id
    AND expires_at>now()
    AND state IN ('voucher_choice','voucher_input','confirm')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'checkout_session_expired';
  END IF;

  IF EXISTS(
    SELECT 1
    FROM public.membership_purchases purchase_row
    WHERE purchase_row.user_id=session_row.user_id
      AND purchase_row.status IN (
        'awaiting_payment',
        'proof_submitted',
        'awaiting_admin_review',
        'rejected'
      )
      AND purchase_row.expires_at>now()
  ) THEN
    RAISE EXCEPTION 'purchase_pending';
  END IF;

  SELECT *
  INTO package_row
  FROM public.membership_packages
  WHERE id=session_row.package_id
    AND active
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'package_unavailable';
  END IF;

  subtotal:=package_row.price_idr;

  IF p_voucher_hash IS NOT NULL THEN
    SELECT *
    INTO voucher_row
    FROM public.membership_vouchers
    WHERE code_hash=p_voucher_hash
      AND active
      AND now()>=valid_from
      AND (valid_until IS NULL OR now()<valid_until)
    FOR SHARE;

    IF NOT FOUND
      OR (
        voucher_row.package_ids IS NOT NULL
        AND NOT package_row.id=ANY(voucher_row.package_ids)
      )
      OR (
        voucher_row.total_limit IS NOT NULL
        AND (
          voucher_row.redemption_count+(
            SELECT count(*)
            FROM public.membership_voucher_redemptions redemption
            JOIN public.membership_purchases reserved_purchase
              ON reserved_purchase.id=redemption.purchase_id
            WHERE redemption.voucher_id=voucher_row.id
              AND redemption.status='reserved'
              AND reserved_purchase.expires_at>now()
          )
        )>=voucher_row.total_limit
      )
      OR (
        SELECT count(*)
        FROM public.membership_voucher_redemptions redemption
        JOIN public.membership_purchases prior_purchase
          ON prior_purchase.id=redemption.purchase_id
        WHERE redemption.voucher_id=voucher_row.id
          AND redemption.user_id=session_row.user_id
          AND redemption.status IN ('reserved','finalized')
          AND (
            redemption.status='finalized'
            OR prior_purchase.expires_at>now()
          )
      )>=voucher_row.per_account_limit
    THEN
      RAISE EXCEPTION 'voucher_unavailable';
    END IF;

    discount:=CASE
      WHEN voucher_row.discount_type='percent'
        THEN floor(subtotal*voucher_row.discount_value/100)
      ELSE voucher_row.discount_value
    END;

    discount:=least(
      subtotal,
      discount,
      coalesce(voucher_row.max_discount_idr,subtotal)
    );
  END IF;

  UPDATE public.membership_checkout_sessions
  SET state='confirm',
      voucher_hash=p_voucher_hash,
      purchase_id=NULL,
      expires_at=now()+interval '10 minutes',
      updated_at=now()
  WHERE telegram_user_id=p_telegram_user_id;

  RETURN jsonb_build_object(
    'packageId',package_row.id,
    'packageSlug',package_row.slug,
    'packageName',package_row.name,
    'productType',package_row.product_type,
    'subtotal',subtotal,
    'discount',discount,
    'finalAmount',subtotal-discount,
    'voucherApplied',p_voucher_hash IS NOT NULL,
    'state','confirm',
    'expiresAt',now()+interval '10 minutes'
  );
END $$;

CREATE OR REPLACE FUNCTION public.membership_checkout_purchase_confirmed(
  p_telegram_user_id bigint,
  p_bank_instructions text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  session_row public.membership_checkout_sessions;
  result jsonb;
  purchase_id_value uuid;
BEGIN
  SELECT *
  INTO session_row
  FROM public.membership_checkout_sessions
  WHERE telegram_user_id=p_telegram_user_id
    AND state='confirm'
    AND expires_at>now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'checkout_session_expired';
  END IF;

  IF EXISTS(
    SELECT 1
    FROM public.membership_purchases purchase_row
    WHERE purchase_row.user_id=session_row.user_id
      AND purchase_row.status IN (
        'awaiting_payment',
        'proof_submitted',
        'awaiting_admin_review',
        'rejected'
      )
      AND purchase_row.expires_at>now()
  ) THEN
    RAISE EXCEPTION 'purchase_pending';
  END IF;

  result:=public.membership_create_purchase(
    p_telegram_user_id,
    session_row.package_id,
    session_row.voucher_hash,
    p_bank_instructions
  );

  purchase_id_value:=(result->>'purchaseId')::uuid;

  UPDATE public.membership_checkout_sessions
  SET state='proof_upload',
      voucher_hash=NULL,
      purchase_id=purchase_id_value,
      expires_at=now()+interval '24 hours',
      updated_at=now()
  WHERE telegram_user_id=p_telegram_user_id;

  RETURN result||jsonb_build_object('existing',false);
END $$;

CREATE OR REPLACE FUNCTION public.membership_begin_proof_upload(
  p_telegram_user_id bigint,
  p_purchase_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  user_id_value uuid;
  purchase_row public.membership_purchases;
  package_row public.membership_packages;
BEGIN
  SELECT verification.user_id
  INTO user_id_value
  FROM public.app_user_telegram_verifications verification
  JOIN public.app_users app_user ON app_user.id=verification.user_id
  WHERE verification.telegram_user_id=p_telegram_user_id
    AND verification.telegram_verified_at IS NOT NULL
    AND app_user.is_blocked=false;

  IF user_id_value IS NULL THEN
    RAISE EXCEPTION 'verified_unblocked_account_required';
  END IF;

  SELECT *
  INTO purchase_row
  FROM public.membership_purchases
  WHERE id=p_purchase_id
    AND user_id=user_id_value
    AND status IN ('awaiting_payment','rejected')
    AND expires_at>now()
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase_state_conflict';
  END IF;

  SELECT *
  INTO package_row
  FROM public.membership_packages
  WHERE id=purchase_row.package_id;

  INSERT INTO public.membership_checkout_sessions(
    telegram_user_id,user_id,package_id,state,voucher_hash,purchase_id,expires_at
  ) VALUES(
    p_telegram_user_id,user_id_value,purchase_row.package_id,'proof_upload',NULL,
    purchase_row.id,least(purchase_row.expires_at,now()+interval '30 minutes')
  )
  ON CONFLICT(telegram_user_id) DO UPDATE SET
    user_id=excluded.user_id,
    package_id=excluded.package_id,
    state='proof_upload',
    voucher_hash=NULL,
    purchase_id=excluded.purchase_id,
    expires_at=excluded.expires_at,
    updated_at=now();

  RETURN jsonb_build_object(
    'purchaseId',purchase_row.id,
    'packageName',package_row.name,
    'packageSlug',package_row.slug,
    'status',purchase_row.status,
    'finalAmount',purchase_row.final_amount_idr,
    'bankInstructions',purchase_row.bank_instructions,
    'expiresAt',purchase_row.expires_at,
    'state','proof_upload'
  );
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
  SELECT verification.user_id
  INTO user_id_value
  FROM public.app_user_telegram_verifications verification
  JOIN public.app_users app_user ON app_user.id=verification.user_id
  WHERE verification.telegram_user_id=p_telegram_user_id
    AND verification.telegram_verified_at IS NOT NULL
    AND app_user.is_blocked=false;

  IF user_id_value IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.membership_purchases
  SET status='cancelled',updated_at=now()
  WHERE id=p_purchase_id
    AND user_id=user_id_value
    AND status IN ('awaiting_payment','rejected')
  RETURNING voucher_id INTO voucher_id_value;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.membership_voucher_redemptions
  SET status='released',released_at=now()
  WHERE purchase_id=p_purchase_id
    AND status='reserved';

  DELETE FROM public.membership_checkout_sessions
  WHERE telegram_user_id=p_telegram_user_id
     OR purchase_id=p_purchase_id;

  INSERT INTO public.membership_audit_events(event_type,purchase_id)
  VALUES('purchase_cancelled',p_purchase_id);

  RETURN true;
END $$;

REVOKE ALL ON FUNCTION
  public.membership_current_purchase_for_telegram(bigint),
  public.membership_begin_checkout(bigint,text),
  public.membership_checkout_session(bigint),
  public.membership_prepare_checkout(bigint,text),
  public.membership_checkout_purchase_confirmed(bigint,text),
  public.membership_begin_proof_upload(bigint,uuid),
  public.membership_cancel_purchase(bigint,uuid)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
  public.membership_current_purchase_for_telegram(bigint),
  public.membership_begin_checkout(bigint,text),
  public.membership_checkout_session(bigint),
  public.membership_prepare_checkout(bigint,text),
  public.membership_checkout_purchase_confirmed(bigint,text),
  public.membership_begin_proof_upload(bigint,uuid),
  public.membership_cancel_purchase(bigint,uuid)
TO service_role;
