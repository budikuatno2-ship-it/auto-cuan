-- Telegram Membership V2 / Part 3
-- Enforce channel coverage expiry at invite, claim, finalize, and removal-candidate time.
-- Apply to staging after Parts 1 and 2.

CREATE OR REPLACE FUNCTION public.membership_record_channel_invite(
  p_grant_id uuid,
  p_telegram_user_id bigint,
  p_invite_hash text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.membership_channel_grants
  SET invite_link_hash=p_invite_hash,
      invite_expires_at=least(
        now()+interval '15 minutes',
        coalesce(expires_at,now()+interval '15 minutes')
      )
  WHERE id=p_grant_id
    AND telegram_user_id=p_telegram_user_id
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at>now());
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.membership_claim_channel_join(
  p_telegram_user_id bigint,
  p_invite_hash text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  grant_row public.membership_channel_grants;
  claim_token uuid:=gen_random_uuid();
  access_ok boolean;
BEGIN
  SELECT * INTO grant_row
  FROM public.membership_channel_grants
  WHERE telegram_user_id=p_telegram_user_id
    AND invite_link_hash=p_invite_hash
    AND invite_used_at IS NULL
    AND invite_expires_at>now()
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at>now())
    AND (join_claim_expires_at IS NULL OR join_claim_expires_at<=now())
  FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT (
    EXISTS(
      SELECT 1
      FROM public.membership_admin_telegram_links admin_link
      JOIN public.app_users admin_user ON admin_user.id=admin_link.user_id
      WHERE admin_link.telegram_user_id=p_telegram_user_id
        AND admin_link.user_id=grant_row.user_id
        AND admin_link.revoked_at IS NULL
        AND lower(admin_user.username)='budi'
        AND admin_user.is_approved=true
        AND admin_user.is_blocked=false
    )
    OR EXISTS(
      SELECT 1
      FROM public.app_user_telegram_verifications verification
      JOIN public.app_users app_user ON app_user.id=verification.user_id
      JOIN public.membership_entitlements entitlement
        ON entitlement.id=grant_row.entitlement_id
       AND entitlement.user_id=app_user.id
      WHERE verification.telegram_user_id=p_telegram_user_id
        AND verification.telegram_verified_at IS NOT NULL
        AND app_user.is_approved=true
        AND app_user.is_blocked=false
        AND entitlement.status='active'
        AND (entitlement.lifetime OR entitlement.ends_at>now())
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at>now())
    )
  ) INTO access_ok;

  IF NOT access_ok THEN
    UPDATE public.membership_channel_grants
    SET invite_link_hash=NULL,
        invite_expires_at=NULL,
        join_claim_token=NULL,
        join_claim_expires_at=NULL
    WHERE id=grant_row.id;
    RETURN jsonb_build_object('invalid',true,'grantId',grant_row.id);
  END IF;

  UPDATE public.membership_channel_grants
  SET join_claim_token=claim_token,
      join_claim_expires_at=now()+interval '30 seconds'
  WHERE id=grant_row.id;
  RETURN jsonb_build_object(
    'grantId',grant_row.id,
    'claimToken',claim_token,
    'invalid',false
  );
END $$;

