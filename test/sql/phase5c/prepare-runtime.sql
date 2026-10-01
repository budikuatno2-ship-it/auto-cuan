\set ON_ERROR_STOP on
DO $$
DECLARE b uuid; claim jsonb; prepared jsonb; attempt uuid; token uuid; items jsonb;
BEGIN
  SELECT id INTO b FROM public.app_users WHERE username='budi';
  INSERT INTO public.voucher_batches(id,batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key)
  VALUES(gen_random_uuid(),'VB-A1B2C3D4E5F6',b,'PERCENT_100','PREMIUM_1_MONTH',2,'11111111-1111-4111-8111-111111111111');
  claim:=public.claim_voucher_admin_batch_chunk('VB-A1B2C3D4E5F6');
  IF claim->>'done' <> 'false' OR (claim->>'chunk_index')::bigint<>0 OR claim->>'attempt_id' IS NULL OR claim->>'claim_token' IS NULL OR (claim->>'expected_count')::integer<>2 OR claim->>'mode'<>'prepare' THEN RAISE EXCEPTION 'claim assertion failed'; END IF;
  attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
  items:=jsonb_build_array(jsonb_build_object('code_hash',repeat('a',64),'code_hint','A1B2'),jsonb_build_object('code_hash',repeat('b',64),'code_hint','C3D4'));
  prepared:=public.prepare_voucher_admin_batch_chunk('VB-A1B2C3D4E5F6',0,attempt,token,items);
  IF prepared->>'prepared'<>'true' OR prepared->>'already_prepared'<>'false' OR (prepared->>'attempt_id')::uuid<>attempt OR (prepared->>'chunk_index')::integer<>0 OR (prepared->>'expected_count')::integer<>2 OR (prepared->>'stored_count')::integer<>2 THEN RAISE EXCEPTION 'prepare assertion failed'; END IF;
  IF (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=attempt)<>2 OR (SELECT array_agg(item_index ORDER BY item_index) FROM public.subscription_vouchers WHERE attempt_id=attempt)<>ARRAY[0,1] THEN RAISE EXCEPTION 'voucher assertion failed'; END IF;
  IF EXISTS(SELECT 1 FROM public.subscription_vouchers WHERE attempt_id=attempt AND (active OR NOT delivery_pending OR batch_id<>(SELECT id FROM public.voucher_batches WHERE batch_reference='VB-A1B2C3D4E5F6') OR chunk_index<>0 OR voucher_type<>'PERCENT_100' OR plan_code<>'PREMIUM_1_MONTH' OR duration_days<>30)) THEN RAISE EXCEPTION 'voucher lifecycle assertion failed'; END IF;
END $$;
