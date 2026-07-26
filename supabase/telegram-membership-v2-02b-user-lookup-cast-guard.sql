-- Telegram Membership V2 / Part 2B
-- Safe numeric lookup guard for admin user search.
-- Apply to staging immediately after Part 2 and before Part 3.

CREATE OR REPLACE FUNCTION public.membership_admin_bot_user_lookup(
  p_query text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path=pg_catalog,public
AS $$
DECLARE
  telegram_id_value bigint;
  result jsonb;
BEGIN
  IF p_query ~ '^[0-9]{1,20}$' THEN
    BEGIN
      telegram_id_value:=p_query::bigint;
    EXCEPTION WHEN numeric_value_out_of_range THEN
      telegram_id_value:=NULL;
    END;
  END IF;

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
      ORDER BY p.created_at DESC
      LIMIT 1
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
  ) INTO result
  FROM public.app_users u
  LEFT JOIN public.app_user_telegram_verifications verification
    ON verification.user_id=u.id
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
     OR (telegram_id_value IS NOT NULL AND verification.telegram_user_id=telegram_id_value)
  LIMIT 1;

  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.membership_admin_bot_user_lookup(text)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION public.membership_admin_bot_user_lookup(text)
TO service_role;
