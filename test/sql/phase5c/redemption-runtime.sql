\set ON_ERROR_STOP on

-- Term redemption preserves remaining access, follows catalog months, and is idempotent.
DO $$
DECLARE
  actor uuid; user_id uuid; other_user uuid; existing_expiry timestamptz := now() + interval '10 days';
  key uuid := '81000000-0000-4000-8000-000000000001'::uuid;
  hash_one text := md5('stack-one') || md5('stack-one');
  hash_two text := md5('stack-two') || md5('stack-two');
  result jsonb; redeemed_entitlement_id uuid; rejected boolean := false;
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.app_users(username,is_approved) VALUES('redemption_stack_user',true) RETURNING id INTO user_id;
  INSERT INTO public.app_users(username,is_approved) VALUES('redemption_other_user',true) RETURNING id INTO other_user;

  INSERT INTO public.user_entitlements(user_id,plan_code,source,status,starts_at,expires_at,lifetime,activation_idempotency_key)
  VALUES(user_id,'PREMIUM_1_MONTH','payment','active',now()-interval '5 days',existing_expiry,false,'redemption-existing-term');

  -- Deliberately inconsistent legacy metadata proves the immutable plan catalog is authoritative.
  INSERT INTO public.subscription_vouchers(code_hash,code_hint,plan_code,voucher_type,duration_days,max_redemptions,active,created_by_user_id)
  VALUES(hash_one,'S001','PREMIUM_1_MONTH','PERCENT_100',365,1,true,actor);
  INSERT INTO public.subscription_vouchers(code_hash,code_hint,plan_code,voucher_type,duration_days,max_redemptions,active,created_by_user_id)
  VALUES(hash_two,'S002','PREMIUM_2_MONTHS','PERCENT_100',60,1,true,actor);

  result := public.redeem_subscription_voucher(user_id,hash_one,key);
  redeemed_entitlement_id := (result->>'entitlement_id')::uuid;
  IF result->>'redeemed'<>'true' OR result->>'result_code'<>'redeemed'
     OR result->>'plan_code'<>'PREMIUM_1_MONTH' OR (result->>'duration_months')::integer<>1
     OR (result->>'starts_at')::timestamptz IS DISTINCT FROM existing_expiry
     OR (result->>'expires_at')::timestamptz IS DISTINCT FROM existing_expiry + interval '1 month'
  THEN RAISE EXCEPTION 'stacked term redemption response failed'; END IF;
  IF (SELECT redemption_count FROM public.subscription_vouchers WHERE code_hash=hash_one)<>1
     OR (SELECT count(*) FROM public.subscription_voucher_redemptions r WHERE r.entitlement_id=redeemed_entitlement_id)<>1
  THEN RAISE EXCEPTION 'stacked term redemption state failed'; END IF;

  result := public.redeem_subscription_voucher(user_id,hash_one,key);
  IF result->>'result_code'<>'already_redeemed' OR (result->>'entitlement_id')::uuid<>redeemed_entitlement_id
     OR (SELECT redemption_count FROM public.subscription_vouchers WHERE code_hash=hash_one)<>1
     OR (SELECT count(*) FROM public.subscription_voucher_redemptions WHERE redemption_idempotency_key=key)<>1
  THEN RAISE EXCEPTION 'redemption idempotent replay failed'; END IF;

  BEGIN
    PERFORM public.redeem_subscription_voucher(other_user,hash_one,key);
  EXCEPTION WHEN others THEN
    IF SQLERRM<>'invalid redemption' THEN RAISE; END IF;
    rejected:=true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'cross-user idempotency replay accepted'; END IF;

  rejected:=false;
  BEGIN
    PERFORM public.redeem_subscription_voucher(user_id,hash_two,key);
  EXCEPTION WHEN others THEN
    IF SQLERRM<>'invalid redemption' THEN RAISE; END IF;
    rejected:=true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'cross-voucher idempotency replay accepted'; END IF;
  IF (SELECT redemption_count FROM public.subscription_vouchers WHERE code_hash=hash_two)<>0 THEN
    RAISE EXCEPTION 'rejected idempotency replay consumed voucher';
  END IF;
END $$;

-- Sequential term vouchers stack after the latest active expiry without losing days.
DO $$
DECLARE
  actor uuid; user_id uuid; base_expiry timestamptz := now() + interval '7 days';
  first_result jsonb; second_result jsonb;
  hash_one text := md5('sequence-one') || md5('sequence-one');
  hash_two text := md5('sequence-two') || md5('sequence-two');
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.app_users(username,is_approved) VALUES('redemption_sequence_user',true) RETURNING id INTO user_id;
  INSERT INTO public.user_entitlements(user_id,plan_code,source,status,starts_at,expires_at,lifetime,activation_idempotency_key)
  VALUES(user_id,'PREMIUM_1_MONTH','payment','active',now()-interval '3 days',base_expiry,false,'redemption-sequence-existing');
  INSERT INTO public.subscription_vouchers(code_hash,code_hint,plan_code,voucher_type,duration_days,max_redemptions,active,created_by_user_id)
  VALUES(hash_one,'Q001','PREMIUM_1_MONTH','PERCENT_100',30,1,true,actor),
        (hash_two,'Q002','PREMIUM_2_MONTHS','PERCENT_100',60,1,true,actor);

  first_result:=public.redeem_subscription_voucher(user_id,hash_one,'82000000-0000-4000-8000-000000000001'::uuid);
  second_result:=public.redeem_subscription_voucher(user_id,hash_two,'82000000-0000-4000-8000-000000000002'::uuid);
  IF (first_result->>'starts_at')::timestamptz IS DISTINCT FROM base_expiry
     OR (first_result->>'expires_at')::timestamptz IS DISTINCT FROM base_expiry + interval '1 month'
     OR (second_result->>'starts_at')::timestamptz IS DISTINCT FROM base_expiry + interval '1 month'
     OR (second_result->>'expires_at')::timestamptz IS DISTINCT FROM base_expiry + interval '3 months'
  THEN RAISE EXCEPTION 'sequential term stacking failed'; END IF;
