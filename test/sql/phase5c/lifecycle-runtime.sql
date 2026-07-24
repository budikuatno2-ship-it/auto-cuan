\set ON_ERROR_STOP on

-- Receipt and finalization happy path, including exact idempotent replays.
DO $$
DECLARE
  actor uuid; ref text := 'VB-LC0000000001'; claim jsonb; attempt uuid; token uuid; items jsonb; result jsonb;
  delivered_at_before timestamptz; finalized_at_before timestamptz; rejected boolean := false;
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username = 'budi';
  INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key)
  VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',3,gen_random_uuid());
  claim := public.claim_voucher_admin_batch_chunk(ref);
  attempt := (claim->>'attempt_id')::uuid; token := (claim->>'claim_token')::uuid;
  items := jsonb_build_array(
    jsonb_build_object('code_hash',md5('lc1-a')||md5('lc1-a'),'code_hint','A001'),
    jsonb_build_object('code_hash',md5('lc1-b')||md5('lc1-b'),'code_hint','A002'),
    jsonb_build_object('code_hash',md5('lc1-c')||md5('lc1-c'),'code_hint','A003'));
  PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);

  result := public.record_voucher_admin_chunk_delivery(ref,0,attempt,token,'message',101,3);
  IF result->>'recorded' <> 'true' OR result->>'already_recorded' <> 'false' OR (result->>'delivered_count')::integer <> 3 OR result->>'safe_result_code' <> 'delivered' THEN
    RAISE EXCEPTION 'delivery receipt assertion failed';
  END IF;
  IF (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt) <> 'delivered'
     OR (SELECT delivered_count FROM public.voucher_batch_chunk_attempts WHERE id=attempt) <> 3
     OR (SELECT delivery_method FROM public.voucher_batch_chunk_attempts WHERE id=attempt) <> 'message'
     OR (SELECT telegram_message_id FROM public.voucher_batch_chunk_attempts WHERE id=attempt) <> 101
     OR (SELECT status FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt) <> 'delivered'
     OR (SELECT delivered_count FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt) <> 3
     OR (SELECT delivered_quantity FROM public.voucher_batches WHERE batch_reference=ref) <> 3
     OR (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=attempt AND active=false AND delivery_pending=true) <> 3
  THEN RAISE EXCEPTION 'delivery receipt state failed'; END IF;

  SELECT delivered_at INTO delivered_at_before FROM public.voucher_batch_chunk_attempts WHERE id=attempt;
  result := public.record_voucher_admin_chunk_delivery(ref,0,attempt,token,'message',101,3);
  IF result->>'already_recorded' <> 'true' OR result->>'safe_result_code' <> 'already_delivered' THEN RAISE EXCEPTION 'delivery receipt replay failed'; END IF;
  IF (SELECT delivered_at FROM public.voucher_batch_chunk_attempts WHERE id=attempt) IS DISTINCT FROM delivered_at_before
     OR (SELECT delivered_quantity FROM public.voucher_batches WHERE batch_reference=ref) <> 3
  THEN RAISE EXCEPTION 'delivery receipt replay mutated state'; END IF;

  BEGIN
    PERFORM public.record_voucher_admin_chunk_delivery(ref,0,attempt,token,'message',102,3);
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'voucher unavailable' THEN RAISE; END IF;
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'conflicting delivery receipt accepted'; END IF;
  IF (SELECT telegram_message_id FROM public.voucher_batch_chunk_attempts WHERE id=attempt) <> 101
     OR (SELECT delivered_quantity FROM public.voucher_batches WHERE batch_reference=ref) <> 3
  THEN RAISE EXCEPTION 'conflicting delivery receipt mutated state'; END IF;

  result := public.finalize_voucher_admin_batch_chunk(ref,0,attempt,token);
  IF result->>'finalized' <> 'true' OR result->>'already_finalized' <> 'false' OR result->>'complete' <> 'true' OR (result->>'progress_cursor')::bigint <> 3 OR result->>'safe_result_code' <> 'finalized' THEN
    RAISE EXCEPTION 'finalize response failed';
  END IF;
  IF (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt) <> 'finalized'
     OR (SELECT status FROM public.voucher_batch_chunks WHERE batch_id=(SELECT id FROM public.voucher_batches WHERE batch_reference=ref) AND chunk_index=0) <> 'finalized'
     OR (SELECT current_attempt_id FROM public.voucher_batch_chunks WHERE batch_id=(SELECT id FROM public.voucher_batches WHERE batch_reference=ref) AND chunk_index=0) IS NOT NULL
     OR (SELECT finalized_count FROM public.voucher_batch_chunks WHERE batch_id=(SELECT id FROM public.voucher_batches WHERE batch_reference=ref) AND chunk_index=0) <> 3
     OR (SELECT generated_quantity FROM public.voucher_batches WHERE batch_reference=ref) <> 3
     OR (SELECT delivered_quantity FROM public.voucher_batches WHERE batch_reference=ref) <> 3
     OR (SELECT finalized_quantity FROM public.voucher_batches WHERE batch_reference=ref) <> 3
     OR (SELECT progress_cursor FROM public.voucher_batches WHERE batch_reference=ref) <> 3
     OR (SELECT status FROM public.voucher_batches WHERE batch_reference=ref) <> 'complete'
     OR (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=attempt AND active=true AND delivery_pending=false) <> 3
  THEN RAISE EXCEPTION 'finalize state failed'; END IF;

  SELECT finalized_at INTO finalized_at_before FROM public.voucher_batch_chunk_attempts WHERE id=attempt;
  result := public.finalize_voucher_admin_batch_chunk(ref,0,attempt,token);
  IF result->>'already_finalized' <> 'true' OR result->>'complete' <> 'true' OR result->>'safe_result_code' <> 'already_finalized' THEN RAISE EXCEPTION 'finalize replay failed'; END IF;
  IF (SELECT finalized_at FROM public.voucher_batch_chunk_attempts WHERE id=attempt) IS DISTINCT FROM finalized_at_before
     OR (SELECT finalized_quantity FROM public.voucher_batches WHERE batch_reference=ref) <> 3
  THEN RAISE EXCEPTION 'finalize replay mutated state'; END IF;

  result := public.claim_voucher_admin_batch_chunk(ref);
  IF result->>'done' <> 'true' OR result->>'complete' <> 'true' OR (result->>'progress_cursor')::bigint <> 3 THEN RAISE EXCEPTION 'complete batch claim failed'; END IF;
