\set ON_ERROR_STOP on
DO $$
DECLARE b uuid; c jsonb; r jsonb; a uuid; t uuid; items jsonb; rows_before bigint; refs_before text[]; hashes_before text[]; hints_before text[]; batch_generated bigint; batch_status text; chunk_generated integer; chunk_status text; current_attempt uuid; attempt_stored integer; attempt_status text; attempt_time timestamptz; indexes_before integer[]; active_before boolean[]; pending_before boolean[]; progress_before bigint; result_before text; changed_hash_rejected boolean := false; changed_hint_rejected boolean := false; extra_key_rejected boolean := false;
BEGIN
 SELECT id INTO b FROM public.app_users WHERE username='budi';
 INSERT INTO public.voucher_batches(id,batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(gen_random_uuid(),'VB-C1D2E3F4A5B6',b,'PERCENT_100','PREMIUM_1_MONTH',2,'22222222-2222-4222-8222-222222222222');
 c:=public.claim_voucher_admin_batch_chunk('VB-C1D2E3F4A5B6'); a:=(c->>'attempt_id')::uuid; t:=(c->>'claim_token')::uuid;
 items:=jsonb_build_array(jsonb_build_object('code_hash',repeat('c',64),'code_hint','C1D2'),jsonb_build_object('code_hash',repeat('d',64),'code_hint','E3F4'));
 r:=public.prepare_voucher_admin_batch_chunk('VB-C1D2E3F4A5B6',0,a,t,items);
 SELECT count(*),array_agg(voucher_reference ORDER BY item_index),array_agg(code_hash ORDER BY item_index),array_agg(code_hint ORDER BY item_index),array_agg(item_index ORDER BY item_index),array_agg(active ORDER BY item_index),array_agg(delivery_pending ORDER BY item_index) INTO rows_before,refs_before,hashes_before,hints_before,indexes_before,active_before,pending_before FROM public.subscription_vouchers WHERE attempt_id=a;
 SELECT generated_quantity,status,progress_cursor INTO batch_generated,batch_status,progress_before FROM public.voucher_batches WHERE batch_reference='VB-C1D2E3F4A5B6'; SELECT generated_count,status,current_attempt_id INTO chunk_generated,chunk_status,current_attempt FROM public.voucher_batch_chunks WHERE batch_id=(SELECT id FROM public.voucher_batches WHERE batch_reference='VB-C1D2E3F4A5B6'); SELECT stored_count,status,prepared_at,last_safe_result_code INTO attempt_stored,attempt_status,attempt_time,result_before FROM public.voucher_batch_chunk_attempts WHERE id=a;
 r:=public.prepare_voucher_admin_batch_chunk('VB-C1D2E3F4A5B6',0,a,t,items);
 IF r->>'prepared'<>'true' OR r->>'already_prepared'<>'true' OR r->>'safe_result_code'<>'already_prepared' OR (r->>'stored_count')::integer<>2 OR (r->>'expected_count')::integer<>2 OR (r->>'chunk_index')::integer<>0 OR (r->>'attempt_id')::uuid<>a THEN RAISE EXCEPTION 'exact replay assertion failed'; END IF;
 IF (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=a)<>rows_before OR (SELECT array_agg(voucher_reference ORDER BY item_index) FROM public.subscription_vouchers WHERE attempt_id=a) IS DISTINCT FROM refs_before OR (SELECT array_agg(code_hash ORDER BY item_index) FROM public.subscription_vouchers WHERE attempt_id=a) IS DISTINCT FROM hashes_before OR (SELECT array_agg(code_hint ORDER BY item_index) FROM public.subscription_vouchers WHERE attempt_id=a) IS DISTINCT FROM hints_before OR (SELECT generated_quantity FROM public.voucher_batches WHERE batch_reference='VB-C1D2E3F4A5B6')<>batch_generated OR (SELECT generated_count FROM public.voucher_batch_chunks WHERE current_attempt_id=a)<>chunk_generated OR (SELECT stored_count FROM public.voucher_batch_chunk_attempts WHERE id=a)<>attempt_stored OR (SELECT prepared_at FROM public.voucher_batch_chunk_attempts WHERE id=a)<>attempt_time THEN RAISE EXCEPTION 'exact replay mutated state'; END IF;
 BEGIN PERFORM public.prepare_voucher_admin_batch_chunk('VB-C1D2E3F4A5B6',0,a,t,jsonb_build_array(jsonb_build_object('code_hash',repeat('e',64),'code_hint','C1D2'),jsonb_build_object('code_hash',repeat('d',64),'code_hint','E3F4'))); RAISE EXCEPTION 'changed-hash replay accepted'; EXCEPTION WHEN others THEN IF SQLERRM<>'conflicting replay' THEN RAISE; END IF; changed_hash_rejected:=true; END; IF NOT changed_hash_rejected THEN RAISE EXCEPTION 'changed-hash rejection missing'; END IF;
 BEGIN PERFORM public.prepare_voucher_admin_batch_chunk('VB-C1D2E3F4A5B6',0,a,t,jsonb_build_array(jsonb_build_object('code_hash',repeat('c',64),'code_hint','Z9Y8'),jsonb_build_object('code_hash',repeat('d',64),'code_hint','E3F4'))); RAISE EXCEPTION 'changed-hint replay accepted'; EXCEPTION WHEN others THEN IF SQLERRM<>'conflicting replay' THEN RAISE; END IF; changed_hint_rejected:=true; END; IF NOT changed_hint_rejected THEN RAISE EXCEPTION 'changed-hint rejection missing'; END IF;
 BEGIN PERFORM public.prepare_voucher_admin_batch_chunk('VB-C1D2E3F4A5B6',0,a,t,jsonb_build_array(jsonb_build_object('code_hash',repeat('c',64),'code_hint','C1D2','plaintext','forbidden'),jsonb_build_object('code_hash',repeat('d',64),'code_hint','E3F4'))); RAISE EXCEPTION 'extra-key replay accepted'; EXCEPTION WHEN others THEN IF SQLERRM<>'voucher unavailable' THEN RAISE; END IF; extra_key_rejected:=true; END; IF NOT extra_key_rejected THEN RAISE EXCEPTION 'extra-key rejection missing'; END IF;
 IF (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=a)<>rows_before OR (SELECT array_agg(voucher_reference ORDER BY item_index) FROM public.subscription_vouchers WHERE attempt_id=a) IS DISTINCT FROM refs_before OR (SELECT array_agg(code_hash ORDER BY item_index) FROM public.subscription_vouchers WHERE attempt_id=a) IS DISTINCT FROM hashes_before OR (SELECT array_agg(code_hint ORDER BY item_index) FROM public.subscription_vouchers WHERE attempt_id=a) IS DISTINCT FROM hints_before OR (SELECT array_agg(item_index ORDER BY item_index) FROM public.subscription_vouchers WHERE attempt_id=a) IS DISTINCT FROM indexes_before OR (SELECT array_agg(active ORDER BY item_index) FROM public.subscription_vouchers WHERE attempt_id=a) IS DISTINCT FROM active_before OR (SELECT array_agg(delivery_pending ORDER BY item_index) FROM public.subscription_vouchers WHERE attempt_id=a) IS DISTINCT FROM pending_before OR (SELECT generated_quantity FROM public.voucher_batches WHERE batch_reference='VB-C1D2E3F4A5B6')<>batch_generated OR (SELECT progress_cursor FROM public.voucher_batches WHERE batch_reference='VB-C1D2E3F4A5B6')<>progress_before OR (SELECT generated_count FROM public.voucher_batch_chunks WHERE current_attempt_id=a)<>chunk_generated OR (SELECT stored_count FROM public.voucher_batch_chunk_attempts WHERE id=a)<>attempt_stored OR (SELECT prepared_at FROM public.voucher_batch_chunk_attempts WHERE id=a)<>attempt_time OR (SELECT last_safe_result_code FROM public.voucher_batch_chunk_attempts WHERE id=a) IS DISTINCT FROM result_before THEN RAISE EXCEPTION 'rejected replay mutated state'; END IF;
END $$;

-- Invalid first-prepare inputs must reject without durable mutation.
DO $$
DECLARE
 actor uuid; ref text; claim jsonb; attempt uuid; token uuid; payload jsonb; i integer := 0; rejected boolean;
 valid_item jsonb := jsonb_build_object('code_hash',repeat('1',64),'code_hint','A1B2');
 payloads jsonb[];
BEGIN
 SELECT id INTO actor FROM public.app_users WHERE username='budi';
 payloads := ARRAY[
   '"scalar"'::jsonb,
   'null'::jsonb,
   jsonb_build_array(jsonb_build_object('code_hint','A1B2'),valid_item),
   jsonb_build_array(jsonb_build_object('code_hash',repeat('1',64)),valid_item),
   jsonb_build_array(jsonb_build_object('code_hash',repeat('1',64),'code_hint','A1B2','extra',true),valid_item),
   jsonb_build_array(jsonb_build_object('code_hash',123,'code_hint','A1B2'),valid_item),
   jsonb_build_array(jsonb_build_object('code_hash',repeat('1',64),'code_hint',1234),valid_item),
   jsonb_build_array(jsonb_build_object('code_hash',repeat('A',64),'code_hint','A1B2'),valid_item),
   jsonb_build_array(jsonb_build_object('code_hash',repeat('1',63),'code_hint','A1B2'),valid_item),
   jsonb_build_array(jsonb_build_object('code_hash',repeat('1',64),'code_hint','ab12'),valid_item),
   jsonb_build_array(valid_item)
 ];
 FOREACH payload IN ARRAY payloads LOOP
   i := i + 1; ref := 'VB-FA'||lpad(i::text,10,'0');
   INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
   claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid; rejected:=false;
   BEGIN
     PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,payload);
   EXCEPTION WHEN others THEN
     IF SQLERRM<>'voucher unavailable' THEN RAISE; END IF;
     rejected:=true;
   END;
   IF NOT rejected THEN RAISE EXCEPTION 'invalid prepare case % accepted',i; END IF;
   IF EXISTS(SELECT 1 FROM public.subscription_vouchers WHERE attempt_id=attempt)
      OR (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>'claimed'
      OR (SELECT stored_count FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>0
      OR (SELECT generated_count FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt)<>0
      OR (SELECT generated_quantity FROM public.voucher_batches WHERE batch_reference=ref)<>0
   THEN RAISE EXCEPTION 'invalid prepare case % mutated state',i; END IF;
 END LOOP;
END $$;

-- Wrong authority and expired leases must reject without mutation.
DO $$
DECLARE actor uuid; ref text; claim jsonb; attempt uuid; token uuid; items jsonb; rejected boolean; i integer;
BEGIN
 SELECT id INTO actor FROM public.app_users WHERE username='budi';
 items:=jsonb_build_array(jsonb_build_object('code_hash',repeat('2',64),'code_hint','C1D2'),jsonb_build_object('code_hash',repeat('3',64),'code_hint','E3F4'));
 FOR i IN 1..4 LOOP
   ref:='VB-FB'||lpad(i::text,10,'0');
   INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
   claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid; rejected:=false;
   IF i=4 THEN UPDATE public.voucher_batch_chunk_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=attempt; END IF;
   BEGIN
     CASE i
       WHEN 1 THEN PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,'00000000-0000-4000-8000-000000000001'::uuid,items);
       WHEN 2 THEN PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,'00000000-0000-4000-8000-000000000002'::uuid,token,items);
       WHEN 3 THEN PERFORM public.prepare_voucher_admin_batch_chunk(ref,1,attempt,token,items);
       WHEN 4 THEN PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
     END CASE;
   EXCEPTION WHEN others THEN
     IF SQLERRM<>'voucher unavailable' THEN RAISE; END IF;
     rejected:=true;
   END;
   IF NOT rejected THEN RAISE EXCEPTION 'authority/lease case % accepted',i; END IF;
   IF EXISTS(SELECT 1 FROM public.subscription_vouchers WHERE attempt_id=attempt)
      OR (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>'claimed'
      OR (SELECT stored_count FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>0
      OR (SELECT generated_count FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt)<>0
      OR (SELECT generated_quantity FROM public.voucher_batches WHERE batch_reference=ref)<>0
   THEN RAISE EXCEPTION 'authority/lease case % mutated state',i; END IF;
 END LOOP;
END $$;

-- Duplicate hashes must fail atomically.
DO $$
DECLARE actor uuid; ref text:='VB-FC0000000001'; claim jsonb; attempt uuid; token uuid; rejected boolean:=false; items jsonb;
BEGIN
 SELECT id INTO actor FROM public.app_users WHERE username='budi';
 INSERT INTO public.subscription_vouchers(code_hash,code_hint,plan_code,duration_days,max_redemptions,active,created_by_user_id) VALUES(repeat('9',64),'DUP0','PREMIUM_1_MONTH',30,1,false,actor);
 INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
 claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
 items:=jsonb_build_array(jsonb_build_object('code_hash',repeat('9',64),'code_hint','DUP0'),jsonb_build_object('code_hash',repeat('8',64),'code_hint','DUP1'));
 BEGIN
   PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
 EXCEPTION WHEN others THEN
   IF SQLERRM<>'voucher unavailable' THEN RAISE; END IF;
   rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'duplicate hash prepare accepted'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_vouchers WHERE attempt_id=attempt)
    OR (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>'claimed'
    OR (SELECT stored_count FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>0
    OR (SELECT status FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt)<>'claimed'
    OR (SELECT generated_count FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt)<>0
    OR (SELECT generated_quantity FROM public.voucher_batches WHERE batch_reference=ref)<>0
 THEN RAISE EXCEPTION 'duplicate hash prepare was not atomic'; END IF;
END $$;

-- A saturated batch counter must reject and roll back every prepare mutation.
DO $$
DECLARE actor uuid; ref text:='VB-FD0000000001'; claim jsonb; attempt uuid; token uuid; rejected boolean:=false; items jsonb;
BEGIN
 SELECT id INTO actor FROM public.app_users WHERE username='budi';
 INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
 claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
 UPDATE public.voucher_batches SET generated_quantity=2 WHERE batch_reference=ref;
 items:=jsonb_build_array(jsonb_build_object('code_hash',repeat('7',64),'code_hint','OVR0'),jsonb_build_object('code_hash',repeat('6',64),'code_hint','OVR1'));
 BEGIN
   PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
 EXCEPTION WHEN others THEN
   IF SQLERRM<>'voucher unavailable' THEN RAISE; END IF;
   rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'batch overflow prepare accepted'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_vouchers WHERE attempt_id=attempt)
    OR (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>'claimed'
    OR (SELECT stored_count FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>0
    OR (SELECT status FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt)<>'claimed'
    OR (SELECT generated_count FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt)<>0
    OR (SELECT generated_quantity FROM public.voucher_batches WHERE batch_reference=ref)<>2
 THEN RAISE EXCEPTION 'batch overflow prepare was not atomic'; END IF;
END $$;

-- Prepared replay must reject missing, extra, or counter-corrupt durable state.
DO $$
DECLARE actor uuid; ref text; claim jsonb; attempt uuid; token uuid; items jsonb; response jsonb; rejected boolean;
BEGIN
 SELECT id INTO actor FROM public.app_users WHERE username='budi';

 ref:='VB-FE0000000001';
 INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
 claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
 items:=jsonb_build_array(jsonb_build_object('code_hash',repeat('5',64),'code_hint','DEL0'),jsonb_build_object('code_hash',repeat('4',64),'code_hint','DEL1'));
 response:=public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
 DELETE FROM public.subscription_vouchers WHERE attempt_id=attempt AND item_index=1;
 rejected:=false;
 BEGIN PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items); EXCEPTION WHEN others THEN IF SQLERRM<>'conflicting replay' THEN RAISE; END IF; rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'missing durable row replay accepted'; END IF;

 ref:='VB-FE0000000002';
 INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
 claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
 items:=jsonb_build_array(jsonb_build_object('code_hash',repeat('3',64),'code_hint','EXT0'),jsonb_build_object('code_hash',repeat('2',64),'code_hint','EXT1'));
 response:=public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
 INSERT INTO public.subscription_vouchers(voucher_reference,code_hash,code_hint,plan_code,voucher_type,duration_days,max_redemptions,active,batch_id,chunk_index,attempt_id,item_index,delivery_pending,created_by_user_id)
 SELECT 'VV-EE0000000001',repeat('1',64),'XTRA',plan_code,voucher_type,30,1,false,id,0,attempt,2,true,actor FROM public.voucher_batches WHERE batch_reference=ref;
 rejected:=false;
 BEGIN PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items); EXCEPTION WHEN others THEN IF SQLERRM<>'conflicting replay' THEN RAISE; END IF; rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'extra durable row replay accepted'; END IF;

 ref:='VB-FE0000000003';
 INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
 claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
 items:=jsonb_build_array(jsonb_build_object('code_hash',repeat('0',64),'code_hint','CNT0'),jsonb_build_object('code_hash',repeat('f',64),'code_hint','CNT1'));
 response:=public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
 UPDATE public.voucher_batch_chunk_attempts SET stored_count=1 WHERE id=attempt;
 rejected:=false;
 BEGIN PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items); EXCEPTION WHEN others THEN IF SQLERRM<>'conflicting replay' THEN RAISE; END IF; rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'stored-count corruption replay accepted'; END IF;
END $$;