END $$;

-- Lifetime access is terminal and must not consume later vouchers.
DO $$
DECLARE
  actor uuid; user_id uuid; term_hash text := md5('lifetime-term')||md5('lifetime-term');
  lifetime_hash text := md5('lifetime-life')||md5('lifetime-life'); result jsonb; rejected boolean:=false;
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.app_users(username,is_approved) VALUES('redemption_lifetime_user',true) RETURNING id INTO user_id;
  INSERT INTO public.user_entitlements(user_id,plan_code,source,status,starts_at,expires_at,lifetime,activation_idempotency_key)
  VALUES(user_id,'LIFETIME','payment','active',now()-interval '1 day',NULL,true,'redemption-existing-lifetime');
  INSERT INTO public.subscription_vouchers(code_hash,code_hint,plan_code,voucher_type,duration_days,max_redemptions,active,created_by_user_id)
  VALUES(term_hash,'L001','PREMIUM_1_MONTH','PERCENT_100',30,1,true,actor),
        (lifetime_hash,'L002','LIFETIME','LIFETIME',1,1,true,actor);

  BEGIN
    PERFORM public.redeem_subscription_voucher(user_id,term_hash,'83000000-0000-4000-8000-000000000001'::uuid);
  EXCEPTION WHEN others THEN
    IF SQLERRM<>'voucher unavailable' THEN RAISE; END IF;
    rejected:=true;
  END;
  IF NOT rejected OR (SELECT redemption_count FROM public.subscription_vouchers WHERE code_hash=term_hash)<>0
     OR EXISTS(SELECT 1 FROM public.subscription_voucher_redemptions r JOIN public.subscription_vouchers v ON v.id=r.voucher_id WHERE v.code_hash=term_hash)
  THEN RAISE EXCEPTION 'term voucher was not blocked for lifetime user'; END IF;

  result:=public.redeem_subscription_voucher(user_id,lifetime_hash,'83000000-0000-4000-8000-000000000002'::uuid);
  IF result->>'result_code'<>'already_lifetime' OR result->>'lifetime'<>'true'
     OR (SELECT redemption_count FROM public.subscription_vouchers WHERE code_hash=lifetime_hash)<>0
  THEN RAISE EXCEPTION 'existing lifetime replay contract failed'; END IF;
END $$;

-- Expired entitlements do not delay a new term, and direct creation cannot contradict plan duration.
DO $$
DECLARE
  actor uuid; user_id uuid; tx_now timestamptz:=now(); result jsonb; rejected boolean:=false;
  redeem_hash text:=md5('expired-term')||md5('expired-term');
  bad_hash text:=md5('bad-duration')||md5('bad-duration');
  good_hash text:=md5('good-duration')||md5('good-duration');
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.app_users(username,is_approved) VALUES('redemption_expired_user',true) RETURNING id INTO user_id;
  INSERT INTO public.user_entitlements(user_id,plan_code,source,status,starts_at,expires_at,lifetime,activation_idempotency_key)
  VALUES(user_id,'PREMIUM_1_MONTH','payment','active',now()-interval '2 months',now()-interval '1 month',false,'redemption-expired-existing');
  INSERT INTO public.subscription_vouchers(code_hash,code_hint,plan_code,voucher_type,duration_days,max_redemptions,active,created_by_user_id)
  VALUES(redeem_hash,'E001','PREMIUM_3_MONTHS','PERCENT_100',90,1,true,actor);

  result:=public.redeem_subscription_voucher(user_id,redeem_hash,'84000000-0000-4000-8000-000000000001'::uuid);
  IF (result->>'starts_at')::timestamptz IS DISTINCT FROM tx_now
     OR (result->>'expires_at')::timestamptz IS DISTINCT FROM tx_now + interval '3 months'
  THEN RAISE EXCEPTION 'expired entitlement delayed redemption'; END IF;

  BEGIN
    PERFORM public.create_subscription_voucher(bad_hash,'E002','PREMIUM_1_MONTH',31,1,actor);
  EXCEPTION WHEN others THEN
    IF SQLERRM<>'invalid voucher' THEN RAISE; END IF;
    rejected:=true;
  END;
  IF NOT rejected OR EXISTS(SELECT 1 FROM public.subscription_vouchers WHERE code_hash=bad_hash) THEN
    RAISE EXCEPTION 'mismatched direct voucher duration accepted';
  END IF;

  result:=public.create_subscription_voucher(good_hash,'E003','PREMIUM_1_MONTH',30,1,actor);
  IF result->>'code_hint'<>'E003' OR NOT EXISTS(SELECT 1 FROM public.subscription_vouchers WHERE code_hash=good_hash AND duration_days=30) THEN
    RAISE EXCEPTION 'valid direct voucher duration rejected';
  END IF;
END $$;
