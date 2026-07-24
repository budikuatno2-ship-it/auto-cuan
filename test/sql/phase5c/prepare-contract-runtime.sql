\set ON_ERROR_STOP on
DO $$
DECLARE b uuid; c jsonb; r jsonb; a uuid; t uuid; items jsonb; before_count bigint; before_generated bigint; before_time timestamptz;
BEGIN
 SELECT id INTO b FROM public.app_users WHERE username='budi';
 INSERT INTO public.voucher_batches(id,batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(gen_random_uuid(),'VB-C1D2E3F4A5B6',b,'PERCENT_100','PREMIUM_1_MONTH',2,'22222222-2222-4222-8222-222222222222');
 c:=public.claim_voucher_admin_batch_chunk('VB-C1D2E3F4A5B6'); a:=(c->>'attempt_id')::uuid; t:=(c->>'claim_token')::uuid;
 items:=jsonb_build_array(jsonb_build_object('code_hash',repeat('c',64),'code_hint','C1D2'),jsonb_build_object('code_hash',repeat('d',64),'code_hint','E3F4'));
 r:=public.prepare_voucher_admin_batch_chunk('VB-C1D2E3F4A5B6',0,a,t,items);
 IF r->>'prepared'<>'true' OR r->>'already_prepared'<>'false' THEN RAISE EXCEPTION 'first prepare failed'; END IF;
 SELECT count(*) INTO before_count FROM public.subscription_vouchers WHERE attempt_id=a; SELECT generated_quantity INTO before_generated FROM public.voucher_batches WHERE batch_reference='VB-C1D2E3F4A5B6'; SELECT prepared_at INTO before_time FROM public.voucher_batch_chunk_attempts WHERE id=a;
 r:=public.prepare_voucher_admin_batch_chunk('VB-C1D2E3F4A5B6',0,a,t,items);
 IF r->>'prepared'<>'true' OR r->>'already_prepared'<>'true' OR r->>'safe_result_code'<>'already_prepared' OR (r->>'stored_count')::integer<>2 THEN RAISE EXCEPTION 'exact replay assertion failed'; END IF;
 IF (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=a)<>before_count OR (SELECT generated_quantity FROM public.voucher_batches WHERE batch_reference='VB-C1D2E3F4A5B6')<>before_generated OR (SELECT prepared_at FROM public.voucher_batch_chunk_attempts WHERE id=a)<>before_time THEN RAISE EXCEPTION 'exact replay mutated state'; END IF;
 BEGIN
   PERFORM public.prepare_voucher_admin_batch_chunk('VB-C1D2E3F4A5B6',0,a,t,jsonb_build_array(jsonb_build_object('code_hash',repeat('e',64),'code_hint','C1D2'),jsonb_build_object('code_hash',repeat('d',64),'code_hint','E3F4')));
   RAISE EXCEPTION 'conflicting hash replay accepted';
 EXCEPTION WHEN others THEN
   IF SQLERRM='conflicting hash replay accepted' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=a)<>before_count THEN RAISE EXCEPTION 'conflicting replay mutated rows'; END IF;
END $$;