CREATE OR REPLACE FUNCTION public.membership_finalize_channel_join(
  p_grant_id uuid,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  grant_row public.membership_channel_grants;
  access_ok boolean;
BEGIN
  SELECT * INTO grant_row
  FROM public.membership_channel_grants
  WHERE id=p_grant_id
    AND join_claim_token=p_claim_token
    AND join_claim_expires_at>now()
    AND joined_at IS NULL
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at>now())
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT (
    EXISTS(
      SELECT 1
      FROM public.membership_admin_telegram_links admin_link
      JOIN public.app_users admin_user ON admin_user.id=admin_link.user_id
      WHERE admin_link.telegram_user_id=grant_row.telegram_user_id
        AND admin_link.user_id=grant_row.user_id
        AND admin_link.revoked_at IS NULL
        AND lower(admin_user.username)='budi'
        AND admin_user.is_approved=true
        AND admin_user.is_blocked=false
    )
    OR EXISTS(
      SELECT 1
      FROM public.app_user_telegram_verifications verification
      JOIN public.app_users app_user ON app_user.id=verification.user_id
      JOIN public.membership_entitlements entitlement
        ON entitlement.id=grant_row.entitlement_id
       AND entitlement.user_id=app_user.id
      WHERE verification.telegram_user_id=grant_row.telegram_user_id
        AND verification.telegram_verified_at IS NOT NULL
        AND app_user.is_approved=true
        AND app_user.is_blocked=false
        AND entitlement.status='active'
        AND (entitlement.lifetime OR entitlement.ends_at>now())
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at>now())
    )
  ) INTO access_ok;

  IF NOT access_ok THEN
    UPDATE public.membership_channel_grants
    SET invite_link_hash=NULL,
        invite_expires_at=NULL,
        join_claim_token=NULL,
        join_claim_expires_at=NULL
    WHERE id=grant_row.id;
    RETURN false;
  END IF;

  UPDATE public.membership_channel_grants
  SET invite_used_at=now(),
      joined_at=now(),
      invite_link_hash=NULL,
      invite_expires_at=NULL,
      join_claim_token=NULL,
      join_claim_expires_at=NULL
  WHERE id=grant_row.id;

  INSERT INTO public.membership_audit_events(event_type,actor_user_id,metadata)
  VALUES(
    'channel_join_approved',grant_row.user_id,
    jsonb_build_object('grantId',p_grant_id,'coverageEndsAt',grant_row.expires_at)
  );
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.membership_channel_expiry_candidates()
RETURNS SETOF jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'grant_id',grant_row.id,
    'telegram_user_id',grant_row.telegram_user_id
  )
  FROM public.membership_channel_grants grant_row
  LEFT JOIN public.app_users app_user ON app_user.id=grant_row.user_id
  LEFT JOIN public.membership_entitlements entitlement
    ON entitlement.id=grant_row.entitlement_id
  WHERE grant_row.enforcement_completed_at IS NULL
    AND NOT EXISTS(
      SELECT 1
      FROM public.membership_admin_telegram_links admin_link
      JOIN public.app_users admin_user ON admin_user.id=admin_link.user_id
      WHERE admin_link.telegram_user_id=grant_row.telegram_user_id
        AND admin_link.user_id=grant_row.user_id
        AND admin_link.revoked_at IS NULL
        AND lower(admin_user.username)='budi'
        AND admin_user.is_approved=true
        AND admin_user.is_blocked=false
    )
    AND NOT EXISTS(
      SELECT 1 FROM public.membership_channel_exemptions exemption
      WHERE exemption.telegram_user_id=grant_row.telegram_user_id
    )
    AND (
      grant_row.revoked_at IS NOT NULL
      OR app_user.id IS NULL
      OR app_user.is_blocked=true
      OR app_user.is_approved IS NOT TRUE
      OR entitlement.id IS NULL
      OR entitlement.status IN ('revoked','expired')
      OR (entitlement.lifetime=false AND entitlement.ends_at<=now())
      OR (grant_row.expires_at IS NOT NULL AND grant_row.expires_at<=now())
    );
$$;

REVOKE ALL ON FUNCTION
  public.membership_record_channel_invite(uuid,bigint,text),
  public.membership_claim_channel_join(bigint,text),
  public.membership_finalize_channel_join(uuid,uuid),
  public.membership_channel_expiry_candidates()
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
  public.membership_record_channel_invite(uuid,bigint,text),
  public.membership_claim_channel_join(bigint,text),
  public.membership_finalize_channel_join(uuid,uuid),
  public.membership_channel_expiry_candidates()
TO service_role;