END $$;

-- Uncertain delivery without a receipt remains inactive and cannot finalize.
DO $$
DECLARE actor uuid; ref text := 'VB-LC0000000002'; claim jsonb; attempt uuid; token uuid; items jsonb; result jsonb; uncertain_at_before timestamptz; rejected boolean := false;
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
  claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
  items:=jsonb_build_array(jsonb_build_object('code_hash',md5('lc2-a')||md5('lc2-a'),'code_hint','B001'),jsonb_build_object('code_hash',md5('lc2-b')||md5('lc2-b'),'code_hint','B002'));
  PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
  result:=public.mark_voucher_admin_chunk_delivery_uncertain(ref,0,attempt,token);
  IF result->>'uncertain'<>'true' OR result->>'already_uncertain'<>'false' OR result->>'safe_result_code'<>'delivery_uncertain' THEN RAISE EXCEPTION 'uncertain response failed'; END IF;
  IF (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>'delivery_uncertain'
     OR (SELECT delivered_count FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>0
     OR (SELECT status FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt)<>'delivery_uncertain'
     OR (SELECT delivered_quantity FROM public.voucher_batches WHERE batch_reference=ref)<>0
     OR (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=attempt AND active=false AND delivery_pending=true)<>2
  THEN RAISE EXCEPTION 'uncertain state failed'; END IF;
  SELECT uncertain_at INTO uncertain_at_before FROM public.voucher_batch_chunk_attempts WHERE id=attempt;
  result:=public.mark_voucher_admin_chunk_delivery_uncertain(ref,0,attempt,token);
  IF result->>'already_uncertain'<>'true' OR result->>'safe_result_code'<>'already_uncertain' THEN RAISE EXCEPTION 'uncertain replay failed'; END IF;
  IF (SELECT uncertain_at FROM public.voucher_batch_chunk_attempts WHERE id=attempt) IS DISTINCT FROM uncertain_at_before THEN RAISE EXCEPTION 'uncertain replay mutated state'; END IF;
  BEGIN PERFORM public.finalize_voucher_admin_batch_chunk(ref,0,attempt,token); EXCEPTION WHEN others THEN IF SQLERRM<>'voucher unavailable' THEN RAISE; END IF; rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'unreceipted uncertain finalize accepted'; END IF;
  IF (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>'delivery_uncertain' OR (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=attempt AND active=true)<>0 THEN RAISE EXCEPTION 'unreceipted uncertain finalize mutated state'; END IF;
END $$;

-- A recorded delivery may be marked uncertain after a later failure and safely finalized.
DO $$
DECLARE actor uuid; ref text := 'VB-LC0000000003'; claim jsonb; attempt uuid; token uuid; items jsonb; result jsonb;
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
  claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
  items:=jsonb_build_array(jsonb_build_object('code_hash',md5('lc3-a')||md5('lc3-a'),'code_hint','C001'),jsonb_build_object('code_hash',md5('lc3-b')||md5('lc3-b'),'code_hint','C002'));
  PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
  PERFORM public.record_voucher_admin_chunk_delivery(ref,0,attempt,token,'document',303,2);
  PERFORM public.mark_voucher_admin_chunk_delivery_uncertain(ref,0,attempt,token);
  result:=public.finalize_voucher_admin_batch_chunk(ref,0,attempt,token);
  IF result->>'finalized'<>'true' OR result->>'complete'<>'true' OR (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=attempt AND active=true AND delivery_pending=false)<>2 THEN RAISE EXCEPTION 'receipted uncertain finalize failed'; END IF;
END $$;

-- Cancellation rolls prepared state back and permits attempt number 2.
DO $$
DECLARE actor uuid; ref text := 'VB-LC0000000004'; claim jsonb; attempt uuid; token uuid; retry_attempt uuid; retry_token uuid; items jsonb; result jsonb;
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
  claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
  items:=jsonb_build_array(jsonb_build_object('code_hash',md5('lc4-a')||md5('lc4-a'),'code_hint','D001'),jsonb_build_object('code_hash',md5('lc4-b')||md5('lc4-b'),'code_hint','D002'));
  PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
  result:=public.cancel_voucher_admin_batch_chunk(ref,0,attempt,token,'test-only');
  IF result->>'cancelled'<>'true' OR result->>'already_cancelled'<>'false' OR (result->>'removed_count')::integer<>2 OR result->>'safe_result_code'<>'cancelled' THEN RAISE EXCEPTION 'cancel response failed'; END IF;
  IF EXISTS(SELECT 1 FROM public.subscription_vouchers WHERE attempt_id=attempt)
     OR (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>'cancelled'
     OR (SELECT generated_quantity FROM public.voucher_batches WHERE batch_reference=ref)<>0
     OR (SELECT current_attempt_id FROM public.voucher_batch_chunks WHERE batch_id=(SELECT id FROM public.voucher_batches WHERE batch_reference=ref) AND chunk_index=0) IS NOT NULL
     OR (SELECT status FROM public.voucher_batch_chunks WHERE batch_id=(SELECT id FROM public.voucher_batches WHERE batch_reference=ref) AND chunk_index=0)<>'pending'
  THEN RAISE EXCEPTION 'cancel state failed'; END IF;
  result:=public.cancel_voucher_admin_batch_chunk(ref,0,attempt,token,'test-only');
  IF result->>'already_cancelled'<>'true' OR result->>'safe_result_code'<>'already_cancelled' THEN RAISE EXCEPTION 'cancel replay failed'; END IF;
  claim:=public.claim_voucher_admin_batch_chunk(ref); retry_attempt:=(claim->>'attempt_id')::uuid; retry_token:=(claim->>'claim_token')::uuid;
  IF retry_attempt=attempt OR (claim->>'attempt_number')::integer<>2 OR (SELECT attempt_number FROM public.voucher_batch_chunk_attempts WHERE id=retry_attempt)<>2 THEN RAISE EXCEPTION 'cancel retry claim failed'; END IF;
  items:=jsonb_build_array(jsonb_build_object('code_hash',md5('lc4-c')||md5('lc4-c'),'code_hint','D003'),jsonb_build_object('code_hash',md5('lc4-d')||md5('lc4-d'),'code_hint','D004'));
  result:=public.prepare_voucher_admin_batch_chunk(ref,0,retry_attempt,retry_token,items);
  IF result->>'prepared'<>'true' OR (SELECT generated_quantity FROM public.voucher_batches WHERE batch_reference=ref)<>2 THEN RAISE EXCEPTION 'cancel retry prepare failed'; END IF;
END $$;

-- Invalid receipt authority and fields reject without mutation.
DO $$
DECLARE actor uuid; ref text := 'VB-LC0000000005'; claim jsonb; attempt uuid; token uuid; items jsonb; rejected boolean; i integer;
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
  claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
  items:=jsonb_build_array(jsonb_build_object('code_hash',md5('lc5-a')||md5('lc5-a'),'code_hint','E001'),jsonb_build_object('code_hash',md5('lc5-b')||md5('lc5-b'),'code_hint','E002'));
  PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
  FOR i IN 1..6 LOOP
    rejected:=false;
    BEGIN
      CASE i
        WHEN 1 THEN PERFORM public.record_voucher_admin_chunk_delivery(ref,0,attempt,token,'email',501,2);
        WHEN 2 THEN PERFORM public.record_voucher_admin_chunk_delivery(ref,0,attempt,token,'message',0,2);
        WHEN 3 THEN PERFORM public.record_voucher_admin_chunk_delivery(ref,0,attempt,token,'message',501,1);
        WHEN 4 THEN PERFORM public.record_voucher_admin_chunk_delivery(ref,0,attempt,'00000000-0000-4000-8000-000000000001'::uuid,'message',501,2);
        WHEN 5 THEN PERFORM public.record_voucher_admin_chunk_delivery(ref,1,attempt,token,'message',501,2);
        WHEN 6 THEN PERFORM public.record_voucher_admin_chunk_delivery(ref,0,'00000000-0000-4000-8000-000000000002'::uuid,token,'message',501,2);
      END CASE;
    EXCEPTION WHEN others THEN IF SQLERRM<>'voucher unavailable' THEN RAISE; END IF; rejected:=true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'invalid delivery case % accepted',i; END IF;
    IF (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>'prepared'
       OR (SELECT delivered_quantity FROM public.voucher_batches WHERE batch_reference=ref)<>0
       OR (SELECT delivered_count FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt)<>0
    THEN RAISE EXCEPTION 'invalid delivery case % mutated state',i; END IF;
  END LOOP;
END $$;

-- Delivery counter failure and finalize counter failure are atomic.
DO $$
DECLARE actor uuid; ref text := 'VB-LC0000000006'; claim jsonb; attempt uuid; token uuid; items jsonb; rejected boolean := false;
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
  claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
  items:=jsonb_build_array(jsonb_build_object('code_hash',md5('lc6-a')||md5('lc6-a'),'code_hint','F001'),jsonb_build_object('code_hash',md5('lc6-b')||md5('lc6-b'),'code_hint','F002'));
  PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
  UPDATE public.voucher_batches SET delivered_quantity=2 WHERE batch_reference=ref;
  BEGIN PERFORM public.record_voucher_admin_chunk_delivery(ref,0,attempt,token,'message',601,2); EXCEPTION WHEN others THEN IF SQLERRM<>'voucher unavailable' THEN RAISE; END IF; rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'delivery counter overflow accepted'; END IF;
  IF (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>'prepared'
     OR (SELECT telegram_message_id FROM public.voucher_batch_chunk_attempts WHERE id=attempt) IS NOT NULL
     OR (SELECT status FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt)<>'prepared'
     OR (SELECT delivered_quantity FROM public.voucher_batches WHERE batch_reference=ref)<>2
  THEN RAISE EXCEPTION 'delivery counter failure was not atomic'; END IF;
END $$;

DO $$
DECLARE actor uuid; ref text := 'VB-LC0000000007'; claim jsonb; attempt uuid; token uuid; items jsonb; rejected boolean := false;
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key) VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
  claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
  items:=jsonb_build_array(jsonb_build_object('code_hash',md5('lc7-a')||md5('lc7-a'),'code_hint','G001'),jsonb_build_object('code_hash',md5('lc7-b')||md5('lc7-b'),'code_hint','G002'));
  PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
  PERFORM public.record_voucher_admin_chunk_delivery(ref,0,attempt,token,'message',701,2);
  UPDATE public.voucher_batches SET finalized_quantity=2 WHERE batch_reference=ref;
  BEGIN PERFORM public.finalize_voucher_admin_batch_chunk(ref,0,attempt,token); EXCEPTION WHEN others THEN IF SQLERRM<>'voucher unavailable' THEN RAISE; END IF; rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'finalize counter overflow accepted'; END IF;
  IF (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>'delivered'
     OR (SELECT status FROM public.voucher_batch_chunks WHERE current_attempt_id=attempt)<>'delivered'
     OR (SELECT finalized_quantity FROM public.voucher_batches WHERE batch_reference=ref)<>2
     OR (SELECT progress_cursor FROM public.voucher_batches WHERE batch_reference=ref)<>0
     OR (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=attempt AND active=true)<>0
     OR (SELECT count(*) FROM public.subscription_vouchers WHERE attempt_id=attempt AND active=false AND delivery_pending=true)<>2
  THEN RAISE EXCEPTION 'finalize counter failure was not atomic'; END IF;
END $$;
